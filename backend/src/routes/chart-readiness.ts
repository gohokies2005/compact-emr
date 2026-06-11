import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import {
  classifyReadAttempt,
  evaluateChartReadiness,
  isEffectivelyRead,
  isIntakeSummaryPath,
  MANUAL_SUMMARY_MIN_LEN,
} from '../services/chart-readiness.js';
import {
  parseManualSummary,
  parseReadAttempt,
} from '../services/file-read-validation.js';
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

      const outcome = classifyReadAttempt({ method: parsed.method, extractedText: parsed.extractedText });
      const newAttempt: FileReadAttempt = {
        method: parsed.method,
        wordCount: outcome.wordCount,
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        attemptedAt: new Date().toISOString(),
        note: outcome.reason ?? parsed.note,
      };

      const upserted = await db.$transaction(async (tx) => {
        const existing = await tx.fileReadStatus.findFirst({ where: { caseId, filePath: parsed.filePath } });
        const priorAttempts: readonly FileReadAttempt[] = existing?.attemptsJson ?? [];
        const attempts: readonly FileReadAttempt[] = [...priorAttempts, newAttempt];

        // Terminal-status decision:
        //   succeeded                 -> 'read'
        //   not succeeded + existing is manual_summary_provided -> keep 'manual_summary_provided'
        //   not succeeded + otherwise -> 'manual_summary_required' (HALT until RN intervenes)
        const terminalStatus = outcome.succeeded
          ? 'read'
          : existing?.terminalStatus === 'manual_summary_provided'
            ? 'manual_summary_provided'
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
      const liveKeys = new Set(docs.map((d) => d.s3Key));
      const reconciled = rows.filter((r) => liveKeys.has(r.filePath) || isIntakeSummaryPath(r.filePath));
      const result = evaluateChartReadiness(reconciled);
      const docIdByKey = new Map(docs.filter((d): d is { id: string; s3Key: string } => typeof d.id === 'string').map((d) => [d.s3Key, d.id]));
      const blockingFiles = result.blockingFiles.map((b) => ({ ...b, documentId: docIdByKey.get(b.filePath) ?? null }));
      res.json({ data: { ...result, blockingFiles } });
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
