import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChartNotesRouter } from '../routes/chart-notes.js';
import type { AppDb, ChartNoteRecord, Role } from '../services/db-types.js';

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

function note(overrides: Partial<ChartNoteRecord> = {}): ChartNoteRecord {
  return { id: 'NOTE-1', veteranId: 'VET-1', body: 'baseline note', createdBy: 'USER-1', isQuickNote: false, createdAt: new Date('2026-05-24T00:00:00.000Z'), updatedAt: new Date('2026-05-24T00:00:00.000Z'), version: 1, ...overrides };
}

function makeDb(initial: ChartNoteRecord = note()) {
  let current = { ...initial };
  const chartNoteFindMany = vi.fn(async () => [current]);
  // findFirst echoes the per-call args so the latest-quick endpoint's where:{isQuickNote} is honored in the
  // mock: when the current row is NOT a quick note, a quick-note query resolves to null.
  const chartNoteFindFirst = vi.fn(async (args?: { where?: { isQuickNote?: boolean } }) => {
    if (args?.where?.isQuickNote === true && current.isQuickNote !== true) return null;
    return current;
  });
  const chartNoteCreate = vi.fn(async (args: { data: Partial<ChartNoteRecord> }) => { current = note({ ...args.data, version: 1 }); return current; });
  const chartNoteUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => { current = { ...current, ...args.data, version: current.version + 1 } as ChartNoteRecord; return current; });
  const chartNoteDelete = vi.fn(async () => current);
  const veteranFindUnique = vi.fn(async () => ({ id: 'VET-1' }));
  // The shared resolver batches by cognitoSub; echo only the subs it asks for so an unknown author
  // (e.g. a sub with no account) resolves to the neutral "Staff" fallback, not a UUID.
  const appUserFindMany = vi.fn(async (args?: { where?: { cognitoSub?: { in?: string[] } } }) => {
    const wanted = args?.where?.cognitoSub?.in ?? [];
    const pool = [
      { cognitoSub: 'OPS', name: 'Jane Ops', email: 'jane@example.com' },
      { cognitoSub: 'USER-1', name: 'Jane Ops', email: 'jane@example.com' },
    ];
    return pool.filter((u) => wanted.includes(u.cognitoSub));
  });
  // Physician directory (the resolver also checks here — a physician-authored note must resolve too).
  const physicianFindMany = vi.fn(async (args?: { where?: { cognitoSub?: { in?: string[] } } }) => {
    const wanted = args?.where?.cognitoSub?.in ?? [];
    const pool = [{ cognitoSub: 'PHYS', fullName: 'Dr. Alice Stone' }];
    return pool.filter((p) => wanted.includes(p.cognitoSub));
  });
  const activityLogCreate = vi.fn(async () => ({}));
  const tx = {
    chartNote: { findMany: chartNoteFindMany, findFirst: chartNoteFindFirst, create: chartNoteCreate, update: chartNoteUpdate, delete: chartNoteDelete },
    veteran: { findUnique: veteranFindUnique },
    appUser: { findMany: appUserFindMany },
    physician: { findMany: physicianFindMany },
    activityLog: { create: activityLogCreate },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, spies: { chartNoteFindMany, chartNoteFindFirst, chartNoteCreate, chartNoteUpdate, chartNoteDelete, activityLogCreate } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createChartNotesRouter(db));
  return app;
}

describe('chart-notes routes', () => {
  beforeEach(() => { mockUser = { sub: 'USER-1', roles: ['admin'] }; });

  it('returns 401 unauthenticated', async () => {
    mockUser = undefined;
    const res = await request(appFor(makeDb().db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(res.status).toBe(401);
  });

  it('lets a physician READ + CREATE chart notes (to leave a note when sending a letter back), but not edit', async () => {
    mockUser = { sub: 'PHYS', roles: ['physician'] };
    const get = await request(appFor(makeDb().db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(get.status).toBe(200);
    const patch = await request(appFor(makeDb().db)).patch('/api/v1/chart-notes/N1').send({ body: 'x' });
    expect(patch.status).toBe(403); // edit/delete stay admin/ops-only
  });

  it('lists notes for a veteran', async () => {
    const res = await request(appFor(makeDb().db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('resolves the author to a NAME (not a UUID) for an ops_staff-authored note', async () => {
    const res = await request(appFor(makeDb(note({ createdBy: 'OPS' })).db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(res.status).toBe(200);
    expect(res.body.data[0].createdByName).toBe('Jane Ops');
    expect(res.body.data[0].createdByName).not.toBe('OPS');
  });

  it('resolves a PHYSICIAN-authored note via the physician directory (the old leak)', async () => {
    const res = await request(appFor(makeDb(note({ createdBy: 'PHYS' })).db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(res.status).toBe(200);
    expect(res.body.data[0].createdByName).toBe('Dr. Alice Stone');
  });

  it('falls back to "Staff" for an unknown author sub — NEVER the raw UUID', async () => {
    const res = await request(appFor(makeDb(note({ createdBy: 'deadbeef-uuid-not-an-account' })).db)).get('/api/v1/veterans/VET-1/chart-notes');
    expect(res.status).toBe(200);
    expect(res.body.data[0].createdByName).toBe('Staff');
    expect(res.body.data[0].createdByName).not.toContain('deadbeef');
  });

  it('creates a note with createdBy from the JWT sub and writes activity', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/chart-notes').send({ body: 'spoke with veteran' });
    expect(res.status).toBe(201);
    expect(spies.chartNoteCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ createdBy: 'OPS', veteranId: 'VET-1' }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'chart_note_created' }) }));
  });

  it('rejects empty body with 400', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/veterans/VET-1/chart-notes').send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  // ---- Quick notes: flagged entries in the SAME stream (Ryan 2026-06-21) ----

  it('creates a QUICK note with isQuickNote=true persisted + a quick_note_created activity', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/chart-notes').send({ body: 'Awaiting records', isQuickNote: true });
    expect(res.status).toBe(201);
    expect(res.body.data.isQuickNote).toBe(true);
    expect(spies.chartNoteCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isQuickNote: true, veteranId: 'VET-1' }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'quick_note_created' }) }));
  });

  it('defaults isQuickNote to false when omitted (ordinary staff note)', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/chart-notes').send({ body: 'a normal note' });
    expect(res.status).toBe(201);
    expect(spies.chartNoteCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isQuickNote: false }) }));
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'chart_note_created' }) }));
  });

  it('rejects a non-boolean isQuickNote with 400', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/veterans/VET-1/chart-notes').send({ body: 'x', isQuickNote: 'yes' });
    expect(res.status).toBe(400);
  });

  it('latest-quick returns the most-recent quick note (desc by createdAt) with a resolved author name', async () => {
    const { db, spies } = makeDb(note({ id: 'Q1', body: 'newest quick', isQuickNote: true, createdBy: 'OPS' }));
    const res = await request(appFor(db)).get('/api/v1/veterans/VET-1/chart-notes/latest-quick');
    expect(res.status).toBe(200);
    expect(res.body.data.body).toBe('newest quick');
    expect(res.body.data.isQuickNote).toBe(true);
    expect(res.body.data.createdByName).toBe('Jane Ops');
    // It must query for quick notes only, newest first.
    expect(spies.chartNoteFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isQuickNote: true }), orderBy: { createdAt: 'desc' } }));
  });

  it('latest-quick returns null when the veteran has no quick note', async () => {
    // current row is an ordinary note (isQuickNote=false) → the quick-only query resolves to null.
    const res = await request(appFor(makeDb().db)).get('/api/v1/veterans/VET-1/chart-notes/latest-quick');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('lets the author (ops_staff) edit their own note', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db, spies } = makeDb(note({ createdBy: 'OPS', version: 1 }));
    const res = await request(appFor(db)).patch('/api/v1/chart-notes/NOTE-1').send({ version: 1, body: 'updated' });
    expect(res.status).toBe(200);
    expect(spies.chartNoteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }));
  });

  it("forbids ops_staff editing another user's note", async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db } = makeDb(note({ createdBy: 'SOMEONE-ELSE', version: 1 }));
    const res = await request(appFor(db)).patch('/api/v1/chart-notes/NOTE-1').send({ version: 1, body: 'updated' });
    expect(res.status).toBe(403);
  });

  it('lets an admin edit any note', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(note({ createdBy: 'SOMEONE-ELSE', version: 1 }));
    const res = await request(appFor(db)).patch('/api/v1/chart-notes/NOTE-1').send({ version: 1, body: 'admin edit' });
    expect(res.status).toBe(200);
  });

  it('rejects a stale version with 409', async () => {
    const { db } = makeDb(note({ createdBy: 'USER-1', version: 3 }));
    const res = await request(appFor(db)).patch('/api/v1/chart-notes/NOTE-1').send({ version: 1, body: 'updated' });
    expect(res.status).toBe(409);
  });

  it('lets an admin delete a note (204) and writes activity', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).delete('/api/v1/chart-notes/NOTE-1');
    expect(res.status).toBe(204);
    expect(spies.chartNoteDelete).toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'chart_note_deleted' }) }));
  });

  it('forbids ops_staff from deleting', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db)).delete('/api/v1/chart-notes/NOTE-1');
    expect(res.status).toBe(403);
  });
});
