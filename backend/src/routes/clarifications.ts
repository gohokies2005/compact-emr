import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { parseClarificationCreate, parseClarificationResolve } from '../services/clarification-validation.js';
import { currentActor } from '../services/request-actor.js';
import { isAssignedPhysicianForCase } from '../services/physician-resolver.js';
import type { AppDb, ClarificationStatus } from '../services/db-types.js';

function parseStatusFilter(value: unknown): ClarificationStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'open' || value === 'resolved' || value === 'dismissed') return value;
  return undefined;
}

/**
 * Phase 5.1: physician access gate. Mirrors the assigned-physician contract used by every
 * other case-scoped endpoint. Without this, a physician can resolve clarifications against
 * cases they were never assigned to (architect QA REVIEW.md ¶4 finding 3).
 */
async function assertPhysicianAssignedToCase(db: AppDb, caseId: string, sub: string): Promise<void> {
  const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, assignedPhysicianId: true } });
  if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
  const ok = await isAssignedPhysicianForCase(db, sub, c.assignedPhysicianId);
  if (!ok) throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
}

export function createClarificationsRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/cases/:id/clarifications
   *
   * Raise a clarification question against a case. The question is targeted at one of three
   * audiences (physician / ops_staff / veteran) — surfacing in the appropriate UI list.
   * Anyone on staff can raise; resolution is a separate call.
   */
  router.post(
    '/cases/:id/clarifications',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);
      const parsed = parseClarificationCreate(req.body);

      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true, assignedPhysicianId: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      if (actor.role === 'physician') {
        const ok = await isAssignedPhysicianForCase(db, actor.sub, c.assignedPhysicianId);
        if (!ok) throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
      }

      const created = await db.$transaction(async (tx) => {
        const row = await tx.clarification.create({
          data: {
            caseId,
            raisedBy: actor.sub,
            audience: parsed.audience,
            question: parsed.question,
            status: 'open',
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'clarification_raised',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: { caseId, clarificationId: row.id, audience: parsed.audience },
          },
        });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  /**
   * GET /api/v1/cases/:id/clarifications?status=open|resolved|dismissed
   *
   * List clarifications for a case. Optional status filter; default returns all, newest first.
   */
  router.get(
    '/cases/:id/clarifications',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);
      if (actor.role === 'physician') {
        await assertPhysicianAssignedToCase(db, caseId, actor.sub);
      }
      const status = parseStatusFilter(req.query['status']);
      const where: Record<string, unknown> = { caseId };
      if (status !== undefined) where['status'] = status;
      const rows = await db.clarification.findMany({ where, orderBy: { createdAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  /**
   * PATCH /api/v1/clarifications/:id/resolve
   *
   * Resolve or dismiss a clarification. Captures who resolved + when + a free-text resolution.
   */
  router.patch(
    '/clarifications/:id/resolve',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const id = String(req.params.id);
      const parsed = parseClarificationResolve(req.body);

      const existing = await db.clarification.findUnique({ where: { id } });
      if (existing === null) throw new HttpError(404, 'not_found', 'Clarification not found', { clarificationId: id });
      if (actor.role === 'physician') {
        await assertPhysicianAssignedToCase(db, existing.caseId, actor.sub);
      }
      if (existing.status !== 'open') {
        throw new HttpError(409, 'conflict', 'Clarification already resolved or dismissed.', {
          clarificationId: id,
          currentStatus: existing.status,
        });
      }

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.clarification.update({
          where: { id },
          data: {
            status: parsed.status,
            resolution: parsed.resolution,
            resolvedBy: actor.sub,
            resolvedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'clarification_resolved',
            caseId: existing.caseId,
            detailsJson: { caseId: existing.caseId, clarificationId: id, status: parsed.status },
          },
        });
        return row;
      });

      res.json({ data: updated });
    }),
  );

  return router;
}
