import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignOffsRouter } from '../routes/sign-offs.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, PhysicianRecord, Role, SignOffRecord } from '../services/db-types.js';

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
  const now = new Date('2026-05-25T00:00:00.000Z');
  return {
    id: 'CASE-1',
    veteranId: 'VET-1',
    claimedCondition: 'Obstructive sleep apnea',
    claimedConditions: ['Obstructive sleep apnea'],
    claimType: 'initial',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    veteranStatement: null,
    inServiceEvent: null,
    status: 'physician_review',
    cdsVerdict: 'accept',
    cdsOddsPct: 89.2,
    cdsRationale: null,
    assignedPhysicianId: 'PHYS-001',
    refundEligible: false,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    version: 3,
    ...overrides,
  };
}

function buildPhysician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-05-25T00:00:00.000Z');
  return {
    id: 'PHYS-001',
    cognitoSub: 'PHYS-SUB',
    fullName: 'Dr. Test, DO',
    npi: '1111111111',
    specialty: 'Family Medicine',
    medicalLicense: 'NV-DO0001',
    email: 'phys@example.test',
    phone: null,
    signatureImageS3Key: null,
    active: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function makeDb(initialCase: CaseRecord = baseCase(), opts: { physicianBySub?: Record<string, PhysicianRecord>; initialSignOffs?: SignOffRecord[] } = {}) {
  let nextId = 1;
  const signOffs: SignOffRecord[] = [...(opts.initialSignOffs ?? [])];
  const physiciansBySub = opts.physicianBySub ?? {};

  const caseFindFirst = vi.fn(async () => initialCase);
  const physicianFindUnique = vi.fn(async (args: { where?: { cognitoSub?: string } }) => {
    const sub = args.where?.cognitoSub;
    if (!sub) return null;
    return physiciansBySub[sub] ?? null;
  });
  const activityLogCreate = vi.fn(async () => ({}));
  const signOffCreate = vi.fn(async (args: { data: { caseId: string; physicianId: string; answersJson: Record<string, unknown>; notes: string | null } }) => {
    const now = new Date();
    const row: SignOffRecord = {
      id: `SO-${nextId++}`,
      caseId: args.data.caseId,
      physicianId: args.data.physicianId,
      signedAt: now,
      answersJson: args.data.answersJson,
      notes: args.data.notes,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    signOffs.unshift(row);
    return row;
  });
  const signOffFindMany = vi.fn(async (args: { where?: { caseId?: string } }) => {
    const cid = args.where?.caseId;
    if (cid === undefined) return signOffs;
    return signOffs.filter((s) => s.caseId === cid);
  });

  const tx = {
    case: { findFirst: caseFindFirst, findUnique: caseFindFirst, findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    physician: { findUnique: physicianFindUnique, findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
    activityLog: { create: activityLogCreate },
    signOff: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), findMany: signOffFindMany, create: signOffCreate },
    // Phase 5.2: OCR HARD-STOP gate. Tests run with no uploaded files (readiness vacuously ready).
    fileReadStatus: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, signOffs, spies: { caseFindFirst, physicianFindUnique, activityLogCreate, signOffCreate, signOffFindMany } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createSignOffsRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) {
      return sendError(res, error.status, error.code, error.message, error.details);
    }
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('sign-offs routes', () => {
  beforeEach(() => { mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] }; });

  it('rejects ops_staff on POST /cases/:id/sign-off with 403', async () => {
    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { confirmed_records_reviewed: true } });
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated with 401', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { x: true } });
    expect(res.status).toBe(401);
  });

  it('rejects missing answers with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects non-boolean answer value with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { q1: 'yes' } });
    expect(res.status).toBe(400);
  });

  it('rejects >10 answer entries with 400', async () => {
    const { db } = makeDb();
    const tooMany: Record<string, boolean> = {};
    for (let i = 0; i < 11; i++) tooMany[`q${i}`] = true;
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: tooMany });
    expect(res.status).toBe(400);
  });

  it('rejects 404 when case is missing', async () => {
    const { db } = makeDb();
    // Override caseFindFirst to return null.
    (db.case.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db)).post('/api/v1/cases/NOPE/sign-off').send({ answers: { q1: true } });
    expect(res.status).toBe(404);
  });

  it('admin signs off on behalf of an assigned physician (201)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/cases/CASE-1/sign-off')
      .send({ answers: { records_reviewed: true, no_phi_in_filename: true }, notes: 'Looks good' });
    expect(res.status).toBe(201);
    expect(res.body.data.physicianId).toBe('PHYS-001');
    expect(res.body.data.answersJson).toEqual({ records_reviewed: true, no_phi_in_filename: true });
    expect(res.body.data.notes).toBe('Looks good');
    expect(spies.signOffCreate).toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'case_signed_off' }) }));
  });

  it('admin sign-off conflicts (409) when case has no assigned physician', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: null }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { q1: true } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('physician with valid mapping + assignment signs off (201)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-001' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { records_reviewed: true } });
    expect(res.status).toBe(201);
    expect(res.body.data.physicianId).toBe('PHYS-001');
  });

  it('physician without Physician mapping is forbidden (403)', async () => {
    mockUser = { sub: 'PHYS-SUB-X', roles: ['physician'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { q1: true } });
    expect(res.status).toBe(403);
  });

  it('physician not assigned to the case is forbidden (403)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { q1: true } });
    expect(res.status).toBe(403);
  });

  it('GET /cases/:id/sign-offs returns latest-first list for ops_staff', async () => {
    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    const now = new Date();
    const initial: SignOffRecord = {
      id: 'SO-0', caseId: 'CASE-1', physicianId: 'PHYS-001', signedAt: now,
      answersJson: { q1: true }, notes: null, createdAt: now, updatedAt: now, version: 1,
    };
    const { db } = makeDb(baseCase(), { initialSignOffs: [initial] });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/sign-offs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('SO-0');
  });

  it('GET /cases/:id/sign-offs is forbidden for non-assigned physician', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/sign-offs');
    expect(res.status).toBe(403);
  });

  it('POST sign-off is BLOCKED (409 chart_not_ready) when a file is manual_summary_required', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb();
    // Inject a blocking file row into the fileReadStatus delegate for this case.
    const now = new Date();
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: 'FRS-blocking', caseId: 'CASE-1', filePath: 'records/garbled.pdf', fileSha256: 'a'.repeat(64),
      terminalStatus: 'manual_summary_required', attemptsJson: [], manualSummary: null,
      manualSummaryAt: null, manualSummaryBy: null, lastCheckedAt: now, createdAt: now, updatedAt: now, version: 1,
    }]);
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { q1: true } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
  });
});
