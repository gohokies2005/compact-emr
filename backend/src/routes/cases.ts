import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, CaseStatus, Role } from '../services/db-types.js';
import {
  parseAssignPhysician,
  parseCaseCreate,
  parseCasePatch,
  parseStatusTransition,
} from '../services/case-validation.js';
import {
  canRolePerformCaseStatusTransition,
  isValidCaseStatusTransition,
  requiredRolesForCaseStatusTransition,
} from '../services/case-status-transitions.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';
import { currentActor, type RequestActor } from '../services/request-actor.js';

const CASE_LITE_SELECT = {
  id: true,
  veteranId: true,
  claimedCondition: true,
  claimType: true,
  status: true,
  version: true,
  currentVersion: true,
  assignedPhysicianId: true,
  refundEligible: true,
  createdAt: true,
  updatedAt: true,
  veteran: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  assignedPhysician: {
    select: {
      id: true,
      fullName: true,
      
      email: true,
    },
  },
};

/**
 * Phase 5.1: extracted to `services/request-actor.ts`. Local alias preserved so call sites
 * inside this file (`const user = currentUser(req)`) stay readable.
 */
const currentUser: (req: Request) => RequestActor = currentActor;

function parsePositiveQueryInt(value: unknown, defaultValue: number, maxValue: number): number {
  if (typeof value !== 'string') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseOptionalCaseStatus(value: unknown): CaseStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const statuses: readonly CaseStatus[] = [
    'intake',
    'records',
    'viability',
    'drafting',
    'physician_review',
    'correction_requested',
    'correction_review',
    'delivered',
    'paid',
    'rejected',
  ];
  if (!statuses.includes(value as CaseStatus)) {
    throw new HttpError(400, 'bad_request', 'status filter is invalid', { field: 'status' });
  }
  return value as CaseStatus;
}

function optionalStringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildCaseListWhere(query: Request['query']): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const status = parseOptionalCaseStatus(query.status);
  const claimType = optionalStringQuery(query.claimType);
  const veteranId = optionalStringQuery(query.veteranId);
  const assignedPhysicianId = optionalStringQuery(query.assignedPhysicianId);

  if (status !== undefined) where.status = status;
  if (claimType !== undefined) where.claimType = claimType;
  if (veteranId !== undefined) where.veteranId = veteranId;
  if (assignedPhysicianId !== undefined) where.assignedPhysicianId = assignedPhysicianId;

  return where;
}

/**
 * Allow access when the caller has one of `staffRoles` (admin / ops_staff)
 * OR is a physician resolving to the Physician row assigned to the URL case.
 *
 * Wired Phase 5 (2026-05-25): physicians get self-access to their assigned cases
 * for read/patch/draft-jobs/corrections. Status transitions stay under
 * `roleGuardForStatusTransition` which adds its own assigned-physician check.
 */
function requireStaffOrAssignedPhysician(db: AppDb, staffRoles: readonly Role[]) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if ((staffRoles as readonly Role[]).includes(user.role)) return next();
    if (user.role !== 'physician') {
      throw new HttpError(403, 'forbidden', 'This route is not available for your role.', {
        requiredRoles: [...staffRoles, 'physician (assigned)'],
      });
    }

    const id = String(req.params.id);
    const c = await db.case.findFirst({ where: { id }, select: { id: true, assignedPhysicianId: true } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

    const ok = await isAssignedPhysicianForCase(db, user.sub, c.assignedPhysicianId);
    if (!ok) {
      throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId: id });
    }

    next();
  });
}

function roleGuardForStatusTransition(db: AppDb) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const user = currentUser(req);
    const parsed = parseStatusTransition(req.body);

    const current = await db.case.findFirst({
      where: { id },
      select: { id: true, status: true, assignedPhysicianId: true },
    });
    if (current === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

    const allowed = canRolePerformCaseStatusTransition(user.role, current.status, parsed.to);
    if (!allowed) {
      throw new HttpError(403, 'forbidden', 'Role cannot perform this case status transition', {
        requiredRoles: requiredRolesForCaseStatusTransition(current.status, parsed.to),
      });
    }

    if (user.role === 'physician') {
      const isAssigned = await isAssignedPhysicianForCase(db, user.sub, current.assignedPhysicianId);
      if (!isAssigned) {
        throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId: id });
      }
    }

    next();
  });
}

export function createCasesRouter(db: AppDb): Router {
  const router = Router();


  router.get(
    '/cases',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const page = parsePositiveQueryInt(req.query.page, 1, 100000);
      const pageSize = parsePositiveQueryInt(req.query.pageSize, 25, 100);
      const skip = (page - 1) * pageSize;
      const where = buildCaseListWhere(req.query);

      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null) {
          // Physician account exists in Cognito but has no Physician row mapping yet.
          res.json({ data: [], page, pageSize, total: 0 });
          return;
        }
        where.assignedPhysicianId = physician.id;
      }

      const [total, cases] = await db.$transaction(async (tx) => {
        const count = await tx.case.count({ where });
        const rows = await tx.case.findMany({
          where,
          select: CASE_LITE_SELECT,
          orderBy: { updatedAt: 'desc' },
          skip,
          take: pageSize,
        });
        return [count, rows] as const;
      });

      res.json({ data: cases, page, pageSize, total });
    }),
  );

  router.get(
    '/cases/:id',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const found = await db.case.findFirst({
        where: { id },
        include: {
          veteran: { select: { id: true, firstName: true, lastName: true, email: true } },
          assignedPhysician: { select: { id: true, fullName: true, email: true } },
          documents: { orderBy: { createdAt: 'desc' }, take: 5 },
          draftJobs: { orderBy: { enqueuedAt: 'desc' }, take: 5 },
          corrections: { orderBy: { requestedAt: 'desc' }, take: 5 },
          emails: { orderBy: { sentAt: 'desc' }, take: 5 },
          payments: { orderBy: { createdAt: 'desc' } },
          _count: { select: { documents: true, draftJobs: true, corrections: true, emails: true, payments: true } },
        },
      });
      if (found === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
      res.json({ data: found });
    }),
  );

  router.post(
    '/veterans/:veteranId/cases',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const veteranId = String(req.params.veteranId);
      const parsed = parseCaseCreate(req.body);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.findUnique({ where: { id: veteranId }, select: { id: true } });
        if (veteran === null) throw new HttpError(404, 'not_found', 'Veteran not found', { veteranId });

        const row = await tx.case.create({
          data: {
            ...parsed,
            veteranId,
            status: 'intake',
          },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_created',
            caseId: row.id,
            veteranId,
            detailsJson: { caseId: row.id, veteranId, fields: ['id', 'claimedCondition', 'claimType'] },
          },
        });

        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.patch(
    '/cases/:id',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseCasePatch(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({ where: { id }, select: { id: true, veteranId: true, version: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case version is stale', {
            caseId: id,
            expectedVersion: existing.version,
            receivedVersion: parsed.version,
          });
        }

        const row = await tx.case.update({
          where: { id },
          data: { ...parsed.fields, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_updated',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, fields: parsed.changedFields },
          },
        });

        return row;
      });

      res.json({ data: updated });
    }),
  );

  router.delete(
    '/cases/:id',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);

      await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, status: true, version: true },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

        const row = await tx.case.update({
          where: { id },
          data: { status: 'rejected', version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_soft_deleted',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, previousStatus: existing.status },
          },
        });

        return row;
      });

      res.status(204).send();
    }),
  );

  router.post(
    '/cases/:id/status',
    roleGuardForStatusTransition(db),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseStatusTransition(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, status: true, version: true },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.status !== parsed.from || existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case status or version is stale', {
            caseId: id,
            currentStatus: existing.status,
            currentVersion: existing.version,
            receivedFrom: parsed.from,
            receivedVersion: parsed.version,
          });
        }
        if (!isValidCaseStatusTransition(parsed.from, parsed.to)) {
          throw new HttpError(400, 'bad_request', 'Invalid case status transition', {
            from: parsed.from,
            to: parsed.to,
          });
        }

        const row = await tx.case.update({
          where: { id },
          data: { status: parsed.to, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_status_changed',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: {
              caseId: id,
              from: existing.status,
              to: parsed.to,
              ...(parsed.transitionReason !== undefined && { transitionReason: parsed.transitionReason }),
            },
          },
        });

        return row;
      });

      res.json({ data: updated });
    }),
  );

  router.get(
    '/cases/:id/draft-jobs',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const rows = await db.draftJob.findMany({ where: { caseId: id }, orderBy: { version: 'desc' } });
      res.json({ data: rows });
    }),
  );

  router.get(
    '/cases/:id/corrections',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const rows = await db.correction.findMany({ where: { caseId: id }, orderBy: { requestedAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  router.post(
    '/cases/:id/assign-physician',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseAssignPhysician(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, version: true, assignedPhysicianId: true },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case version is stale', {
            caseId: id,
            expectedVersion: existing.version,
            receivedVersion: parsed.version,
          });
        }

        const row = await tx.case.update({
          where: { id },
          data: { assignedPhysicianId: parsed.physicianId, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_physician_assigned',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, fields: ['assignedPhysicianId'] },
          },
        });

        return row;
      });

      res.json({ data: updated });
    }),
  );

  

  return router;
}
