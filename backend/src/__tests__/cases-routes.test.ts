import '../bootstrap/bigint-serialization.js'; // installs BigInt->string JSON (prod loads it via server.ts)
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
    claimedConditions: ['condition field not asserted'],
    claimType: 'initial',
    previouslyDenied: false,
    priorDenialReason: null,
    priorDecisionDate: null,
    framingChoice: null,
    upstreamScCondition: null,
    veteranStatement: null,
    inServiceEvent: null,
    status: 'intake',
    cdsVerdict: 'not_yet_run',
    cdsOddsPct: null,
    cdsRationale: null,
    assignedPhysicianId: null,
    assignedRnId: null,
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
  const caseDelete = vi.fn(async () => ({}));
  const draftJobFindMany = vi.fn(async () => [{ id: 'DJ-1', version: 1 }]);
  const correctionFindMany = vi.fn(async () => [{ id: 'CORR-1' }]);
  const veteranFindUnique = vi.fn(async () => ({ id: 'VET-1' }));
  const physicianFindUnique = vi.fn(async (args: { where: { cognitoSub?: string; id?: string } }) => {
    const sub = args.where.cognitoSub;
    if (sub !== undefined) return physiciansByCognitoSub[sub] ?? null;
    return null;
  });

  const tx = {
    case: { findMany: caseFindMany, findFirst: caseFindFirst, findUnique: caseFindFirst, count: caseCount, create: caseCreate, update: caseUpdate, delete: caseDelete },
    veteran: { findUnique: veteranFindUnique },
    draftJob: { findMany: draftJobFindMany },
    correction: { findMany: correctionFindMany },
    activityLog: { create: activityLogCreate },
    physician: { findUnique: physicianFindUnique },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;

  return { db, tx, spies: { activityLogCreate, caseFindFirst, caseFindMany, caseCount, caseCreate, caseUpdate, caseDelete, draftJobFindMany, physicianFindUnique } };
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

  // Regression for the 2026-05-27 claim-load crash: a case WITH documents carries a BigInt
  // sizeBytes; without the BigInt->string serializer res.json throws and GET /cases/:id 500s
  // (every case with uploads). The bootstrap import above is what makes this pass.
  it('serializes a case that has documents (BigInt sizeBytes) as 200, not a 500', async () => {
    const caseWithDocs = { ...baseCase(), documents: [
      { id: 'DOC-1', caseId: 'CASE-1', filename: 'Claim Final.pdf', sizeBytes: BigInt(837639), contentType: 'application/pdf', docTag: 'Other', s3Key: 'cases/CASE-1/uuid-Claim-Final.pdf', uploadedAt: new Date('2026-05-27T00:00:00.000Z'), uploadedBy: 'u', updatedAt: new Date('2026-05-27T00:00:00.000Z'), version: 1 },
    ] } as unknown as CaseRecord;
    const { db } = makeDb(caseWithDocs);
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.documents[0].sizeBytes).toBe('837639');
  });

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
    // Single-condition create derives claimedConditions from the singular field.
    expect(spies.caseCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ claimedConditions: ['redacted test condition'], claimedCondition: 'redacted test condition' }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_created' }) }));
  });

  it('creates a clustered claim: primary = first condition, both columns persisted', async () => {
    const { db, spies } = makeDb();
    // Hip + Lumbar / back — both Musculoskeletal, so same-system guard passes.
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/cases').send({ id: 'CASE-3', claimedConditions: ['Hip', 'Lumbar / back'], claimType: 'initial' });
    expect(res.status).toBe(201);
    expect(spies.caseCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ claimedCondition: 'Hip', claimedConditions: ['Hip', 'Lumbar / back'] }) }));
  });

  it('rejects a cross-body-system clustered claim with 400', async () => {
    const { db } = makeDb();
    // Lumbar / back (Musculoskeletal) + Obstructive sleep apnea (Respiratory / Sleep) => different systems.
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/cases').send({ id: 'CASE-4', claimedConditions: ['Lumbar / back', 'Obstructive sleep apnea'], claimType: 'initial' });
    expect(res.status).toBe(400);
  });

  it('allows a clustered claim mixing a known condition with free-text (free-text exempt)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/cases').send({ id: 'CASE-5', claimedConditions: ['Lumbar / back', 'Some rare unlisted thing'], claimType: 'initial' });
    expect(res.status).toBe(201);
    expect(spies.caseCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ claimedConditions: ['Lumbar / back', 'Some rare unlisted thing'] }) }));
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

  it('returns draftingCostUsd null when no DraftJob carries a recorded cost', async () => {
    // Default mock draftJob.findMany returns rows without costUsd → honest null (UI shows "—").
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.draftingCostUsd).toBeNull();
  });

  it('aggregates draftingCostUsd over ALL DraftJobs, coercing Decimal strings and skipping null', async () => {
    const { db } = makeDb();
    // Cost-bearing runs older than the take:5 detail list; Prisma Decimal may serialize as a string.
    (db.draftJob.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { costUsd: 3.42 }, { costUsd: '1.58' }, { costUsd: null }, { costUsd: undefined },
    ]);
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.draftingCostUsd).toBe(5.0);
    // Aggregate is over the whole case, NOT scoped to the take:5 include.
    expect((db.draftJob.findMany as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { caseId: 'CASE-1' }, select: { costUsd: true } }),
    );
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

  it('ARCHIVES a claim (204) — soft delete (sets archived_at), keeps the row + audit, no hard delete', async () => {
    const { db, spies } = makeDb(baseCase({ status: 'intake' }));
    const res = await request(appFor(db)).delete('/api/v1/cases/CASE-1');
    expect(res.status).toBe(204);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'CASE-1' }, data: expect.objectContaining({ archivedAt: expect.anything() }) }));
    expect(spies.caseDelete).not.toHaveBeenCalled(); // soft archive, NOT a destructive delete
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_archived' }) }));
  });

  it('archives ANY status (reversible) — even a progressed claim, no 409', async () => {
    const { db, spies } = makeDb(baseCase({ status: 'records' }));
    const res = await request(appFor(db)).delete('/api/v1/cases/CASE-1');
    expect(res.status).toBe(204);
    expect(spies.caseUpdate).toHaveBeenCalled();
    expect(spies.caseDelete).not.toHaveBeenCalled();
  });

  it('restores an archived claim (archived_at = null)', async () => {
    const { db, spies } = makeDb(baseCase({ status: 'rejected' }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/restore').send({});
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'CASE-1' }, data: expect.objectContaining({ archivedAt: null }) }));
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
