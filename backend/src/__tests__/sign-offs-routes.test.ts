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
    previouslyDenied: false,
    priorDenialReason: null,
    priorDecisionDate: null,
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    veteranStatement: null,
    inServiceEvent: null,
    status: 'physician_review',
    cdsVerdict: 'accept',
    cdsOddsPct: 89.2,
    cdsRationale: null,
    assignedPhysicianId: 'PHYS-001',
    assignedRnId: null,
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
    credentialBlockJson: null,
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
  const signOffCreate = vi.fn(async (args: { data: { caseId: string; physicianId: string; answersJson: Record<string, unknown>; notes: string | null; signedVersion?: number | null; signedContentSha256?: string | null; chartReadinessOverridden?: boolean; chartReadinessOverrideReason?: string | null; chartReadinessOverrideFiles?: unknown } }) => {
    const now = new Date();
    const d = args.data as typeof args.data;
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
      signedVersion: d.signedVersion ?? null,
      signedContentSha256: d.signedContentSha256 ?? null,
      chartReadinessOverridden: d.chartReadinessOverridden ?? false,
      chartReadinessOverrideReason: d.chartReadinessOverrideReason ?? null,
      chartReadinessOverrideFiles: d.chartReadinessOverrideFiles ?? null,
    };
    signOffs.unshift(row);
    return row;
  });
  const signOffFindFirst = vi.fn(async (args: { where?: { caseId?: string; chartReadinessOverridden?: boolean } }) => {
    const cid = args.where?.caseId;
    const wantOverride = args.where?.chartReadinessOverridden;
    let rows = cid === undefined ? signOffs : signOffs.filter((s) => s.caseId === cid);
    if (wantOverride === true) rows = rows.filter((s) => s.chartReadinessOverridden === true);
    return rows[0] ?? null;
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
    signOff: { findUnique: vi.fn(async () => null), findFirst: signOffFindFirst, findMany: signOffFindMany, create: signOffCreate },
    // Phase 5.2: OCR HARD-STOP gate. Tests run with no uploaded files (readiness vacuously ready).
    fileReadStatus: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    // CLM-4DACAF4A80 (2026-06-14): the readiness gate now reconciles file_read_status rows against
    // the chart's documents. DEFAULT mirrors fileReadStatus — every read-status row is treated as a
    // LIVE document (filePath===s3Key) so a blocking row still blocks (existing tests keep meaning).
    // An ORPHAN test overrides document.findMany to return [] (or a different key) — that row is then
    // dropped by the reconcile and must NOT block.
    document: {
      findMany: vi.fn(async () => {
        const rows = (await tx.fileReadStatus.findMany()) as readonly { filePath: string }[];
        return rows.map((r) => ({ s3Key: r.filePath }));
      }),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, signOffs, spies: { caseFindFirst, physicianFindUnique, activityLogCreate, signOffCreate, signOffFindMany, signOffFindFirst } };
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
      signedVersion: null, signedContentSha256: null,
      chartReadinessOverridden: false, chartReadinessOverrideReason: null, chartReadinessOverrideFiles: null,
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

  // ── Chart-readiness machine-read gate OVERRIDE (CLM-4DACAF4A80, 2026-06-14) ──

  // A blocking file with a real machine-read note so the descriptive message has a reason to name.
  function blockingFileRow(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      id: 'FRS-blocking', caseId: 'CASE-1',
      filePath: 'cases/CASE-1/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf', fileSha256: 'a'.repeat(64),
      terminalStatus: 'manual_summary_required',
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 0, corruptedTokenRatio: 0, attemptedAt: now.toISOString(), note: 'empty (0 words)' }],
      manualSummary: null, manualSummaryAt: null, manualSummaryBy: null,
      lastCheckedAt: now, createdAt: now, updatedAt: now, version: 1,
      ...overrides,
    };
  }

  it('(e) the descriptive 409 names the blocking file + its machine-read reason', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb();
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { records_reviewed: true } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
    // Names the human filename (uuid stripped) AND the reason — never the old cryptic message.
    expect(res.body.error.message).toContain('Sleep_Study.pdf');
    expect(res.body.error.message).toContain('empty (0 words)');
    expect(res.body.error.message).not.toContain('chart-readiness gate failed');
    // Structured blockingFiles still ride in details (the frontend renders the override control from them).
    expect(res.body.error.details.blockingFiles).toHaveLength(1);
    expect(res.body.error.details.overridable).toBe(true);
  });

  it('(a) physician override with a reason ALLOWS the sign-off + persists the override fields + logs it', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db, spies } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-001' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    const res = await request(appFor(db))
      .post('/api/v1/cases/CASE-1/sign-off')
      .send({ answers: { records_reviewed: true }, overrideChartReadiness: true, chartReadinessOverrideReason: 'I reviewed the sleep study in person; it is legible.' });
    expect(res.status).toBe(201);
    // Persisted on the row.
    const created = spies.signOffCreate.mock.calls[0]?.[0]?.data;
    expect(created.chartReadinessOverridden).toBe(true);
    expect(created.chartReadinessOverrideReason).toBe('I reviewed the sleep study in person; it is legible.');
    expect(created.chartReadinessOverrideFiles).toHaveLength(1);
    // Logged under the dedicated override action.
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'case_signed_off_chart_readiness_overridden' }),
    }));
  });

  it('(b) override WITHOUT a reason is REJECTED (stays the descriptive 409)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db, spies } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-001' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    const res = await request(appFor(db))
      .post('/api/v1/cases/CASE-1/sign-off')
      .send({ answers: { records_reviewed: true }, overrideChartReadiness: true, chartReadinessOverrideReason: '   ' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
    expect(spies.signOffCreate).not.toHaveBeenCalled();
  });

  it('ORPHANED readiness row (file not in the chart documents) does NOT block sign-off (CLM-4DACAF4A80)', async () => {
    // Wayne Moseley class: a manual_summary_required row whose filePath is no longer among the case's
    // documents (a deleted/superseded final-letter PDF) is INVISIBLE in the UI but, evaluated raw,
    // still hard-blocked sign-off. Reconcile drops it → sign-off proceeds (201).
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db, spies } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-001' }), {
      physicianBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      blockingFileRow({ id: 'FRS-orphan', filePath: 'cases/CASE-1/deleted-final-letter.pdf' }),
    ]);
    // The chart no longer has that document (the file was deleted) → empty live-key set for the orphan.
    (db.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { records_reviewed: true } });
    expect(res.status).toBe(201);
    // It passed the gate WITHOUT an override (the orphan was reconciled away, not overridden).
    const created = spies.signOffCreate.mock.calls[0]?.[0]?.data;
    expect(created.chartReadinessOverridden).toBe(false);
  });

  it('a REAL unread row whose file IS a live chart document STILL blocks sign-off (CLM-4DACAF4A80)', async () => {
    // Control for the orphan test: when the blocking file is a genuine live document, the gate holds.
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb();
    const row = blockingFileRow();
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
    // The file IS in the chart's documents (live key matches the blocking row's filePath).
    (db.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ s3Key: row.filePath }]);
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/sign-off').send({ answers: { records_reviewed: true } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
  });

  it('(c) a non-signing role cannot override (ops_staff is 403 at the route gate)', async () => {
    // ops_staff is barred from POST /sign-off entirely (requireRole) — the override is only ever
    // reachable by a signing role, so a non-physician/non-admin can never override.
    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    (db.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    const res = await request(appFor(db))
      .post('/api/v1/cases/CASE-1/sign-off')
      .send({ answers: { records_reviewed: true }, overrideChartReadiness: true, chartReadinessOverrideReason: 'trying to override' });
    expect(res.status).toBe(403);
  });
});
