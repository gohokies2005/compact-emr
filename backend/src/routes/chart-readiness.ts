import { createHash } from 'node:crypto';
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
import { maybeEnqueueChartExtract } from '../services/chart-extract-trigger.js';
import { loadExtractionCoverageForCase } from '../services/extraction-coverage.js';
import { buildSanityImpression, type SanityContext } from '../services/sanity-impression.js';
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

      // POSITIVE "this document is provably read" set, for the reprocess modal's cost-safe default
      // (Ryan 2026-06-17 + architect SB-1). Derived from the SAME isEffectivelyRead predicate the gates
      // use, so the UI can't disagree. A doc with NO read-status row (mid-OCR, never read, cleared) is
      // ABSENT here → the modal treats it as needs-reading and default-CHECKS it. Fail-safe direction:
      // unknown ⇒ needs reading (never silently skip an unread file); the re-spend confirm still guards
      // re-reading a doc that IS in this set. blockingFiles (row-sourced) is blind to no-row docs, so a
      // positive read-set is the only safe basis for "already read".
      const rowByKey = new Map(rows.map((r) => [r.filePath, r]));
      const readDocumentIds = docs
        .filter((d): d is { id: string; s3Key: string } => typeof d.id === 'string')
        .filter((d) => { const r = rowByKey.get(d.s3Key); return r !== undefined && isEffectivelyRead(r); })
        .map((d) => d.id);

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
      // SELF-HEAL the hash-drift wedge (Dick CLM-29FCC3F1AB / Mittge CLM-E13B746273, 2026-06-26).
      // deriveChartBuildState returns 'extracting' as a DEAD-END (chart-build-state.ts:168) when all
      // docs are OCR-terminal but NO extraction run matches the CURRENT trigger hash — e.g. a duplicate
      // Intake_Summary.pdf drifted the hash AFTER the prior run completed. Nothing re-enqueues, so the
      // Send-to-Drafter gate spins forever (Ryan: "stuck 15-20 min, cannot draft at this rate"). When we
      // detect that exact state, fire maybeEnqueueChartExtract (its own rate-guard makes this idempotent)
      // so the gate converges itself, and log LOUD as `chart_build_stalled` so a CloudWatch metric-filter
      // alarm can catch a stall the stuck-run watcher is blind to (it only sees runs that EXIST).
      if (build.state === 'extracting' && build.currentHash
          && !recentRuns.some((r) => runMatchesHash(r.triggerHash, build.currentHash))) {
        console.warn(`[chart_build_stalled] case ${caseId} is 'extracting' with NO run matching current hash ${build.currentHash.slice(0, 12)} (hash-drift wedge) — auto-enqueuing extraction to self-heal.`);
        try {
          const enq = await maybeEnqueueChartExtract(db as Parameters<typeof maybeEnqueueChartExtract>[0], caseId);
          console.warn(`[chart_build_stalled] case ${caseId} self-heal enqueue: enqueued=${enq.enqueued}${enq.reason ? ` reason=${enq.reason}` : ''}`);
        } catch (healErr) {
          console.error(`[chart_build_stalled] case ${caseId} self-heal enqueue FAILED: ${healErr instanceof Error ? healErr.message : String(healErr)}`);
        }
      }
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

      res.json({ data: { ...result, blockingFiles, readDocumentIds, extractionState: build.state, extractionGaps, autoRecoveryExhausted } });
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
      // ONE shared loader (Ryan 2026-06-22, Zimmelman FIX C): the SOAP assembler's coverage note and this
      // transparency route MUST report the same %; they drifted (the assembler passed empty read-statuses
      // → false "0%"). loadExtractionCoverageForCase assembles the canonical inputs (Document rows judged
      // through the SHARED isEffectivelyRead predicate, the latest ChartExtractionRun gaps, and per-page
      // provenance) so both callers compute identical coverage and can never diverge again.
      const coverage = await loadExtractionCoverageForCase(db, caseId);
      res.json({ data: coverage });
    }),
  );

  /**
   * POST /api/v1/cases/:id/sanity-impression
   *
   * The auto-fired "overall impression" gut-check (Ryan 2026-06-16) — recreates the holistic
   * "does this make sense, did we miss anything, were the records really checked?" review. The client
   * passes the context it ALREADY assembled for the Overview (claimed condition, chosen theory, SC
   * conditions, a one-line coverage note, and POST-DRAFT the draft text + grade); the server runs the
   * Opus check and returns the impression, or null (fail-open — never blocks). admin/ops_staff/physician.
   *
   * RETIREMENT NOTE (2026-06-25, Ryan, items #68/#72 — one-brain): the PRE-DRAFT "AI Sanity Check" was a
   * SECOND LLM brain that re-derived the theory independently and could contradict the route-picker plan
   * (the Wickel "tinnitus note" divergence). It is RETIRED. The UI callers no longer assemble or read a
   * pre_draft impression, and THIS ROUTE now hard-refuses stage='pre_draft' at the seam (returns the
   * fail-open {data:null} WITHOUT calling buildSanityImpression) so no pre-draft Opus call can fire even
   * from a stale client. buildSanityImpression + the sanity-impression service/table are LEFT IN PLACE so
   * the change is reversible without touching the DB/migrations. The POST-draft check (a read of the
   * FINISHED letter, not a pre-draft theory re-derivation) still calls this with stage='post_draft'.
   *
   * Accepting client-assembled context is intentional: this is an internal staff tool with no security
   * boundary on these fields (the same data the client already renders), and it avoids re-plumbing five
   * data sources server-side. The server CAPS every field so a runaway input can't blow the token cost.
   */
  router.post(
    '/cases/:id/sanity-impression',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown, cap: number): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, cap) : null);
      const claimedCondition = str(b['claimedCondition'], 200);
      if (claimedCondition === null) { res.json({ data: null }); return; } // nothing to judge → no spend
      // ONE-BRAIN SEAM GUARD (Ryan #68/#72, 2026-06-25): the PRE-DRAFT sanity-impression is a retired
      // second brain. Refuse it here so no pre_draft Opus call can fire even from a stale client/cache —
      // return the fail-open contract ({data:null}) WITHOUT calling buildSanityImpression. POST-draft (a
      // check on the finished letter) is unaffected.
      if (b['stage'] !== 'post_draft') { res.json({ data: null }); return; }
      const arr = (v: unknown, n: number, cap: number): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((s) => s.slice(0, cap)) : [];

      const ctx: SanityContext = {
        stage: b['stage'] === 'post_draft' ? 'post_draft' : 'pre_draft',
        claimedCondition,
        veteranTheory: str(b['veteranTheory'], 2_000), // the veteran's own goal — paragraph allowed
        theory: str(b['theory'], 400),
        scConditions: arr(b['scConditions'], 30, 120),
        keyFacts: arr(b['keyFacts'], 20, 240),
        coverageNote: str(b['coverageNote'], 300),
        draftText: str(b['draftText'], 20_000),
        grade: str(b['grade'], 200),
      };
      // COST-SAFETY (2026-06-18 audit): cache the Opus result per (case, stage) keyed by an input hash.
      // The client auto-fires this on every Overview mount; without this, an identical re-fire (same
      // inputs, same stage — a reload/navigation/poll) re-spent on Opus every time. An exact-hash hit
      // returns the cached impression for $0; the Opus call runs ONLY when the hashed inputs change.
      const inputHash = createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
      const sanityDb = db as unknown as {
        sanityImpression: {
          findUnique: (a: { where: { caseId_stage: { caseId: string; stage: string } } }) => Promise<{ inputHash: string; resultJson: unknown } | null>;
          upsert: (a: { where: { caseId_stage: { caseId: string; stage: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
        };
      };
      let cached: { inputHash: string; resultJson: unknown } | null;
      try { cached = await sanityDb.sanityImpression.findUnique({ where: { caseId_stage: { caseId, stage: ctx.stage } } }); } catch { cached = null; /* fail-open: a cache miss/error must never block */ }
      if (cached !== null && cached.inputHash === inputHash && cached.resultJson !== null && cached.resultJson !== undefined) {
        res.json({ data: cached.resultJson });
        return;
      }

      const impression = await buildSanityImpression(ctx);
      // Best-effort cache write — NEVER block or fail the response on a cache error.
      try {
        await sanityDb.sanityImpression.upsert({
          where: { caseId_stage: { caseId, stage: ctx.stage } },
          create: { caseId, stage: ctx.stage, inputHash, resultJson: (impression ?? null) as object | null },
          update: { inputHash, resultJson: (impression ?? null) as object | null },
        });
      } catch { /* best-effort */ }
      res.json({ data: impression });
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
