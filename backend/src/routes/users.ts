import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'ops_staff', 'physician'];

/**
 * Minimal staff directory for assignment pickers (the RN-liaison selector on a case). Admin +
 * ops_staff only — physicians don't assign. Returns id/email/roles only (no PHI). The RN picker
 * calls `GET /users?role=ops_staff`; the role filter is validated against the closed role set.
 */
export function createUsersRouter(db: AppDb): Router {
  const router = Router();

  router.get(
    '/users',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const roleParam = req.query.role;
      let where: unknown = {};
      if (roleParam !== undefined) {
        if (typeof roleParam !== 'string' || !ASSIGNABLE_ROLES.includes(roleParam as Role)) {
          throw new HttpError(400, 'bad_request', `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, { role: roleParam });
        }
        where = { roles: { some: { role: roleParam } } };
      }
      const users = await db.appUser.findMany({ where, include: { roles: true }, orderBy: { email: 'asc' } });
      res.json({ data: users.map((u) => ({ id: u.id, email: u.email, roles: u.roles.map((r) => r.role) })) });
    }),
  );

  return router;
}
