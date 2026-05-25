import type { Request } from 'express';
import { HttpError } from '../http/errors.js';
import type { Role } from './db-types.js';

/**
 * Canonical role-priority for route handlers that resolve a SINGLE effective role from a JWT
 * carrying multiple Cognito groups (e.g. an admin who is also a physician acts as admin).
 *
 * Ordered most-privileged-first; the first matching role in the user's roles list wins.
 */
const ROLE_PRIORITY: readonly Role[] = ['admin', 'physician', 'ops_staff'];

export interface RequestActor {
  readonly sub: string;
  readonly email: string | undefined;
  readonly roles: readonly Role[];
  readonly role: Role;
  readonly id: string;
}

/**
 * Resolve the canonical RequestActor from `req.user` (populated by `authenticateJwt`).
 *
 * Throws 401 if unauthenticated, 403 if the JWT carries no recognized role.
 *
 * Extracted Phase 5.1 (architect QA REVIEW.md ¶4): cases.ts, sign-offs.ts, and several other
 * route files each had their own copy of this with subtly different shapes. Centralize so a
 * future fourth role (e.g. 'rn') only needs one update site.
 */
export function currentActor(req: Request): RequestActor {
  const u = (req as Request & { user?: { sub: string; email?: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const role = ROLE_PRIORITY.find((r) => u.roles.includes(r));
  if (role === undefined) {
    throw new HttpError(403, 'forbidden', 'No valid role found in JWT', { requiredRoles: ROLE_PRIORITY });
  }
  return { sub: u.sub, email: u.email, roles: u.roles, role, id: u.sub };
}

/**
 * Lightweight form used by routes that only need the cognito sub (e.g. activity-log actorUserId
 * fields). Throws 401 if unauthenticated. Does NOT validate role.
 */
export function actorSub(req: Request): string {
  const u = (req as Request & { user?: { sub: string } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return u.sub;
}
