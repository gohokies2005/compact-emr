import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsersRouter } from '../routes/users.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, AppUserRecord, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'auth' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'no' } }); return; }
      next();
    },
}));

const RN: AppUserRecord = { id: 'U-RN', cognitoSub: 'rn-sub', email: 'rn@x.test', roles: [{ role: 'ops_staff' }] };
const ADMIN: AppUserRecord = { id: 'U-ADMIN', cognitoSub: 'a-sub', email: 'admin@x.test', roles: [{ role: 'admin' }, { role: 'ops_staff' }] };
const DOC: AppUserRecord = { id: 'U-DOC', cognitoSub: 'd-sub', email: 'doc@x.test', roles: [{ role: 'physician' }] };
const ALL = [ADMIN, DOC, RN];

function makeDb() {
  const findMany = vi.fn(async (a: { where?: { roles?: { some?: { role?: string } } } }) => {
    const role = a.where?.roles?.some?.role;
    return role === undefined ? ALL : ALL.filter((u) => u.roles.some((r) => r.role === role));
  });
  const db = { appUser: { findUnique: vi.fn(), findMany } } as unknown as AppDb;
  return { db, findMany };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createUsersRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'unexpected');
  });
  return app;
}

describe('GET /users — staff directory for assignment pickers', () => {
  beforeEach(() => { mockUser = { sub: 'rn-sub', roles: ['ops_staff'] }; });

  it('filters to ops_staff and returns id/email/roles only', async () => {
    const { db, findMany } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/users?role=ops_staff');
    expect(res.status).toBe(200);
    // ADMIN also has ops_staff, so both ADMIN and RN come back; DOC does not.
    expect(res.body.data.map((u: { email: string }) => u.email).sort()).toEqual(['admin@x.test', 'rn@x.test']);
    expect(res.body.data[0]).toHaveProperty('roles');
    expect(res.body.data[0]).not.toHaveProperty('cognitoSub');
    expect(findMany.mock.calls[0][0].where).toEqual({ roles: { some: { role: 'ops_staff' } } });
  });

  it('returns all users when no role filter is given', async () => {
    const res = await request(appFor(makeDb().db)).get('/api/v1/users');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('rejects an invalid role with 400', async () => {
    const res = await request(appFor(makeDb().db)).get('/api/v1/users?role=superuser');
    expect(res.status).toBe(400);
  });

  it('forbids a physician caller (403)', async () => {
    mockUser = { sub: 'd-sub', roles: ['physician'] };
    const res = await request(appFor(makeDb().db)).get('/api/v1/users?role=ops_staff');
    expect(res.status).toBe(403);
  });
});
