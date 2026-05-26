import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import {
  classifyReadAttempt,
  evaluateChartReadiness,
  MANUAL_SUMMARY_MIN_LEN,
} from '../services/chart-readiness.js';
import {
  parseManualSummary,
  parseReadAttempt,
} from '../services/file-read-validation.js';
import type { AppDb, FileReadAttempt } from '../services/db-types.js';

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
      const result = evaluateChartReadiness(rows);
      res.json({ data: result });
    }),
  );

  /**
   * GET /api/v1/cases/:id/files-pending-manual
   *
   * Convenience list for the RN UI — only the rows in 'manual_summary_required'.
   */
  router.get(
    '/cases/:id/files-pending-manual',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.fileReadStatus.findMany({
        where: { caseId, terminalStatus: 'manual_summary_required' },
        orderBy: { lastCheckedAt: 'desc' },
      });
      res.json({ data: rows });
    }),
  );

  /**
   * GET /api/v1/rn/files-pending-manual
   *
   * Phase 7B-revised Build 2: cross-case queue for the RN. Returns all FileReadStatus rows in
   * 'manual_summary_required' state across every case, oldest first (FIFO — files waiting
   * longest get RN attention first). Optionally accepts a `?limit=N` query (default 50,
   * max 200) so the queue stays bounded.
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
        where: { terminalStatus: 'manual_summary_required' },
        orderBy: { lastCheckedAt: 'asc' },
      });
      res.json({ data: rows.slice(0, limit), total: rows.length });
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
