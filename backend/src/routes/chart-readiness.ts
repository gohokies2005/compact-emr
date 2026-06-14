import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import {
  classifyReadAttempt,
  isEffectivelyRead,
  nonWhitespaceCharCount,
  reconcileChartReadiness,
  MANUAL_SUMMARY_MIN_LEN,
} from '../services/chart-readiness.js';
import {
  parseManualSummary,
  parseReadAttempt,
} from '../services/file-read-validation.js';
import { computeTriggerHash, deriveChartBuildState, isScreeningSummaryKey, runMatchesHash } from '../services/chart-build-state.js';
import { computeExtractionCoverage, type CoverageDocInput } from '../services/extraction-coverage.js';
import { AUTO_REMEDIATE_ACTION } from '../services/chart-auto-remediate.js';
import type { AppDb, FileReadAttempt, FileReadStatusRecord } from '../services/db-types.js';

// The s3Key is minted `cases/<caseId>/<uuid>-<OriginalName.ext>` (documents presign). Recover the
// human filename for queue rows: basename minus the leading uuid- prefix (a 36-char GUID wrapping
// across three lines tells an RN nothing). Falls back to the basename (or the whole path) on
// legacy/odd keys — never throws. Mirrors the frontend lib/documentFileName helper.
function originalFileName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
}

// Candidate statuses for the pending queues: a stored 'read' row is ALWAYS effectively read, so
// only the other two can possibly need RN attention (provided-with-invalid-summary still queues —
// defense-in-depth parity with evaluateChartReadiness).
const PENDING_CANDIDATE_STATUSES = ['manual_summary_required', 'manual_summary_provided'] as const;

export function createChartReadinessRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/cases/:id/files/read-attempts
   *
   * The OCR worker calls this after every read attempt. Server-side classifyReadAttempt
   * decides whether the attempt succeeded; the row's terminalStatus flips to 'read' on
   * success, otherwise stays 'manual_summary_required' until either a new (successful)
   * attempt arrives or an RN posts a manual summary.
   *
   * Role gate: admin + ops_staff. The worker calls as an ops_staff service principal.
   *
   * Upsert keyed on (caseId, filePath). Re-running the worker on the same file appends to
   * attemptsJson rather than replacing — preserves the audit trail of "we tried 3 methods,
   * none worked, RN took it from here."
   */
  router.post(
    '/cases/:id/files/read-attempts',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);
      const parsed = parseReadAttempt(req.body);

      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const outcome = classifyReadAttempt({ method: parsed.method, extractedText: parsed.extractedText, pageCount: parsed.documentPageCount });
      const newAttempt: FileReadAttempt = {
        method: parsed.method,
        wordCount: outcome.wordCount,
        charCount: nonWhitespaceCharCount(parsed.extractedText),
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        pageCount: parsed.documentPageCount,
        attemptedAt: new Date().toISOString(),
        note: outcome.reason ?? parsed.note,
      };

      const upserted = await db.$transaction(async (tx) => {
        const existing = await tx.fileReadStatus.findFirst({ where: { caseId, filePath: parsed.filePath } });
        const priorAttempts: readonly FileReadAttempt[] = existing?.attemptsJson ?? [];
        const attempts: readonly FileReadAttempt[] = [...priorAttempts, newAttempt];

        // Terminal-status decision:
        //   succeeded                 -> 'read'
        //   auto-skip (empty/invalid) -> 'auto_skipped' (NON-BLOCKING; no RN action) — but NEVER
        //                                downgrade an existing RN-cleared 'manual_summary_provided'.
        //   not succeeded + existing is manual_summary_provided -> keep 'manual_summary_provided'
        //   not succeeded + otherwise -> 'manual_summary_required' (HALT until RN intervenes)
        // auto_skipped is checked before the manual fallthrough so a genuinely empty file self-heals
        // (document auto-recovery loop, 2026-06-14); a substantive sliver / garbled read has
        // autoSkip=false and still lands on manual_summary_required (never silently drop a real record).
        const terminalStatus = outcome.succeeded
          ? 'read'
          : existing?.terminalStatus === 'manual_summary_provided'
            ? 'manual_summary_provided'
            : outcome.autoSkip === true
              ? 'auto_skipped'
              : 'manual_summary_required';

        const row = existing
          ? await tx.fileReadStatus.update({
              where: { id: existing.id },
              data: {
                fileSha256: parsed.fileSha256,
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: new Date(),
                version: { increment: 1 },
              },
            })
          : await tx.fileReadStatus.create({
              data: {
                caseId,
                filePath: parsed.filePath,
                fileSha256: parsed.fileSha256,
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: new Date(),
              },
            });

        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: outcome.succeeded ? 'file_read_succeeded' : 'file_read_failed',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: {
              caseId,
              fileReadStatusId: row.id,
              filePath: parsed.filePath,
              method: parsed.method,
              succeeded: outcome.succeeded,
              wordCount: outcome.wordCount,
              corruptedTokenRatio: outcome.corruptedTokenRatio,
            },
          },
        });

        // FAIL-LOUD (FIX 5, 2026-06-14): one structured CloudWatch line per classification on this
        // producer path so a parking decision (manual_summary_required) is visible outside the RN UI —
        // a future false-garble pile-up surfaces in logs / a metric-filter alarm instead of silently.
        console.log(JSON.stringify({
          msg: 'read_classified',
          caseId,
          filePath: parsed.filePath,
          method: parsed.method,
          terminalStatus,
          reason: outcome.reason,
          ratio: outcome.corruptedTokenRatio,
          chars: newAttempt.charCount,
          words: outcome.wordCount,
        }));

        return row;
      });

      res.status(201).json({ data: upserted });
    }),
  );

  /**
   * GET /api/v1/cases/:id/chart-readiness
   *
   * THE GATE. Every downstream consumer (viability, sign-off, draft worker) checks this
   * before proceeding. `ready: false` halts everything until an RN provides a manual
   * summary for each blocking file.
   *
   * No skip flag. No admin override. The body is informational only — auth-gated reads.
   */
  router.get(
    '/cases/:id/chart-readiness',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.fileReadStatus.findMany({ where: { caseId } });
      // Readiness and the chart's document list are separate tables with no FK — an orphaned readiness row
      // (a deleted/legacy file) would block drafting INVISIBLY (the chart can't even show it; Yorde 2026-06-07).
      // Reconcile: only block on a file the chart actually has, or a generated intake summary. Self-healing.
      // Also select the Document id so each blocking file can carry its documentId — the UI renders
      // the filename as a clickable link (presigned view) only when it has a document to open.
      // (DocumentRecord in db-types is the minimal {s3Key} view; the id is selected + cast here.)
      const docs = (await db.document.findMany({ where: { caseId }, select: { id: true, s3Key: true } })) as readonly { id?: string; s3Key: string }[];
      // Reconcile through the SHARED predicate so this route and every gate site (sign-off, approve,
      // finalize, draft) can never disagree on which rows are orphans (CLM-4DACAF4A80, 2026-06-14).
      const result = reconcileChartReadiness(rows, docs);
      const docIdByKey = new Map(docs.filter((d): d is { id: string; s3Key: string } => typeof d.id === 'string').map((d) => [d.s3Key, d.id]));
      const blockingFiles = result.blockingFiles.map((b) => ({ ...b, documentId: docIdByKey.get(b.filePath) ?? null }));

      // Extraction phase (full-read chunker takes minutes). File-read `ready` flips true the moment
      // OCR finishes — but the chart's sc_conditions/meds aren't populated until EXTRACTION completes,
      // and the pre-draft gates (Gate-2 dx / framing / viability) read that extracted chart. So the
      // draft button must wait for extractionState==='chart_ready', not just OCR. (Ryan 2026-06-13.)
      // Recent runs, newest first (sticky-completion fix, Ewell CLM-A867B8C128, 2026-06-14): a
      // DUPLICATE run enqueued AFTER a successful extraction (then swept to 'failed' by the stuck-run
      // watcher) was un-readying an already-extracted chart when we keyed only on the latest run. Pass
      // ALL recent runs so a completed run for the current doc set stays sticky.
      const recentRuns = await (db as unknown as {
        chartExtractionRun: { findMany: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; take: number; select: { triggerHash: true; status: true; resultJson: true } }) => Promise<{ triggerHash: string; status: string; resultJson: unknown }[]> };
      }).chartExtractionRun.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' }, take: 10, select: { triggerHash: true, status: true, resultJson: true } });
      const build = deriveChartBuildState(
        docs.map((d) => ({ id: d.id ?? '', s3Key: d.s3Key })),
        rows.map((r) => ({ filePath: r.filePath, terminalStatus: r.terminalStatus })),
        recentRuns.map((r) => ({ triggerHash: r.triggerHash, status: r.status })),
      );
      // Surface extraction gaps (audit 2026-06-13): complete_with_gaps opens the draft door (a 3-page gap
      // on a 2,000-page bundle shouldn't block) but the RN sees a banner. Pull the worker-recorded counts.
      // CRITICAL (Ewell 2026-06-14): read gaps from the COMPLETED run that made the chart ready — NOT the
      // latest run, which may be the swept duplicate carrying no resultJson. Find the most-recent run
      // matching the current doc set whose status is complete/complete_with_gaps (recentRuns is desc).
      const completedMatchingRun = recentRuns.find(
        (r) => runMatchesHash(r.triggerHash, build.currentHash) && (r.status === 'complete' || r.status === 'complete_with_gaps'),
      );
      const rj = completedMatchingRun?.resultJson as { gaps?: { truncatedWindows?: number; uncoveredPages?: number } } | null | undefined;
      const extractionGaps = (completedMatchingRun?.status === 'complete_with_gaps' && rj?.gaps)
        ? { truncatedWindows: Number(rj.gaps.truncatedWindows ?? 0), uncoveredPages: Number(rj.gaps.uncoveredPages ?? 0) }
        : null;

      // AUTO-RECOVERY EXHAUSTION (document auto-recovery loop FIX 3, 2026-06-14). The last-resort
      // ChartRecoveryBanner must appear ONLY once auto-recovery has actually given up — NOT during a
      // normal preparing/extracting cycle (showing it then papered over the auto-resume stall). The
      // bounded auto-remediate writes a `case_auto_remediated` activity marker keyed on the doc-set
      // triggerHash; "exhausted" = the chart is SETTLED (not building) AND still has real blockers AND
      // a marker exists for the CURRENT doc-set (re-reading the same files already failed). A new upload
      // changes the triggerHash so a genuinely-changed chart is NOT mistaken for exhausted. Computed
      // only when there are blockers + the chart has settled (cheap short-circuit; no marker query
      // during a build). The same (caseId, triggerHash) marker the /draft route checks — single source.
      const settled = build.state !== 'extracting' && build.state !== 'ocr_in_progress';
      let autoRecoveryExhausted = false;
      if (!result.ready && settled && result.blockingFiles.length > 0) {
        const buildDocs = docs
          .filter((d) => !isScreeningSummaryKey(d.s3Key))
          .map((d) => ({ id: d.id ?? '', s3Key: d.s3Key }));
        const currentHash = computeTriggerHash(buildDocs, rows.map((r) => ({ filePath: r.filePath, terminalStatus: r.terminalStatus })));
        const markers = await (db as unknown as {
          activityLog: { findMany: (a: { where: { caseId: string; action: string } }) => Promise<{ detailsJson?: { triggerHash?: unknown } | null }[]> };
        }).activityLog.findMany({ where: { caseId, action: AUTO_REMEDIATE_ACTION } });
        autoRecoveryExhausted = markers.some((m) => {
          const h = m.detailsJson && typeof m.detailsJson === 'object' ? (m.detailsJson as { triggerHash?: unknown }).triggerHash : undefined;
          return typeof h === 'string' && runMatchesHash(h, currentHash);
        });
      }

      res.json({ data: { ...result, blockingFiles, extractionState: build.state, extractionGaps, autoRecoveryExhausted } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/files-pending-manual
   *
   * Convenience list for the RN UI — the rows that actually need a manual summary.
   *
   * Package 1 (H), 2026-06-11: derives the list through the SAME evaluator semantics as
   * GET /chart-readiness (shared isEffectivelyRead: retro-heal + intake-summary + summary
   * validity) plus the same liveKeys reconcile, instead of a raw terminalStatus read — a
   * healed/reconciled/orphaned file NEVER appears in the queue. Rows carry documentId (the
   * matching chart Document, for the clickable presigned view) + fileName (the human filename).
   */
  router.get(
    '/cases/:id/files-pending-manual',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.fileReadStatus.findMany({
        where: { caseId, terminalStatus: { in: PENDING_CANDIDATE_STATUSES } },
        orderBy: { lastCheckedAt: 'desc' },
      });
      const docs = (await db.document.findMany({ where: { caseId }, select: { id: true, s3Key: true } })) as readonly { id?: string; s3Key: string }[];
      const liveKeys = new Set(docs.map((d) => d.s3Key));
      const docIdByKey = new Map(docs.filter((d): d is { id: string; s3Key: string } => typeof d.id === 'string').map((d) => [d.s3Key, d.id]));
      const pending = rows.filter((r) => liveKeys.has(r.filePath) && !isEffectivelyRead(r));
      res.json({
        data: pending.map((r) => ({
          ...r,
          documentId: docIdByKey.get(r.filePath) ?? null,
          fileName: originalFileName(r.filePath),
        })),
      });
    }),
  );

  /**
   * GET /api/v1/cases/:id/extraction-coverage
   *
   * TRANSPARENCY report (Ryan 2026-06-14): "95% of pages successfully extracted" + a specific,
   * hyperlinked list of what was NOT extracted (file + page + reason). ADVISORY — never blocks.
   *
   * Assembles existing data; re-extracts nothing. Mirrors the GET /chart-readiness auth + data loads:
   *   • Document rows (id, s3Key, filename, contentType, pageCount) = the chart-page universe.
   *   • file_read_status rows = the per-file read outcome, judged through the SHARED isEffectivelyRead
   *     predicate inside computeExtractionCoverage (no divergent readiness read).
   *   • the latest ChartExtractionRun (status + resultJson.gaps) = the EXTRACTION-phase gaps.
   *
   * Each file-level gap carries documentId (joined on s3Key the same way /chart-readiness joins
   * blockingFiles) so the frontend can open a presigned inline view. Run-level gaps carry null.
   */
  router.get(
    '/cases/:id/extraction-coverage',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      // Same select shape the coverage service consumes (id for the presigned view join; filename +
      // contentType for the image/AI-describe affordance; pageCount for honest page totals). Cast like
      // the chart-readiness route does — DocumentRecord in db-types is the minimal {s3Key} view.
      const docs = (await db.document.findMany({
        where: { caseId },
        select: { id: true, s3Key: true, filename: true, contentType: true, pageCount: true },
      })) as readonly CoverageDocInput[];
      const rows = await db.fileReadStatus.findMany({ where: { caseId } });
      const latestRun = await (db as unknown as {
        chartExtractionRun: { findFirst: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { status: true; resultJson: true } }) => Promise<{ status: string; resultJson: unknown } | null> };
      }).chartExtractionRun.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { status: true, resultJson: true } });

      const coverage = computeExtractionCoverage(docs, rows, latestRun);
      res.json({ data: coverage });
    }),
  );

  /**
   * GET /api/v1/rn/files-pending-manual
   *
   * Phase 7B-revised Build 2: cross-case queue for the RN, oldest first (FIFO — files waiting
   * longest get RN attention first). Optionally accepts a `?limit=N` query (default 50,
   * max 200) so the queue stays bounded.
   *
   * Package 1 (H)+(J), 2026-06-11: same evaluator-derived filtering as the per-case route above
   * (shared isEffectivelyRead + liveKeys reconcile — the raw terminalStatus read made 15/16 queue
   * rows false positives), and each surviving row is ENRICHED with veteranName + claimedCondition
   * (Case → veteran join) + documentId + fileName so the RN queue shows WHO and WHAT, with a
   * clickable presigned view. Joins are batched findMany({ id: { in } }) — never per-row.
   * `total` = the post-filter count (drives the HomePage badge — the honest queue depth).
   */
  router.get(
    '/rn/files-pending-manual',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const limitRaw = req.query['limit'];
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      }
      const rows = await db.fileReadStatus.findMany({
        where: { terminalStatus: { in: PENDING_CANDIDATE_STATUSES } },
        orderBy: { lastCheckedAt: 'asc' },
      });
      const candidates = rows.filter((r) => !isEffectivelyRead(r));

      // liveKeys reconcile across the candidate cases (one batched query): an orphaned readiness
      // row (deleted file) must never queue — GET /chart-readiness already drops these.
      const candidateCaseIds = [...new Set(candidates.map((r) => r.caseId))];
      const docs = candidateCaseIds.length === 0
        ? []
        : ((await db.document.findMany({
            where: { caseId: { in: candidateCaseIds } },
            select: { id: true, s3Key: true },
          })) as readonly { id?: string; s3Key: string }[]);
      const liveKeys = new Set(docs.map((d) => d.s3Key));
      const docIdByKey = new Map(docs.filter((d): d is { id: string; s3Key: string } => typeof d.id === 'string').map((d) => [d.s3Key, d.id]));
      const pending = candidates.filter((r) => liveKeys.has(r.filePath));

      // Enrich only the returned page (one batched Case→veteran query for the sliced rows).
      const page: readonly FileReadStatusRecord[] = pending.slice(0, limit);
      const pageCaseIds = [...new Set(page.map((r) => r.caseId))];
      const cases = pageCaseIds.length === 0
        ? []
        : ((await db.case.findMany({
            where: { id: { in: pageCaseIds } },
            select: { id: true, claimedCondition: true, veteran: { select: { firstName: true, lastName: true } } },
          })) as unknown as readonly { id: string; claimedCondition: string | null; veteran?: { firstName: string; lastName: string } | null }[]);
      const caseById = new Map(cases.map((c) => [c.id, c]));

      const data = page.map((r) => {
        const c = caseById.get(r.caseId);
        return {
          ...r,
          veteranName: c?.veteran ? `${c.veteran.lastName}, ${c.veteran.firstName}` : null,
          claimedCondition: c?.claimedCondition ?? null,
          documentId: docIdByKey.get(r.filePath) ?? null,
          fileName: originalFileName(r.filePath),
        };
      });
      res.json({ data, total: pending.length });
    }),
  );

  /**
   * POST /api/v1/cases/:id/files/:fileReadStatusId/manual-summary
   *
   * RN-facing endpoint to clear a blocking file. The summary MUST be >= 40 chars (FRN HARD
   * RULE — manual interpretation must convey actual content; one-word summaries are not a
   * release valve). Flips terminalStatus to 'manual_summary_provided', stamps the resolver
   * + timestamp, writes an activity row.
   *
   * Role gate: admin + ops_staff for now. When the 'rn' role lands, this opens to RN.
   */
  router.post(
    '/cases/:id/files/:fileReadStatusId/manual-summary',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);
      const fileReadStatusId = String(req.params.fileReadStatusId);
      const parsed = parseManualSummary(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.fileReadStatus.findFirst({ where: { id: fileReadStatusId, caseId } });
        if (existing === null) {
          throw new HttpError(404, 'not_found', 'file_read_status row not found for this case', { caseId, fileReadStatusId });
        }
        if (existing.terminalStatus === 'read') {
          throw new HttpError(409, 'conflict', 'File was successfully read by a machine; no manual summary required.', {
            caseId,
            fileReadStatusId,
            currentStatus: existing.terminalStatus,
          });
        }

        const row = await tx.fileReadStatus.update({
          where: { id: fileReadStatusId },
          data: {
            terminalStatus: 'manual_summary_provided',
            manualSummary: parsed.summary,
            manualSummaryAt: new Date(),
            manualSummaryBy: actor.sub,
            lastCheckedAt: new Date(),
            version: { increment: 1 },
          },
        });

        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'file_manual_summary_provided',
            caseId,
            detailsJson: {
              caseId,
              fileReadStatusId,
              filePath: existing.filePath,
              summaryLength: parsed.summary.length,
              minRequired: MANUAL_SUMMARY_MIN_LEN,
            },
          },
        });

        return row;
      });

      res.json({ data: updated });
    }),
  );

  return router;
}
