import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../http/errors.js';

export const ROLES = ['physician', 'ops_staff', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthenticatedUser {
  sub: string;
  email?: string;
  roles: Role[];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function requireRole(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendError(res, 401, 'unauthorized', 'Authentication is required.');
    }

    const hasRole = req.user.roles.some((role) => allowedRoles.includes(role));
    if (!hasRole) {
      return sendError(res, 403, 'forbidden', 'This route is not available for your role.', { requiredRoles: allowedRoles });
    }

    return next();
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}
