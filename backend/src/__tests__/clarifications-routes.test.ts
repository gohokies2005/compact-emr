import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClarificationsRouter } from '../routes/clarifications.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, ClarificationRecord, PhysicianRecord, Role } from '../services/db-types.js';

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

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date('2026-05-25T00:00:00.000Z');
  return {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'OSA', claimedConditions: ['OSA'], claimType: 'initial',
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: null, inServiceEvent: null,
    status: 'records', cdsVerdict: 'not_yet_run', cdsOddsPct: null, cdsRationale: null,
    assignedPhysicianId: null, assignedRnId: null, refundEligible: false, currentVersion: 0,
    createdAt: now, updatedAt: now, version: 1,
    ...overrides,
  };
}

function buildPhysician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-05-25T00:00:00.000Z');
  return {
    id: 'PHYS-001', cognitoSub: 'PHYS-SUB', fullName: 'Dr. T, DO', npi: '1', specialty: 'FM', medicalLicense: 'NV-1',
    email: 'p@x.test', phone: null, signatureImageS3Key: null, credentialBlockJson: null, active: true,
    createdAt: now, updatedAt: now, version: 1, ...overrides,
  };
}

function makeDb(c: CaseRecord = baseCase(), opts: { physiciansBySub?: Record<string, PhysicianRecord> } = {}) {
  const store = new Map<string, ClarificationRecord>();
  let seq = 1;
  const physiciansBySub = opts.physiciansBySub ?? {};

  const tx = {
    case: { findFirst: vi.fn(async () => c), findUnique: vi.fn(async () => c), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    physician: {
      findUnique: vi.fn(async (args: { where?: { cognitoSub?: string } }) => {
        const sub = args.where?.cognitoSub;
        if (!sub) return null;
        return physiciansBySub[sub] ?? null;
      }),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
    },
    activityLog: { create: vi.fn(async () => ({})) },
    clarification: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => store.get(args.where.id) ?? null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const cid = args.where?.['caseId'];
        const status = args.where?.['status'];
        return [...store.values()].filter((r) => (cid === undefined || r.caseId === cid) && (status === undefined || r.status === status));
      }),
      create: vi.fn(async (args: { data: { caseId: string; raisedBy: string; audience: ClarificationRecord['audience']; question: string; status: ClarificationRecord['status'] } }) => {
        const id = `CLAR-${seq++}`;
        const now = new Date();
        const row: ClarificationRecord = { id, ...args.data, resolution: null, resolvedBy: null, resolvedAt: null, createdAt: now, updatedAt: now, version: 1 };
        store.set(id, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<ClarificationRecord> & { version?: { increment: number } } }) => {
        const current = store.get(args.where.id);
        if (!current) throw new Error('missing clarification');
        const next: ClarificationRecord = {
          ...current,
          ...args.data,
          version: typeof args.data.version === 'object' ? current.version + 1 : current.version,
        } as ClarificationRecord;
        store.set(args.where.id, next);
        return next;
      }),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, store, tx };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createClarificationsRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('clarifications routes', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  it('POST creates a clarification + activity row', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({
      audience: 'veteran',
      question: 'Need the most recent pulmonology note (within 12 months).',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ audience: 'veteran', question: expect.stringContaining('pulmonology'), status: 'open' });
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'clarification_raised' }) }));
  });

  it('POST rejects unknown audience with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'random', question: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('POST rejects empty question with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST returns 404 for missing case', async () => {
    const { db } = makeDb();
    (db.case.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db)).post('/api/v1/cases/NOPE/clarifications').send({ audience: 'physician', question: 'q' });
    expect(res.status).toBe(404);
  });

  it('GET lists clarifications newest first and respects status filter', async () => {
    const { db } = makeDb();
    await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'veteran', question: 'q1' });
    await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: 'q2' });

    const listAll = await request(appFor(db)).get('/api/v1/cases/CASE-1/clarifications');
    expect(listAll.status).toBe(200);
    expect(listAll.body.data).toHaveLength(2);

    const listOpen = await request(appFor(db)).get('/api/v1/cases/CASE-1/clarifications?status=open');
    expect(listOpen.body.data).toHaveLength(2);

    const listResolved = await request(appFor(db)).get('/api/v1/cases/CASE-1/clarifications?status=resolved');
    expect(listResolved.body.data).toHaveLength(0);
  });

  it('PATCH /clarifications/:id/resolve flips status to resolved and records resolver', async () => {
    const { db, store, tx } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-001' }), {
      physiciansBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: 'q' });
    const id = post.body.data.id;
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const res = await request(appFor(db)).patch(`/api/v1/clarifications/${id}/resolve`).send({ status: 'resolved', resolution: 'Recommended VBA route' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'resolved', resolution: 'Recommended VBA route', resolvedBy: 'PHYS-SUB' });
    expect(store.get(id)?.status).toBe('resolved');
    expect(tx.activityLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'clarification_resolved' }) }));
  });

  it('PATCH allows dismissal with no resolution body', async () => {
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'ops_staff', question: 'q' });
    const id = post.body.data.id;
    const res = await request(appFor(db)).patch(`/api/v1/clarifications/${id}/resolve`).send({ status: 'dismissed' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('dismissed');
    expect(res.body.data.resolution).toBeNull();
  });

  it('PATCH conflicts (409) when clarification already resolved', async () => {
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'ops_staff', question: 'q' });
    const id = post.body.data.id;
    await request(appFor(db)).patch(`/api/v1/clarifications/${id}/resolve`).send({ status: 'resolved' });
    const second = await request(appFor(db)).patch(`/api/v1/clarifications/${id}/resolve`).send({ status: 'dismissed' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });

  it('PATCH 404 for missing clarification id', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/clarifications/NOPE/resolve').send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });

  // ===== Phase 5.1 auth-gap closure (architect QA REVIEW.md ¶4 finding 3) =====

  it('POST is forbidden for physician not assigned to the case (403)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }), {
      physiciansBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: 'q' });
    expect(res.status).toBe(403);
  });

  it('GET is forbidden for physician not assigned to the case (403)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }), {
      physiciansBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/clarifications');
    expect(res.status).toBe(403);
  });

  it('PATCH resolve is forbidden for physician not assigned to the case (403)', async () => {
    // First raise a clarification as ops_staff so the row exists.
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }), {
      physiciansBySub: { 'PHYS-SUB': buildPhysician({ id: 'PHYS-001', cognitoSub: 'PHYS-SUB' }) },
    });
    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: 'q' });
    const id = post.body.data.id;

    // Now an unrelated physician (mapped to PHYS-001 but case assigned to PHYS-OTHER) tries to resolve.
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const res = await request(appFor(db)).patch(`/api/v1/clarifications/${id}/resolve`).send({ status: 'resolved' });
    expect(res.status).toBe(403);
  });

  it('admin and ops_staff retain unrestricted access regardless of physician assignment', async () => {
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-OTHER' }));

    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const adminRes = await request(appFor(db)).post('/api/v1/cases/CASE-1/clarifications').send({ audience: 'physician', question: 'admin sees all' });
    expect(adminRes.status).toBe(201);

    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    const opsRes = await request(appFor(db)).get('/api/v1/cases/CASE-1/clarifications');
    expect(opsRes.status).toBe(200);
  });
});
