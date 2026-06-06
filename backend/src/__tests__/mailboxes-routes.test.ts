import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxesRouter } from '../routes/mailboxes.js';
import type { AppDb, MonitoredMailboxRecord, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden' } }); return; }
      next();
    },
}));

function row(over: Partial<MonitoredMailboxRecord> = {}): MonitoredMailboxRecord {
  return { id: 'MB-1', address: 'info@flatratenexus.com', label: null, active: true, addedBy: 'a@x.com', createdAt: new Date(), updatedAt: new Date(), ...over };
}

function makeDb() {
  const create = vi.fn(async (a: { data: Record<string, unknown> }) => row({ id: 'MB-NEW', ...(a.data as Partial<MonitoredMailboxRecord>) }));
  const findUnique = vi.fn(async (a: { where: { id: string } }) => (a.where.id === 'MB-1' ? row() : null));
  const update = vi.fn(async (a: { data: Record<string, unknown> }) => row({ ...(a.data as Partial<MonitoredMailboxRecord>) }));
  const del = vi.fn(async () => row());
  const findMany = vi.fn(async () => [row()]);
  const db = { monitoredMailbox: { create, findUnique, update, delete: del, findMany } } as unknown as AppDb;
  return { db, spies: { create, findUnique, update, del, findMany } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createMailboxesRouter(db));
  return app;
}

describe('mailboxes routes', () => {
  beforeEach(() => { mockUser = { sub: 'U1', email: 'admin@x.com', roles: ['admin'] }; });

  it('POST normalizes the address + stamps the editor email', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/mailboxes').send({ address: '"Jane" <Jane.Doe+x@Flat.com>', label: 'Jane (RN)' });
    expect(res.status).toBe(201);
    expect(spies.create).toHaveBeenCalledWith({ data: { address: 'jane.doe@flat.com', label: 'Jane (RN)', addedBy: 'admin@x.com' } });
  });

  it('POST rejects a junk address (400)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/mailboxes').send({ address: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('POST a duplicate mailbox returns 409', async () => {
    const { db, spies } = makeDb();
    spies.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await request(appFor(db)).post('/api/v1/mailboxes').send({ address: 'info@flatratenexus.com' });
    expect(res.status).toBe(409);
  });

  it('DELETE an existing mailbox returns 204', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).delete('/api/v1/mailboxes/MB-1');
    expect(res.status).toBe(204);
    expect(spies.del).toHaveBeenCalled();
  });

  it('non-admin (ops_staff) is forbidden', async () => {
    mockUser = { sub: 'U2', email: 'rn@x.com', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/mailboxes');
    expect(res.status).toBe(403);
  });
});
