import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesRouter } from '../routes/cases.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Auth required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

function makeDb(opts: { version?: number; caseExists?: boolean; rn?: { id: string; roles: Array<{ role: string }> } | null } = {}) {
  const version = opts.version ?? 1;
  const caseRow = { id: 'CASE-1', veteranId: 'VET-1', version, assignedRnId: null };
  const tx = {
    case: {
      findFirst: vi.fn(async () => (opts.caseExists === false ? null : caseRow)),
      update: vi.fn(async (a: { data: { assignedRnId: string } }) => ({
        id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'x', claimType: 'initial', status: 'records',
        version: version + 1, currentVersion: 0, assignedPhysicianId: null, assignedRnId: a.data.assignedRnId,
        refundEligible: false, createdAt: new Date(), updatedAt: new Date(),
      })),
    },
    activityLog: { create: vi.fn(async () => ({})) },
  };
  const appUser = { findUnique: vi.fn(async () => (opts.rn === undefined ? { id: 'RN-1', roles: [{ role: 'ops_staff' }] } : opts.rn)) };
  const db = { ...tx, appUser, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, tx };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCasesRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('POST /cases/:id/assign-rn (D3)', () => {
  beforeEach(() => { mockUser = { sub: 'admin-sub', roles: ['admin'] }; });

  it('assigns an ops_staff RN liaison -> 200, sets assignedRnId', async () => {
    const { db, tx } = makeDb({ rn: { id: 'RN-1', roles: [{ role: 'ops_staff' }] } });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/assign-rn').send({ rnUserId: 'RN-1', version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.assignedRnId).toBe('RN-1');
    expect(tx.case.update).toHaveBeenCalled();
  });

  it('rejects a physician-only user as RN liaison -> 422', async () => {
    const { db } = makeDb({ rn: { id: 'DR-1', roles: [{ role: 'physician' }] } });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/assign-rn').send({ rnUserId: 'DR-1', version: 1 });
    expect(res.status).toBe(422);
  });

  it('unknown RN user -> 404', async () => {
    const { db } = makeDb({ rn: null });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/assign-rn').send({ rnUserId: 'NOPE', version: 1 });
    expect(res.status).toBe(404);
  });

  it('stale version -> 409', async () => {
    const { db } = makeDb({ version: 1, rn: { id: 'RN-1', roles: [{ role: 'ops_staff' }] } });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/assign-rn').send({ rnUserId: 'RN-1', version: 99 });
    expect(res.status).toBe(409);
  });

  it('physician role cannot assign an RN -> 403', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'dr-sub', roles: ['physician'] };
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/assign-rn').send({ rnUserId: 'RN-1', version: 1 });
    expect(res.status).toBe(403);
  });
});
