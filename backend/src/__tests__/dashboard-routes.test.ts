import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardRouter } from '../routes/dashboard.js';
import { pacificDayStartUtc } from '../services/pacific-day.js';
import type { AppDb, Role } from '../services/db-types.js';

// D1 dashboard, 2026-06-13. Mocks the AppDb facade (count/findMany only — the facade has no groupBy)
// and asserts each tile's count + filter contract, the Pacific-midnight boundary (computed via the
// shared TZ helper, NOT a hardcoded offset), the non-clickable turnaround tile, and role-gating.

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

// A count() that resolves a value picked by inspecting the `where` it was called with — so one mock
// delegate can answer every distinct tile query and we can assert it was filtered correctly.
type WhereMatcher = { match: (where: Record<string, unknown>) => boolean; value: number };
function countByWhere(matchers: WhereMatcher[], fallback = 0) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (args: unknown) => {
    const where = ((args as { where?: Record<string, unknown> })?.where ?? {}) as Record<string, unknown>;
    calls.push(where);
    for (const m of matchers) if (m.match(where)) return m.value;
    return fallback;
  });
  return { fn, calls };
}

interface DbHandles {
  intakeCount: ReturnType<typeof countByWhere>;
  caseCount: ReturnType<typeof countByWhere>;
  draftJobCount: ReturnType<typeof countByWhere>;
  veteranCount: ReturnType<typeof countByWhere>;
  intakeFindMany: ReturnType<typeof vi.fn>;
}

function makeDb(opts?: {
  assignedIntakes?: Array<{ webhookReceivedAt: Date | null; assignedAt: Date | null }>;
}): { db: AppDb; h: DbHandles } {
  // Distinct sentinel values so a tile that reads the wrong query is caught.
  const intakeCount = countByWhere([
    // tile 1: createdAt.gte present (since Pacific midnight)
    { match: (w) => 'createdAt' in w && typeof w.createdAt === 'object' && w.createdAt !== null && 'gte' in (w.createdAt as object), value: 11 },
    // tile 7: status pending + createdAt.lt (older than 7d)
    { match: (w) => w.status === 'pending' && typeof w.createdAt === 'object' && w.createdAt !== null && 'lt' in (w.createdAt as object), value: 7 },
  ]);
  const caseCount = countByWhere([
    // tile 3: RN-review group (status.in array of 4)
    { match: (w) => isStatusIn(w, ['rn_review', 'needs_rn_decision', 'correction_requested', 'correction_review']), value: 33 },
    // tile 4: pre-draft group (status.in [intake, viability])
    { match: (w) => isStatusIn(w, ['intake', 'viability']), value: 44 },
    // tile 5: rn_review (single)
    { match: (w) => w.status === 'rn_review', value: 5 },
    // tile 6: physician_review (single)
    { match: (w) => w.status === 'physician_review', value: 6 },
    // tile 8: delinquent payments (delivered + payments.none paid)
    { match: (w) => w.status === 'delivered' && 'payments' in w, value: 8 },
  ]);
  const draftJobCount = countByWhere([
    { match: (w) => w.state === 'running', value: 9 }, // tile 9
  ]);
  const veteranCount = countByWhere([
    { match: (w) => w.inactive === false, value: 100 }, // tile 10
  ]);
  const intakeFindMany = vi.fn(async () => opts?.assignedIntakes ?? []);

  const db = {
    intake: { count: intakeCount.fn, findMany: intakeFindMany },
    case: { count: caseCount.fn },
    draftJob: { count: draftJobCount.fn },
    veteran: { count: veteranCount.fn },
  } as unknown as AppDb;

  return { db, h: { intakeCount, caseCount, draftJobCount, veteranCount, intakeFindMany } };
}

function isStatusIn(where: Record<string, unknown>, expected: string[]): boolean {
  const s = where.status as { in?: unknown } | undefined;
  if (s === undefined || s === null || typeof s !== 'object' || !Array.isArray(s.in)) return false;
  const got = [...(s.in as string[])].sort();
  const want = [...expected].sort();
  return got.length === want.length && got.every((v, i) => v === want[i]);
}

function buildApp(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { user?: MockUser }, _res, next) => { req.user = mockUser; next(); });
  app.use('/api/v1', createDashboardRouter(db));
  return app;
}

function tileByKey(body: { tiles: Array<{ key: string }> }, key: string) {
  return body.tiles.find((t) => t.key === key) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  mockUser = { sub: 'admin-sub', roles: ['admin'] };
});

describe('GET /api/v1/reports/dashboard', () => {
  it('returns every tile with its count and filter contract', async () => {
    const { db } = makeDb();
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(200);
    const body = res.body as { tiles: Array<{ key: string }>; timezone: string; pacificMidnightUtc: string };

    expect(body.timezone).toBe('America/Los_Angeles');
    expect(body.tiles).toHaveLength(10);

    expect(tileByKey(body, 'new_intakes_today')).toMatchObject({
      count: 11,
      clickable: true,
      filter: { kind: 'intakes', createdSince: body.pacificMidnightUtc },
    });
    expect(tileByKey(body, 'rn_queue')).toMatchObject({
      count: 33,
      clickable: true,
      filter: { kind: 'cases', statuses: ['rn_review', 'needs_rn_decision', 'correction_requested', 'correction_review'] },
    });
    expect(tileByKey(body, 'pre_draft')).toMatchObject({
      count: 44,
      clickable: true,
      filter: { kind: 'cases', statuses: ['intake', 'viability'] },
    });
    expect(tileByKey(body, 'rn_review')).toMatchObject({ count: 5, clickable: true, filter: { kind: 'cases', status: 'rn_review' } });
    expect(tileByKey(body, 'physician_review')).toMatchObject({ count: 6, clickable: true, filter: { kind: 'cases', status: 'physician_review' } });
    expect(tileByKey(body, 'delinquent_intakes')).toMatchObject({ count: 7, clickable: true, filter: { kind: 'intakes', status: 'pending', olderThanDays: 7 } });
    expect(tileByKey(body, 'delinquent_payments')).toMatchObject({ count: 8, clickable: true, filter: { kind: 'cases', status: 'delivered', unpaidLetter500OlderThanDays: 3 } });
    expect(tileByKey(body, 'stuck_drafts')).toMatchObject({ count: 9, clickable: true, filter: { kind: 'draft-jobs', stuck: true, startedBeforeMinutes: 45, staleHeartbeat: true } });
    expect(tileByKey(body, 'total_veterans')).toMatchObject({ count: 100, clickable: true, filter: { kind: 'veterans' } });
  });

  it('computes the today boundary via the Pacific-midnight TZ helper, not a hardcoded UTC offset', async () => {
    const { db, h } = makeDb();
    const before = Date.now();
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    const after = Date.now();
    expect(res.status).toBe(200);

    // The response's pacificMidnightUtc must equal the helper's output for "now" — and must NOT be a
    // naive UTC midnight (Date with 00:00:00.000Z) unless Pacific midnight genuinely coincides.
    const reported = new Date((res.body as { pacificMidnightUtc: string }).pacificMidnightUtc);
    const expectedLo = pacificDayStartUtc(new Date(before));
    const expectedHi = pacificDayStartUtc(new Date(after));
    // before/after bracket the request; same Pacific day in all realistic cases → identical instants.
    expect([expectedLo.getTime(), expectedHi.getTime()]).toContain(reported.getTime());

    // The intake "today" count must have been issued with createdAt.gte === that Pacific midnight,
    // proving the boundary flowed into the query (not a separate hardcoded value).
    const todayCall = h.intakeCount.calls.find((w) => 'createdAt' in w && (w.createdAt as { gte?: unknown }).gte !== undefined);
    expect(todayCall).toBeDefined();
    const gte = (todayCall!.createdAt as { gte: Date }).gte;
    expect(new Date(gte).getTime()).toBe(reported.getTime());

    // Pacific midnight is offset from UTC by 7 or 8 hours → never lands on a UTC-midnight wall clock.
    // (Asserting it's NOT UTC midnight catches a regression to `new Date().setUTCHours(0,0,0,0)`.)
    expect(reported.getUTCHours()).toBeGreaterThanOrEqual(7);
    expect(reported.getUTCHours()).toBeLessThanOrEqual(8);
  });

  it('tile 2 (Stage-1 turnaround) is the only non-clickable tile and averages assigned intakes', async () => {
    const now = Date.now();
    const { db } = makeDb({
      assignedIntakes: [
        { webhookReceivedAt: new Date(now - 4 * 60 * 60 * 1000), assignedAt: new Date(now - 2 * 60 * 60 * 1000) }, // 2h
        { webhookReceivedAt: new Date(now - 10 * 60 * 60 * 1000), assignedAt: new Date(now - 6 * 60 * 60 * 1000) }, // 4h
        { webhookReceivedAt: null, assignedAt: new Date(now) }, // skipped (dirty)
      ],
    });
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(200);
    const body = res.body as { tiles: Array<{ key: string; clickable: boolean }> };

    const nonClickable = body.tiles.filter((t) => !t.clickable);
    expect(nonClickable).toHaveLength(1);
    expect(nonClickable[0].key).toBe('stage1_turnaround_7d');

    const tile = tileByKey(body, 'stage1_turnaround_7d')!;
    expect(tile.unit).toBe('hours');
    expect(tile.value).toBe(3); // (2 + 4) / 2
    expect(tile.reason).toBeUndefined();
  });

  it('tile 2 returns null + a reason when no intakes were assigned in the window', async () => {
    const { db } = makeDb({ assignedIntakes: [] });
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(200);
    const tile = tileByKey(res.body as { tiles: Array<{ key: string }> }, 'stage1_turnaround_7d')!;
    expect(tile.value).toBeNull();
    expect(typeof tile.reason).toBe('string');
    expect((tile.reason as string).length).toBeGreaterThan(0);
  });

  it('rejects an unauthenticated request (401)', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(401);
  });

  it('rejects a physician (403) — the ops dashboard is admin/ops_staff only', async () => {
    mockUser = { sub: 'phys-sub', roles: ['physician'] };
    const { db } = makeDb();
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(403);
  });

  it('allows ops_staff (200)', async () => {
    mockUser = { sub: 'ops-sub', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(buildApp(db)).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(200);
  });
});
