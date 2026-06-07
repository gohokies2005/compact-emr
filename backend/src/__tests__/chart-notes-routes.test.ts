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
  return { id: 'NOTE-1', veteranId: 'VET-1', body: 'baseline note', createdBy: 'USER-1', createdAt: new Date('2026-05-24T00:00:00.000Z'), updatedAt: new Date('2026-05-24T00:00:00.000Z'), version: 1, ...overrides };
}

function makeDb(initial: ChartNoteRecord = note()) {
  let current = { ...initial };
  const chartNoteFindMany = vi.fn(async () => [current]);
  const chartNoteFindFirst = vi.fn(async () => current);
  const chartNoteCreate = vi.fn(async (args: { data: Partial<ChartNoteRecord> }) => { current = note({ ...args.data, version: 1 }); return current; });
  const chartNoteUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => { current = { ...current, ...args.data, version: current.version + 1 } as ChartNoteRecord; return current; });
  const chartNoteDelete = vi.fn(async () => current);
  const veteranFindUnique = vi.fn(async () => ({ id: 'VET-1' }));
  const activityLogCreate = vi.fn(async () => ({}));
  const tx = {
    chartNote: { findMany: chartNoteFindMany, findFirst: chartNoteFindFirst, create: chartNoteCreate, update: chartNoteUpdate, delete: chartNoteDelete },
    veteran: { findUnique: veteranFindUnique },
    activityLog: { create: activityLogCreate },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, spies: { chartNoteFindMany, chartNoteCreate, chartNoteUpdate, chartNoteDelete, activityLogCreate } };
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
