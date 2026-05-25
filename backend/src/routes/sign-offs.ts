import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { parseSignOffCreate } from '../services/sign-off-validation.js';
import { resolveCurrentPhysician } from '../services/physician-resolver.js';
import type { AppDb, Role } from '../services/db-types.js';

function currentUser(req: Request): { sub: string; role: Role } {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const priority: readonly Role[] = ['admin', 'physician', 'ops_staff'];
  const role = priority.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role found in JWT');
  return { sub: u.sub, role };
}

export function createSignOffsRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/cases/:id/sign-off
   *
   * Only an assigned physician (or admin acting in their stead) can sign off a case. Records
   * the physician's answers + signature timestamp. Multiple sign-offs per case are allowed —
   * the latest by signedAt is the active sign-off. Each sign-off writes an activity row.
   *
   * Status transition (e.g. physician_review -> delivered) is a SEPARATE call; this endpoint
   * records the sign-off act itself, not the workflow advancement.
   */
  router.post(
    '/cases/:id/sign-off',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const caseId = String(req.params.id);
      const parsed = parseSignOffCreate(req.body);

      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true, assignedPhysicianId: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // Resolve the physician issuing the sign-off. Admin can sign on behalf when no physician
      // is assigned (rare) — otherwise the resolver must produce a real physician identity.
      let physicianId: string;
      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null) {
          throw new HttpError(403, 'forbidden', 'Physician has no active Physician record mapping.', { caseId });
        }
        if (c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
        physicianId = physician.id;
      } else {
        // admin: case must have an assigned physician to attribute the sign-off to
        if (c.assignedPhysicianId === null) {
          throw new HttpError(409, 'conflict', 'Case has no assigned physician; assign one before sign-off.', { caseId });
        }
        physicianId = c.assignedPhysicianId;
      }

      const created = await db.$transaction(async (tx) => {
        const row = await tx.signOff.create({
          data: {
            caseId,
            physicianId,
            answersJson: parsed.answers,
            notes: parsed.notes,
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: user.sub,
            action: 'case_signed_off',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: { caseId, physicianId, signOffId: row.id, answerKeys: Object.keys(parsed.answers) },
          },
        });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  /**
   * GET /api/v1/cases/:id/sign-offs
   *
   * Lists sign-off events for a case, newest first. Read access mirrors the existing
   * staff/assigned-physician contract used by other case-scoped reads.
   */
  router.get(
    '/cases/:id/sign-offs',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const caseId = String(req.params.id);

      // For physicians, gate on assignment to match the rest of /cases/:id-style endpoints.
      if (user.role === 'physician') {
        const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, assignedPhysicianId: true } });
        if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null || c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
      }

      const rows = await db.signOff.findMany({ where: { caseId }, orderBy: { signedAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  return router;
}
