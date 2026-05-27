import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCdsRouter } from '../routes/cds.js';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
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

function makeDb(over: { caseRow?: unknown } = {}) {
  const caseRow = over.caseRow === undefined
    ? { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimedConditions: ['Obstructive sleep apnea'], claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: 'PTSD' }
    : over.caseRow;
  const veteran = { id: 'VET-1', scConditions: [{ condition: 'PTSD' }], activeProblems: [{ problem: 'Obstructive sleep apnea' }] };
  const caseUpdate = vi.fn(async () => ({}));
  const activityLogCreate = vi.fn(async () => ({}));
  const tx = {
    case: { findFirst: vi.fn(async () => caseRow), update: caseUpdate },
    veteran: { findUnique: vi.fn(async () => veteran) },
    activityLog: { create: activityLogCreate },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, caseUpdate, activityLogCreate };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCdsRouter(db));
  return app;
}

describe('cds routes', () => {
  beforeEach(() => { mockUser = { sub: 'USER-1', roles: ['admin'] }; });

  it('returns 401 unauthenticated', async () => {
    mockUser = undefined;
    const res = await request(appFor(makeDb().db)).post('/api/v1/cases/CASE-1/cds');
    expect(res.status).toBe(401);
  });

  it('returns 403 for physician', async () => {
    mockUser = { sub: 'P', roles: ['physician'] };
    const res = await request(appFor(makeDb().db)).post('/api/v1/cases/CASE-1/cds');
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown case', async () => {
    const res = await request(appFor(makeDb({ caseRow: null }).db)).post('/api/v1/cases/NOPE/cds');
    expect(res.status).toBe(404);
  });

  it('runs CDS, returns accept, persists verdict + writes activity', async () => {
    const { db, caseUpdate, activityLogCreate } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/cds');
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('accept');
    expect(res.body.data.oddsPct).toBe(89.2);
    expect(res.body.data.driverCondition).toBe('Obstructive sleep apnea');
    expect(res.body.data.perCondition).toHaveLength(1);
    expect(caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cdsVerdict: 'accept', cdsOddsPct: 89 }) }));
    expect(activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'cds_evaluated' }) }));
  });

  it('evaluates a clustered claim and picks the best-odds condition as overall', async () => {
    // Both PTSD-anchored; OSA (89.2%) beats Hypertension (85%) on odds.
    const caseRow = { id: 'CASE-9', veteranId: 'VET-1', claimedCondition: 'Hypertension', claimedConditions: ['Hypertension', 'Obstructive sleep apnea'], claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: 'PTSD' };
    const { db, caseUpdate } = makeDb({ caseRow });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-9/cds');
    expect(res.status).toBe(200);
    expect(res.body.data.driverCondition).toBe('Obstructive sleep apnea');
    expect(res.body.data.oddsPct).toBe(89.2);
    expect(res.body.data.perCondition).toHaveLength(2);
    expect(caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cdsVerdict: 'accept', cdsOddsPct: 89 }) }));
  });

  it('falls back to the single primary when claimedConditions is empty', async () => {
    const caseRow = { id: 'CASE-10', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimedConditions: [], claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: 'PTSD' };
    const { db } = makeDb({ caseRow });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-10/cds');
    expect(res.status).toBe(200);
    expect(res.body.data.verdict).toBe('accept');
    expect(res.body.data.driverCondition).toBe('Obstructive sleep apnea');
  });
});
