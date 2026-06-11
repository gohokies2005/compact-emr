/**
 * Doctor-pay route tests (plan §7 matrix J / P / Z[route] + the source-filter guarantee behind D,
 * and the §5.4 memo-tag stub). The earnings MATH is matrix-tested in pay-earnings.test.ts; these
 * tests prove the HTTP surface: self-scoping, admin gating, param hygiene, and DB query shape.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayRouter } from '../routes/pay.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

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

interface RevRow {
  id?: string;
  caseId: string;
  version: number;
  createdAt: Date;
  letterType: string;
  payCents: number | null;
  signingPhysicianId: string | null;
  source?: string;
  case: { claimedCondition: string; assignedPhysicianId: string | null; veteran: { firstName: string; lastName: string } | null };
}

function physicianRow(id: string, cognitoSub: string, createdAt = new Date('2026-04-15T19:00:00Z')) {
  return { id, cognitoSub, fullName: `Dr ${id}`, npi: '1', specialty: 'FM', medicalLicense: 'L', email: 'p@x', phone: null, signatureImageS3Key: null, credentialBlockJson: null, active: true, createdAt, updatedAt: createdAt, version: 1 };
}

function makeDb(opts: { revisions?: RevRow[]; physicians?: ReturnType<typeof physicianRow>[]; findFirstRevision?: unknown } = {}) {
  const physicians = opts.physicians ?? [physicianRow('PHYS-X', 'SUB-X')];
  const revisions = opts.revisions ?? [];
  const findMany = vi.fn(async (_args: unknown) => revisions);
  const update = vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => ({ id: a.where.id, ...a.data }));
  const findFirst = vi.fn(async (_args: unknown) => (opts.findFirstRevision === undefined ? null : opts.findFirstRevision));
  const activityCreate = vi.fn(async (_args: unknown) => ({}));
  const db = {
    letterRevision: { findMany, findFirst, update, create: vi.fn() },
    physician: {
      findUnique: vi.fn(async (a: { where?: { cognitoSub?: string; id?: string } }) => {
        if (a.where?.cognitoSub !== undefined) return physicians.find((p) => p.cognitoSub === a.where!.cognitoSub) ?? null;
        if (a.where?.id !== undefined) return physicians.find((p) => p.id === a.where!.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(),
    },
    case: { findFirst: vi.fn(async () => ({ id: 'CASE-1', veteranId: 'VET-1' })), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityLog: { create: activityCreate },
  } as unknown as AppDb;
  return { db, findMany, findFirst, update, activityCreate };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createPayRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

// One January 2026 completion for PHYS-X (Jan 10 2026, 12:00 PT = 20:00 UTC).
function janCompletion(over: Partial<RevRow> = {}): RevRow {
  return {
    caseId: 'CASE-1', version: 2, createdAt: new Date('2026-01-10T20:00:00Z'),
    letterType: 'nexus_letter', payCents: 10000, signingPhysicianId: 'PHYS-X',
    case: { claimedCondition: 'Lumbosacral strain', assignedPhysicianId: 'PHYS-X', veteran: { firstName: 'Robert', lastName: 'Testcase' } },
    ...over,
  };
}

beforeEach(() => {
  mockUser = { sub: 'SUB-X', roles: ['physician'] };
});

describe('GET /api/v1/pay/me (matrix J/P/Z + the D source filter)', () => {
  it('returns own earnings for the requested month with totals from cents', async () => {
    const { db } = makeDb({ revisions: [janCompletion()] });
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01');
    expect(res.status).toBe(200);
    expect(res.body.data.month).toBe('2026-01');
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0]).toMatchObject({
      caseId: 'CASE-1', veteranName: 'Robert Testcase', condition: 'Lumbosacral strain',
      letterType: 'nexus_letter', payCents: 10000, payUsd: 100,
    });
    expect(res.body.data.totalCents).toBe(10000);
    expect(res.body.data.totalUsd).toBe(100);
    expect(Array.isArray(res.body.data.availableMonths)).toBe(true);
  });

  it('D (filter guarantee): the DB query is pinned to source=approved_final + the snapshot-or-fallback OR shape', async () => {
    const { db, findMany } = makeDb({ revisions: [] });
    await request(appFor(db)).get('/api/v1/pay/me?month=all');
    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where.source).toBe('approved_final'); // editor_save / surgical_ai / drafter_run are invisible to pay
    expect(where.OR).toEqual([
      { signingPhysicianId: 'PHYS-X' },
      { signingPhysicianId: null, case: { assignedPhysicianId: 'PHYS-X' } },
    ]);
    // NO createdAt window — first-approval-wins dedup must see full payKey history (plan §2.3).
    expect(where.createdAt).toBeUndefined();
  });

  it('J: a physicianId query param is NEVER honored — identity always derives from the JWT', async () => {
    const { db, findMany } = makeDb({
      revisions: [janCompletion()],
      physicians: [physicianRow('PHYS-X', 'SUB-X'), physicianRow('PHYS-Y', 'SUB-Y')],
    });
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01&physicianId=PHYS-Y');
    expect(res.status).toBe(200);
    // The query was still built for PHYS-X (the JWT's physician), not the smuggled param.
    const where = (findMany.mock.calls[0]![0] as { where: { OR: unknown[] } }).where;
    expect(JSON.stringify(where)).toContain('PHYS-X');
    expect(JSON.stringify(where)).not.toContain('PHYS-Y');
  });

  it('J (defense in depth): rows the DB returns for ANOTHER physician are re-filtered out in memory', async () => {
    // Simulate a buggy/over-broad DB result: one row snapshotted to PHYS-Y leaks in.
    const { db } = makeDb({ revisions: [janCompletion(), janCompletion({ caseId: 'CASE-2', signingPhysicianId: 'PHYS-Y', case: { claimedCondition: 'Tinnitus', assignedPhysicianId: 'PHYS-Y', veteran: { firstName: 'Jane', lastName: 'Smith' } } })] });
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01');
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].caseId).toBe('CASE-1');
    expect(res.body.data.totalCents).toBe(10000);
  });

  it('M (route-level): a case reassigned to PHYS-X after PHYS-Y approved it does NOT pay PHYS-X (snapshot wins over live join)', async () => {
    const { db } = makeDb({
      revisions: [janCompletion({ signingPhysicianId: 'PHYS-Y', case: { claimedCondition: 'Lumbosacral strain', assignedPhysicianId: 'PHYS-X', veteran: { firstName: 'Robert', lastName: 'Testcase' } } })],
    });
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01');
    expect(res.body.data.rows).toHaveLength(0);
    expect(res.body.data.totalCents).toBe(0);
  });

  it('P: a physician JWT with no Physician row → 200 with $0, never a 500', async () => {
    mockUser = { sub: 'SUB-UNMAPPED', roles: ['physician'] };
    const { db, findMany } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01');
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.totalCents).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('Z (route): a month with no completions → 200, empty rows, $0 totals', async () => {
    const { db } = makeDb({ revisions: [janCompletion()] });
    const res = await request(appFor(db)).get('/api/v1/pay/me?month=2026-03');
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.totalCents).toBe(0);
    expect(res.body.data.totalUsd).toBe(0);
  });

  it('month=all returns the career aggregate (=== sum of months, matrix I at the route)', async () => {
    const { db } = makeDb({
      revisions: [
        janCompletion(),
        janCompletion({ caseId: 'CASE-2', createdAt: new Date('2026-02-10T20:00:00Z'), payCents: 5000, letterType: 'nexus_memo' }),
      ],
    });
    const all = await request(appFor(db)).get('/api/v1/pay/me?month=all');
    const jan = await request(appFor(db)).get('/api/v1/pay/me?month=2026-01');
    const feb = await request(appFor(db)).get('/api/v1/pay/me?month=2026-02');
    expect(all.body.data.totalCents).toBe(15000);
    expect(all.body.data.totalCents).toBe(jan.body.data.totalCents + feb.body.data.totalCents);
    expect(all.body.data.rows).toHaveLength(2);
  });

  it('400s on a malformed month param', async () => {
    const { db } = makeDb();
    for (const bad of ['2026-13', 'January', '2026-1']) {
      const res = await request(appFor(db)).get(`/api/v1/pay/me?month=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it('rejects ops_staff with 403 and unauthenticated with 401', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    expect((await request(appFor(db)).get('/api/v1/pay/me')).status).toBe(403);
    mockUser = undefined;
    expect((await request(appFor(db)).get('/api/v1/pay/me')).status).toBe(401);
  });
});

describe('GET /api/v1/pay/months/me (matrix Q at the route)', () => {
  it('enumerates PT months from Physician.createdAt (employment-start fallback) to now, descending', async () => {
    const { db } = makeDb(); // physician created 2026-04-15 PT
    const res = await request(appFor(db)).get('/api/v1/pay/months/me');
    expect(res.status).toBe(200);
    const months: string[] = res.body.data.months;
    expect(months[months.length - 1]).toBe('2026-04');
    expect(months).toEqual([...months].sort().reverse()); // strictly descending
    expect(months).toContain('2026-04');
  });

  it('no Physician mapping → just the current PT month (dropdown never empty)', async () => {
    mockUser = { sub: 'SUB-UNMAPPED', roles: ['physician'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/pay/months/me');
    expect(res.status).toBe(200);
    expect(res.body.data.months).toHaveLength(1);
    expect(res.body.data.months[0]).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('GET /api/v1/pay/physician/:id (matrix J admin gate)', () => {
  it('J: a PHYSICIAN calling the admin endpoint gets 403 — cross-physician access is admin-only', async () => {
    const { db } = makeDb({ physicians: [physicianRow('PHYS-X', 'SUB-X'), physicianRow('PHYS-Y', 'SUB-Y')] });
    mockUser = { sub: 'SUB-X', roles: ['physician'] };
    const res = await request(appFor(db)).get('/api/v1/pay/physician/PHYS-Y?month=2026-01');
    expect(res.status).toBe(403);
  });

  it('admin can query any physician by id (L: admin-approved letters still pay the SIGNING physician)', async () => {
    const { db } = makeDb({ revisions: [janCompletion()], physicians: [physicianRow('PHYS-X', 'SUB-X')] });
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const res = await request(appFor(db)).get('/api/v1/pay/physician/PHYS-X?month=2026-01');
    expect(res.status).toBe(200);
    expect(res.body.data.physicianId).toBe('PHYS-X');
    expect(res.body.data.totalCents).toBe(10000);
  });

  it('404s on an unknown physician id', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const res = await request(appFor(db)).get('/api/v1/pay/physician/NOPE?month=2026-01');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/letter-revisions/:id/type (memo-tag stub, plan §5.4)', () => {
  const approvedFinal = { id: 'LR-9', caseId: 'CASE-1', version: 3, source: 'approved_final', letterType: 'nexus_letter', payCents: 10000, createdAt: new Date('2026-01-10T20:00:00Z') };

  it('admin re-tags an approved_final to nexus_memo and payCents re-stamps to the memo rate AT the original completion instant', async () => {
    const { db, update, activityCreate } = makeDb({ findFirstRevision: approvedFinal });
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const res = await request(appFor(db)).patch('/api/v1/letter-revisions/LR-9/type').send({ letterType: 'nexus_memo' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ letterType: 'nexus_memo', payCents: 5000 });
    const updateArg = update.mock.calls[0]![0] as { where: { id: string }; data: Record<string, unknown> };
    expect(updateArg.where.id).toBe('LR-9');
    expect(updateArg.data).toEqual({ letterType: 'nexus_memo', payCents: 5000 });
    // Audit trail: the re-type is activity-logged with from/to.
    const logArg = (activityCreate.mock.calls[0]![0] as { data: { action: string; detailsJson: Record<string, unknown> } }).data;
    expect(logArg.action).toBe('letter_revision_type_changed');
    expect(logArg.detailsJson).toMatchObject({ from: 'nexus_letter', to: 'nexus_memo', payCents: 5000 });
  });

  it('409s on a non-completion row (guard: you cannot bill a draft save)', async () => {
    const { db } = makeDb({ findFirstRevision: { ...approvedFinal, source: 'editor_save' } });
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const res = await request(appFor(db)).patch('/api/v1/letter-revisions/LR-9/type').send({ letterType: 'nexus_memo' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('not_a_completion');
  });

  it('400s on an invalid letterType and 404s on an unknown revision', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb({ findFirstRevision: approvedFinal });
    expect((await request(appFor(db)).patch('/api/v1/letter-revisions/LR-9/type').send({ letterType: 'cover_memo' })).status).toBe(400);
    const { db: db2 } = makeDb(); // findFirst → null
    expect((await request(appFor(db2)).patch('/api/v1/letter-revisions/LR-404/type').send({ letterType: 'nexus_memo' })).status).toBe(404);
  });

  it('physicians cannot re-tag (403 — admin-only)', async () => {
    const { db } = makeDb({ findFirstRevision: approvedFinal });
    mockUser = { sub: 'SUB-X', roles: ['physician'] };
    const res = await request(appFor(db)).patch('/api/v1/letter-revisions/LR-9/type').send({ letterType: 'nexus_memo' });
    expect(res.status).toBe(403);
  });
});
