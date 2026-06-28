import '../bootstrap/bigint-serialization.js'; // installs BigInt->string JSON (prod loads it via server.ts)
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesRouter } from '../routes/cases.js';
import { CASE_STATUSES } from '../services/case-status-transitions.js';
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

// Package 7: the status route auto-fires Doctor Pack generation when a case lands
// physician_review. Mock the service — its own behavior (idempotency modes, manifest assembly)
// is unit-tested in doctor-pack-generate.test.ts; here we pin the ROUTE contract: fires on the
// landing edges with the right args, and a failure NEVER blocks the transition.
vi.mock('../services/doctor-pack-generate.js', () => ({
  generateDoctorPackForCase: vi.fn(async () => ({ outcome: 'queued', pack: { id: 'DP-1', caseVersion: 2 } })),
}));
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
const doctorPackGenMock = vi.mocked(generateDoctorPackForCase);

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
    coverMemoSuppressed: false,
    coverMemoTextOverride: null,
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
  const caseMessageCreate = vi.fn(async () => ({}));
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

  // Default sign-off for the delivery-eligibility gate (correction-round SSOT, audit 2026-06-13):
  // an affirmative sign-off with NO bound hash → the byte step fails open (createCasesRouter here is
  // mounted with no s3/bucket deps), so a valid ->delivered transition passes the gate. The gate's
  // own behavior (block on missing/non-affirmative sign-off) is covered in delivery-eligibility.test.
  const signOffFindMany = vi.fn(async () => [{ id: 'SO-1', answersJson: { ready: true }, signedVersion: null, signedContentSha256: null }]);
  // Latest-quick-note batch read for the Cases list: returns one row per veteran (the mock just
  // returns a single canned quick note; assertions below pin that it's a SINGLE distinct query).
  const chartNoteFindMany = vi.fn(async () => [
    { id: 'QN-1', veteranId: 'VET-1', body: 'awaiting records — C-file requested', createdAt: new Date('2026-06-20T00:00:00.000Z'), createdBy: 'USER-1' },
  ]);
  const tx = {
    case: { findMany: caseFindMany, findFirst: caseFindFirst, findUnique: caseFindFirst, count: caseCount, create: caseCreate, update: caseUpdate, delete: caseDelete },
    veteran: { findUnique: veteranFindUnique },
    draftJob: { findMany: draftJobFindMany },
    correction: { findMany: correctionFindMany },
    activityLog: { create: activityLogCreate },
    caseMessage: { create: caseMessageCreate },
    physician: { findUnique: physicianFindUnique },
    signOff: { findMany: signOffFindMany },
    chartNote: { findMany: chartNoteFindMany },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;

  return { db, tx, spies: { activityLogCreate, caseMessageCreate, caseFindFirst, caseFindMany, caseCount, caseCreate, caseUpdate, caseDelete, draftJobFindMany, physicianFindUnique, chartNoteFindMany } };
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

  // === C5 lifecycle (2026-06-13): the `archived` param tri-state (active / archived-only / all) ===

  // The spy's call tuple is typed as 0-length; read the first arg through `unknown` (same pattern
  // as the _count test above).
  function firstFindManyArg(spy: { mock: { calls: unknown[] } }): { where?: Record<string, unknown>; select?: Record<string, unknown> } {
    const calls = spy.mock.calls as unknown as Array<Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }>>;
    return calls[0]?.[0] ?? {};
  }

  it('default (no archived param) filters to ACTIVE only: where.archivedAt = null', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases');
    expect(firstFindManyArg(spies.caseFindMany).where?.archivedAt).toBeNull();
  });

  it('archived=true filters to ARCHIVED only: where.archivedAt = { not: null }', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases?archived=true');
    expect(firstFindManyArg(spies.caseFindMany).where?.archivedAt).toEqual({ not: null });
  });

  it('archived=all imposes NO archivedAt constraint (Closed toggle: active + archived in one query)', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases?archived=all&statuses=paid,rejected');
    const where = firstFindManyArg(spies.caseFindMany).where ?? {};
    expect('archivedAt' in where).toBe(false);
    // The Closed status set still rides alongside (paid + rejected).
    expect(where.status).toEqual({ in: ['paid', 'rejected'] });
  });

  it('CASE_LITE_SELECT requests archivedAt so the list rows can label the Archived display-group', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases');
    expect(firstFindManyArg(spies.caseFindMany).select?.archivedAt).toBe(true);
  });

  // === RECORDS signal (binary: veteran-uploaded records present vs Stage-1-only) ===

  it('queries a FILTERED documents _count that excludes the intake summary + doctor pack', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases');
    // The select must carry a filtered relation count whose NOT-clause drops both auto-gen docs.
    const firstCall = spies.caseFindMany.mock.calls[0] as unknown as Array<{ select?: { _count?: { select?: { documents?: { where?: { NOT?: unknown[] } } } } } }>;
    const call = firstCall?.[0];
    const not = call?.select?._count?.select?.documents?.where?.NOT;
    expect(not).toEqual([
      { s3Key: { endsWith: 'Intake_Summary.pdf' } },
      { s3Key: { contains: 'Doctor_Pack' } },
      { s3Key: { contains: 'DoctorPack' } },
    ]);
  });

  it('recordsUploaded=false (recordCount 0) for a case with ONLY an Intake_Summary.pdf', async () => {
    const { db } = makeDb();
    // Prisma applies the NOT-filter, so the intake-summary-only case returns documents count 0.
    (db.case.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...baseCase(), _count: { documents: 0 } },
    ]);
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data[0].recordsUploaded).toBe(false);
    expect(res.body.data[0].recordCount).toBe(0);
    // Internal _count is stripped from the wire shape.
    expect(res.body.data[0]._count).toBeUndefined();
  });

  it('recordsUploaded=true (recordCount>0) for a case with a real uploaded record', async () => {
    const { db } = makeDb();
    (db.case.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...baseCase(), _count: { documents: 2 } },
    ]);
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data[0].recordsUploaded).toBe(true);
    expect(res.body.data[0].recordCount).toBe(2);
  });

  it('recordsUploaded=false for a doctor-pack-only case (false-positive guard)', async () => {
    const { db } = makeDb();
    // A case whose only docs are the intake summary + doctor pack → filtered count is 0.
    (db.case.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...baseCase(), _count: { documents: 0 } },
    ]);
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data[0].recordsUploaded).toBe(false);
  });

  it('defaults recordsUploaded=false when _count is absent (defensive)', async () => {
    // The default mock returns a row WITHOUT _count — must not throw, defaults to false/0.
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data[0].recordsUploaded).toBe(false);
    expect(res.body.data[0].recordCount).toBe(0);
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

  // pkg 5 provenance: a staff PATCH of the framing pair stamps 'manual' (immutable to the
  // post-merge restamp hook); a PATCH that doesn't touch the pair must NOT touch the stamp.
  it('PATCHing framingChoice stamps framingStampSource=manual', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, framingChoice: 'secondary' });
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ framingChoice: 'secondary', framingStampSource: 'manual' }) }));
  });

  it('PATCHing upstreamScCondition (even clearing it to null) stamps manual', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, upstreamScCondition: null });
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ upstreamScCondition: null, framingStampSource: 'manual' }) }));
  });

  it('a PATCH that does not touch the framing pair leaves the stamp alone', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, veteranStatement: 'updated' });
    expect(res.status).toBe(200);
    const data = (spies.caseUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('framingStampSource');
  });

  it('rejects PATCH stale version with 409', async () => {
    const { db } = makeDb(baseCase({ version: 2 }));
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, framingChoice: 'redacted framing' });
    expect(res.status).toBe(409);
  });

  // Ryan 2026-06-06 (Warren dx change): editing the primary claimedCondition on a SINGLE-condition
  // claim must also rewrite claimedConditions[] — the CDS/drafter read the array when non-empty, so a
  // stale array would make the run use the OLD condition.
  it('syncs claimedConditions[] when claimedCondition is patched on a single-condition claim', async () => {
    const { db, spies } = makeDb(baseCase({ claimedCondition: 'Other joint', claimedConditions: ['Other joint'] }));
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, claimedCondition: 'Left shoulder osteoarthritis' });
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ claimedCondition: 'Left shoulder osteoarthritis', claimedConditions: ['Left shoulder osteoarthritis'] }),
    }));
  });

  it('does NOT touch claimedConditions[] on a CLUSTERED (multi-condition) claim', async () => {
    const { db, spies } = makeDb(baseCase({ claimedCondition: 'Hip', claimedConditions: ['Hip', 'Lumbar / back'] }));
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({ version: 1, claimedCondition: 'Hip, left' });
    expect(res.status).toBe(200);
    const data = (spies.caseUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('claimedConditions');
  });

  // RETIRED Feature A (2026-06-21): the overwritable case scratchpad is gone. The PATCH route is kept
  // as an explicit 410 Gone tombstone (not silently writing the dead column, not a confusing 404) so a
  // stale client gets a debuggable signal. Quick notes are now persistent chart-notes-stream entries.
  it('PATCH /quick-note is RETIRED → 410 Gone and never writes the case row', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1/quick-note').send({ note: 'waiting on records' });
    expect(res.status).toBe(410); // Gone — route stays registered as a tombstone (no error middleware mounted in this test app, so only status is asserted, mirroring the 409 tests)
    expect(spies.caseUpdate).not.toHaveBeenCalled();
    expect(spies.activityLogCreate).not.toHaveBeenCalled();
  });

  // The Cases list now surfaces the latest PERSISTENT quick note per row, batch-attached as
  // `latestQuickNote`. CRITICAL: it must cost ONE extra query for the whole page (DISTINCT ON), not
  // an N+1 per row — assert the chartNote.findMany was called exactly once with the distinct shape.
  it('attaches latestQuickNote to each list row via a SINGLE batched distinct query (no N+1)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?page=1&pageSize=25');
    expect(res.status).toBe(200);
    // one batched read for the whole page, not one-per-row
    expect(spies.chartNoteFindMany).toHaveBeenCalledTimes(1);
    const qnCalls = spies.chartNoteFindMany.mock.calls as unknown as Array<Array<{ where?: Record<string, unknown>; distinct?: unknown; orderBy?: unknown }>>;
    const arg = qnCalls[0]?.[0] ?? {};
    expect(arg.distinct).toEqual(['veteranId']);
    expect(arg.where).toMatchObject({ isQuickNote: true, veteranId: { in: expect.arrayContaining(['VET-1']) } });
    // the surfaced note rides the list row
    expect(res.body.data[0].latestQuickNote).toMatchObject({ body: 'awaiting records — C-file requested' });
  });

  it('list row latestQuickNote is null when the veteran has no quick note', async () => {
    const { db, spies } = makeDb();
    spies.chartNoteFindMany.mockResolvedValueOnce([]);
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(200);
    expect(res.body.data[0].latestQuickNote).toBeNull();
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

  // ============ Package 7 (2026-06-11): Doctor Pack auto-gen on send-to-doctor ============
  describe('Doctor Pack auto-gen on landing physician_review', () => {
    beforeEach(() => {
      doctorPackGenMock.mockReset();
      doctorPackGenMock.mockResolvedValue({ outcome: 'queued', pack: { id: 'DP-1', caseVersion: 8 } } as never);
    });

    it('rn_review -> physician_review fires the auto-gen EXACTLY ONCE with the pre-transition version', async () => {
      const { db } = makeDb(baseCase({ status: 'rn_review', version: 7, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'rn_review', to: 'physician_review', version: 7 });

      expect(res.status).toBe(200);
      expect(doctorPackGenMock).toHaveBeenCalledTimes(1);
      expect(doctorPackGenMock).toHaveBeenCalledWith(db, {
        caseId: 'CASE-1',
        actorSub: 'USER-1',
        trigger: 'auto_send_to_doctor',
        priorCaseVersion: 7,
      });
    });

    it('drafting -> physician_review (the legacy/manual landing edge) ALSO fires the auto-gen', async () => {
      // assignedPhysicianId required: the no-unassigned-doctor guard now covers EVERY edge into
      // physician_review (2026-06-23), drafting included — a "send to doctor" with no doctor 409s.
      const { db } = makeDb(baseCase({ status: 'drafting', version: 3, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'drafting', to: 'physician_review', version: 3 });

      expect(res.status).toBe(200);
      expect(doctorPackGenMock).toHaveBeenCalledTimes(1);
      expect(doctorPackGenMock).toHaveBeenCalledWith(db, expect.objectContaining({ trigger: 'auto_send_to_doctor', priorCaseVersion: 3 }));
    });

    it('drafting -> physician_review with NO assigned physician 409s (no-unassigned-doctor guard covers every edge into physician_review)', async () => {
      const { db } = makeDb(baseCase({ status: 'drafting', version: 3, assignedPhysicianId: null }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'drafting', to: 'physician_review', version: 3 });
      // 409 + doctor-pack never fired proves the guard blocked the unassigned send (this test harness's
      // error handler returns an empty body, so the status + the no-side-effect are the observable proof).
      expect(res.status).toBe(409);
      expect(doctorPackGenMock).not.toHaveBeenCalled();
    });

    it('a re-fire where the service SKIPS (pack already current) still returns 200 — no duplicate, no error', async () => {
      doctorPackGenMock.mockResolvedValue({
        outcome: 'skipped', existingPackId: 'DP-1', existingState: 'ready', existingCaseVersion: 8,
      } as never);
      const { db, spies } = makeDb(baseCase({ status: 'rn_review', version: 7, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'rn_review', to: 'physician_review', version: 7 });

      expect(res.status).toBe(200);
      expect(doctorPackGenMock).toHaveBeenCalledTimes(1);
      // The transition itself still committed.
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review' }) }));
    });

    it('an auto-gen FAILURE does not block the send: status flips, 200 returned, structured warn logged', async () => {
      doctorPackGenMock.mockRejectedValue(new Error('chart_not_ready: 2 files still unread'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { db, spies } = makeDb(baseCase({ status: 'rn_review', version: 7, assignedPhysicianId: 'PHYS-001' }));

      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'rn_review', to: 'physician_review', version: 7 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('physician_review');
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review' }) }));
      const warnPayload = String(warnSpy.mock.calls.find((c) => String(c[0]).includes('doctor_pack_autogen_failed'))?.[0]);
      expect(warnPayload).toContain('doctor_pack_autogen_failed');
      expect(warnPayload).toContain('chart_not_ready: 2 files still unread');
      warnSpy.mockRestore();
    });

    it('does NOT fire on transitions that do not land physician_review', async () => {
      const { db } = makeDb(baseCase({ status: 'intake', version: 1 }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'intake', to: 'records', version: 1 });

      expect(res.status).toBe(200);
      expect(doctorPackGenMock).not.toHaveBeenCalled();
    });

    it('rn_review -> physician_review without an assigned physician still 409s BEFORE any auto-gen', async () => {
      const { db } = makeDb(baseCase({ status: 'rn_review', version: 7, assignedPhysicianId: null }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'rn_review', to: 'physician_review', version: 7 });

      expect(res.status).toBe(409);
      expect(doctorPackGenMock).not.toHaveBeenCalled();
    });

    // ── FORWARD DOOR out of a body-quality park (2026-06-22, "see/edit/FORWARD — never a trap") ──
    it('needs_rn_decision -> physician_review: the RN forwards a hand-fixed held letter to the doctor (200, status flips, auto-gen fires)', async () => {
      const { db, spies } = makeDb(baseCase({ status: 'needs_rn_decision', version: 9, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'needs_rn_decision', to: 'physician_review', version: 9 });

      // Before the case-status-transitions map + cases.ts guard fix this 403'd (illegal edge) — the park
      // was a trap that could only be left by a re-draft. The forward door is now legal for ops_staff.
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('physician_review');
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review' }) }));
      // Lands physician_review like any other "send to doctor" hop → the doctor-pack auto-gen fires.
      expect(doctorPackGenMock).toHaveBeenCalledTimes(1);
      expect(doctorPackGenMock).toHaveBeenCalledWith(db, expect.objectContaining({ trigger: 'auto_send_to_doctor', priorCaseVersion: 9 }));
    });

    it('needs_rn_decision -> physician_review without an assigned physician 409s BEFORE any auto-gen (mirrors the rn_review send guard)', async () => {
      const { db } = makeDb(baseCase({ status: 'needs_rn_decision', version: 9, assignedPhysicianId: null }));
      const res = await request(appFor(db))
        .post('/api/v1/cases/CASE-1/status')
        .send({ from: 'needs_rn_decision', to: 'physician_review', version: 9 });

      expect(res.status).toBe(409);
      expect(doctorPackGenMock).not.toHaveBeenCalled();
    });
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

  // Regression for the status-filter drift: the route's hand-copied allow-list was missing
  // rn_review + the two Gate-2 halt statuses, so the Cases dropdown 400'd on options it offered.
  // The filter now validates against the canonical CASE_STATUSES list; every enum value must be
  // accepted or a newly added status would 400 its own dropdown again.
  it.each(CASE_STATUSES.map((s) => [s]))('accepts ?status=%s on GET /cases (no enum drift)', async (status) => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get(`/api/v1/cases?status=${status}`);
    expect(res.status).toBe(200);
  });

  it('still rejects an unknown status filter with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?status=not_a_status');
    expect(res.status).toBe(400);
  });

  // === assignedRnId filter: single id (legacy) / comma list / '__none__' sentinel combos ===
  // The Cases-page RN multi-select sends a comma-joined value; it MUST stay one where-clause so the
  // single findMany+count pair keeps server-side pagination totals truthful.

  function listWhere(spies: ReturnType<typeof makeDb>['spies']): Record<string, unknown> {
    const call = spies.caseFindMany.mock.calls[0] as unknown as Array<{ where?: Record<string, unknown> }>;
    return call?.[0]?.where ?? {};
  }

  it('assignedRnId single id behaves exactly as before (plain equality, back-compat)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?assignedRnId=U-RN-1');
    expect(res.status).toBe(200);
    expect(listWhere(spies).assignedRnId).toBe('U-RN-1');
  });

  it('assignedRnId=__none__ alone filters to unassigned (null)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?assignedRnId=__none__');
    expect(res.status).toBe(200);
    expect(listWhere(spies).assignedRnId).toBeNull();
  });

  it('assignedRnId comma list of ids maps to { in: ids }', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?assignedRnId=U-RN-1,U-RN-2');
    expect(res.status).toBe(200);
    expect(listWhere(spies).assignedRnId).toEqual({ in: ['U-RN-1', 'U-RN-2'] });
  });

  it('assignedRnId ids + __none__ maps to the OR of { in: ids } and null', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?assignedRnId=U-RN-1,__none__,U-RN-2');
    expect(res.status).toBe(200);
    const where = listWhere(spies);
    expect(where.assignedRnId).toBeUndefined();
    expect(where.OR).toEqual([{ assignedRnId: { in: ['U-RN-1', 'U-RN-2'] } }, { assignedRnId: null }]);
  });

  it('count + findMany see the SAME multi-RN where (pagination totals stay truthful)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?assignedRnId=U-RN-1,__none__');
    expect(res.status).toBe(200);
    const findManyWhere = listWhere(spies);
    const countCall = spies.caseCount.mock.calls[0] as unknown as Array<{ where?: Record<string, unknown> }>;
    expect(countCall?.[0]?.where).toEqual(findManyWhere);
  });

  it('list rows select assignedRn with the friendly name (B-3)', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).get('/api/v1/cases');
    const call = spies.caseFindMany.mock.calls[0] as unknown as Array<{ select?: { assignedRn?: { select?: Record<string, unknown> } } }>;
    expect(call?.[0]?.select?.assignedRn?.select).toEqual({ id: true, email: true, name: true });
  });

  // === `statuses` (multi-status) filter — dashboard GROUP-tile deep-links (D2, 2026-06-13) ===
  // The RN-queue / pre-draft tiles emit a statuses[] filter and deep-link here; a comma list maps to
  // where.status.in, validates each value against CASE_STATUSES, and supersedes single ?status=.
  it('statuses=rn_review,needs_rn_decision maps to where.status.in (group-tile deep-link)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?statuses=rn_review,needs_rn_decision');
    expect(res.status).toBe(200);
    expect(listWhere(spies).status).toEqual({ in: ['rn_review', 'needs_rn_decision'] });
  });

  it('statuses de-dupes and trims tokens', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?statuses=intake,%20viability%20,intake');
    expect(res.status).toBe(200);
    expect(listWhere(spies).status).toEqual({ in: ['intake', 'viability'] });
  });

  it('statuses takes precedence over a single status when both are sent', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?status=delivered&statuses=intake,viability');
    expect(res.status).toBe(200);
    expect(listWhere(spies).status).toEqual({ in: ['intake', 'viability'] });
  });

  it('an unknown value in statuses 400s', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?statuses=intake,not_a_status');
    expect(res.status).toBe(400);
  });

  it('an all-blank statuses param is ignored (no status filter)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?statuses=%20,%20');
    expect(res.status).toBe(200);
    expect(listWhere(spies).status).toBeUndefined();
  });

  it('count + findMany see the SAME statuses where (pagination totals stay truthful)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases?statuses=intake,viability');
    expect(res.status).toBe(200);
    const findManyWhere = listWhere(spies);
    const countCall = spies.caseCount.mock.calls[0] as unknown as Array<{ where?: Record<string, unknown> }>;
    expect(countCall?.[0]?.where).toEqual(findManyWhere);
  });

  // ============ Return-to-physician door (2026-06-28): recall a finalized/signed letter to the MD ============
  // Widened so the physician/owner can recall his OWN signed letter (role 'physician') AND a paid/closed
  // case is recallable by admin/physician (NOT ops_staff). delivered stays returnable by admin/ops/physician.
  describe('POST /cases/:id/return-to-physician', () => {
    const RTP = '/api/v1/cases/CASE-1/return-to-physician';
    const REASON = 'Service end year is wrong in paragraph two — it should read 2004, not 2014. Please correct and re-sign.';

    it('delivered + PHYSICIAN -> 200 (THE Shirley Carr case: the owner recalls his own signed letter): flips to physician_review, writes the mandatory message + audit', async () => {
      mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
      const { db, spies } = makeDb(baseCase({ status: 'delivered', version: 4, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(200);
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review', version: { increment: 1 } }) }));
      // Mandatory return note written IN-TRANSACTION with the flip.
      expect(spies.caseMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: expect.stringContaining('Service end year'), senderRole: 'physician' }) }));
      // Audit row carries the billing-safety flags (delivered + not paid).
      expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        action: 'case_returned_to_physician',
        detailsJson: expect.objectContaining({ from: 'delivered', to: 'physician_review', wasPaid: false }),
      }) }));
    });

    it('delivered + OPS_STAFF -> 200 (no regression: the RN can still return a delivered letter)', async () => {
      mockUser = { sub: 'OPS-USER', email: 'ops@example.com', roles: ['ops_staff'] };
      const { db, spies } = makeDb(baseCase({ status: 'delivered', version: 4, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(200);
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review' }) }));
    });

    it('delivered + ADMIN -> 200', async () => {
      mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] };
      const { db } = makeDb(baseCase({ status: 'delivered', version: 4, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(200);
    });

    it('paid + PHYSICIAN -> 200 (the owner recalls a closed/paid letter): audit records wasPaid=true', async () => {
      mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
      const { db, spies } = makeDb(baseCase({ status: 'paid', version: 6, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 6, message: REASON });
      expect(res.status).toBe(200);
      expect(spies.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'physician_review' }) }));
      expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        detailsJson: expect.objectContaining({ from: 'paid', to: 'physician_review', wasPaid: true }),
      }) }));
    });

    it('paid + ADMIN -> 200', async () => {
      mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] };
      const { db } = makeDb(baseCase({ status: 'paid', version: 6, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 6, message: REASON });
      expect(res.status).toBe(200);
    });

    it('paid + OPS_STAFF -> 403 (an RN can NOT reopen a paid/closed case): no flip, no message', async () => {
      mockUser = { sub: 'OPS-USER', email: 'ops@example.com', roles: ['ops_staff'] };
      const { db, spies } = makeDb(baseCase({ status: 'paid', version: 6, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 6, message: REASON });
      expect(res.status).toBe(403);
      expect(spies.caseUpdate).not.toHaveBeenCalled();
      expect(spies.caseMessageCreate).not.toHaveBeenCalled();
    });

    it('empty message -> 400 (the explanation is mandatory): no flip', async () => {
      mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
      const { db, spies } = makeDb(baseCase({ status: 'delivered', version: 4, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: '   ' });
      expect(res.status).toBe(400);
      expect(spies.caseUpdate).not.toHaveBeenCalled();
    });

    it('stale version -> 409 (optimistic concurrency)', async () => {
      mockUser = { sub: 'PHYS-USER', email: 'phys@example.com', roles: ['physician'] };
      const { db } = makeDb(baseCase({ status: 'delivered', version: 5, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(409);
    });

    it('no assigned physician -> 409 (cannot return to an empty doctor queue)', async () => {
      mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] };
      const { db } = makeDb(baseCase({ status: 'delivered', version: 4, assignedPhysicianId: null }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(409);
    });

    it('a non-returnable status (rn_review) -> 409 (only delivered/paid are recallable)', async () => {
      mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] };
      const { db } = makeDb(baseCase({ status: 'rn_review', version: 4, assignedPhysicianId: 'PHYS-001' }));
      const res = await request(appFor(db)).post(RTP).send({ version: 4, message: REASON });
      expect(res.status).toBe(409);
    });
  });
});
