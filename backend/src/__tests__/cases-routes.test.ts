import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesRouter } from '../routes/cases.js';
import type { AppDb, CaseRecord, Role } from '../services/db-types.js';

// The request user shape the routes actually read off req.user (Cognito JWT claims).
interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'CASE-1',
    veteranId: 'VET-1',
    claimedCondition: 'condition field not asserted',
    claimType: 'initial',
    framingChoice: null,
    upstreamScCondition: null,
    veteranStatement: null,
    inServiceEvent: null,
    status: 'intake',
    cdsVerdict: 'not_yet_run',
    cdsOddsPct: null,
    cdsRationale: null,
    assignedPhysicianId: null,
    refundEligible: false,
    currentVersion: 0,
    createdAt: new Date('2026-05-24T00:00:00.000Z'),
    updatedAt: new Date('2026-05-24T00:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

interface PhysicianStub { readonly id: string; readonly cognitoSub: string | null; readonly active: boolean; }

function makeDb(initialCase: CaseRecord = baseCase(), opts: { physiciansByCognitoSub?: Record<string, PhysicianStub> } = {}) {
  let current = { ...initialCase };
  const physiciansByCognitoSub = opts.physiciansByCognitoSub ?? {};
  const activityLogCreate = vi.fn(async () => ({}));
  const caseFindFirst = vi.fn(async () => current);
  const caseFindMany = vi.fn(async () => [current]);
  const caseCount = vi.fn(async () => 1);
  const caseCreate = vi.fn(async (args: { data: Partial<CaseRecord> }) => { current = baseCase({ ...args.data, version: 1, status: 'intake' }); return current; });
  const caseUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => { current = { ...current, ...args.data, version: current.version + 1 } as CaseRecord; return current; });
  const draftJobFindMany = vi.fn(async () => [{ id: 'DJ-1', version: 1 }]);
  const correctionFindMany = vi.fn(async () => [{ id: 'CORR-1' }]);
  const veteranFindUnique = vi.fn(async () => ({ id: 'VET-1' }));
  const physicianFindUnique = vi.fn(async (args: { where: { cognitoSub?: string; id?: string } }) => {
    const sub = args.where.cognitoSub;
    if (sub !== undefined) return physiciansByCognitoSub[sub] ?? null;
    return null;
  });

  const tx = {
    case: { findMany: caseFindMany, findFirst: caseFindFirst, findUnique: caseFindFirst, count: caseCount, create: caseCreate, update: caseUpdate },
    veteran: { findUnique: veteranFindUnique },
    draftJob: { findMany: draftJobFindMany },
    correction: { findMany: correctionFindMany },
    activityLog: { create: activityLogCreate },
    physician: { findUnique: physicianFindUnique },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;

  return { db, tx, spies: { activityLogCreate, caseFindFirst, caseFindMany, caseCount, caseCreate, caseUpdate, draftJobFindMany, physicianFindUnique } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  // Stand in for authenticateJwt: populate req.user from the current mock user (or leave it unset for 401 paths).
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCasesRouter(db));
  return app;
}

describe('cases routes', () => {
  beforeEach(() => { mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] }; });

  it('returns 401 unauthenticated', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(401);
  });

  it('returns empty list when physician has no Physician row mapping', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db } = makeDb(); // no physiciansByCognitoSub → resolver returns null
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('creates a case and writes activity row', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/cases').send({ id: 'CASE-2', claimedCondition: 'redacted test condition', claimType: 'initial' });
    expect(res.status).toBe(201);
    expect(spies.caseCreate).toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_created' }) }));
  });

  it('lists paginated cases with veteran lite info', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(spies.caseFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });

  it('gets a single case with relations', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(spies.caseFindFirst).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ draftJobs: expect.any(Object) }) }));
  });

  it('patches fields, bumps version, and writes activity row', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, framingChoice: 'redacted framing' });
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_updated' }) }));
  });

  it('rejects PATCH stale version with 409', async () => {
    const { db } = makeDb(baseCase({ version: 2 }));
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, framingChoice: 'redacted framing' });
    expect(res.status).toBe(409);
  });

  it('soft deletes as rejected (204) with distinct activity action, admin only', async () => {
    const { db, spies } = makeDb(baseCase({ status: 'records' }));
    const res = await request(appFor(db)).delete('/api/v1/cases/CASE-1');
    expect(res.status).toBe(204);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_soft_deleted', detailsJson: expect.objectContaining({ previousStatus: 'records' }) }) }));
  });

  it('performs valid status transition without touching draft jobs', async () => {
    const { db, tx, spies } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({ from: 'intake', to: 'records', version: 1, transitionReason: 'per supervisor approval' });
    expect(res.status).toBe(200);
    expect(tx.draftJob.findMany).not.toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_status_changed', detailsJson: expect.objectContaining({ transitionReason: 'per supervisor approval' }) }) }));
  });

  it('rejects invalid status transition with 400', async () => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({ from: 'intake', to: 'delivered', version: 1 });
    expect(res.status).toBe(400);
  });

  it('allows physician_review to delivered for assigned physician but not ops_staff', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const allowed = makeDb(
      baseCase({ status: 'physician_review', version: 1, assignedPhysicianId: 'PHYS-001' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: true } } },
    );
    const allowedRes = await request(appFor(allowed.db)).post('/api/v1/cases/CASE-1/status').send({ from: 'physician_review', to: 'delivered', version: 1 });
    expect(allowedRes.status).toBe(200);

    mockUser = { sub: 'OPS-USER', email: 'ops@example.com', roles: ['ops_staff'] };
    const denied = makeDb(baseCase({ status: 'physician_review', version: 1 }));
    const deniedRes = await request(appFor(denied.db)).post('/api/v1/cases/CASE-1/status').send({ from: 'physician_review', to: 'delivered', version: 1 });
    expect(deniedRes.status).toBe(403);
  });

  it('denies physician_review to delivered when physician is not assigned to the case', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db } = makeDb(
      baseCase({ status: 'physician_review', version: 1, assignedPhysicianId: 'PHYS-OTHER' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: true } } },
    );
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({ from: 'physician_review', to: 'delivered', version: 1 });
    expect(res.status).toBe(403);
  });

  it('lets assigned physician GET /cases/:id and scopes list to their assigned cases', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db, spies } = makeDb(
      baseCase({ assignedPhysicianId: 'PHYS-001' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: true } } },
    );
    const detail = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(detail.status).toBe(200);
    const list = await request(appFor(db)).get('/api/v1/cases');
    expect(list.status).toBe(200);
    expect(spies.caseFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ assignedPhysicianId: 'PHYS-001' }) }));
  });

  it('blocks physician from GET /cases/:id when not assigned (403)', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db } = makeDb(
      baseCase({ assignedPhysicianId: 'PHYS-OTHER' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: true } } },
    );
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(403);
  });

  it('blocks PATCH /cases/:id by physician when not assigned (403)', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db } = makeDb(
      baseCase({ assignedPhysicianId: 'PHYS-OTHER' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: true } } },
    );
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, veteranStatement: 'updated' });
    expect(res.status).toBe(403);
  });

  it('blocks inactive physician from case access even when sub matches assignment', async () => {
    mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
    const { db } = makeDb(
      baseCase({ assignedPhysicianId: 'PHYS-001' }),
      { physiciansByCognitoSub: { 'PHYS-USER': { id: 'PHYS-001', cognitoSub: 'PHYS-USER', active: false } } },
    );
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(403);
  });

  it('rejects stale status transition with 409', async () => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 2 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({ from: 'intake', to: 'records', version: 1 });
    expect(res.status).toBe(409);
  });

  it.each([['123-45-6789'], ['call 555-123-4567 back'], ['veteran@example.com confirmed']])('rejects PHI-shaped transitionReason %s', async (transitionReason) => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({ from: 'intake', to: 'records', version: 1, transitionReason });
    expect(res.status).toBe(400);
  });
});
