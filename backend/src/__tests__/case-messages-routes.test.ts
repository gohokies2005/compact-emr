import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaseMessagesRouter } from '../routes/case-messages.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseMessageRecord, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({ requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() }));

const PHYS = { id: 'PHYS-1', cognitoSub: 'DR-SUB', fullName: 'Dr', npi: '1', specialty: 'x', medicalLicense: 'y', email: 'e', phone: null, signatureImageS3Key: null, active: true, createdAt: new Date(), updatedAt: new Date(), version: 1 };

function msg(over: Partial<CaseMessageRecord>): CaseMessageRecord {
  return { id: 'M', caseId: 'CASE-1', senderSub: 'DR-SUB', senderRole: 'physician', body: 'hi', readAt: null, readBySub: null, createdAt: new Date(), ...over };
}

function makeDb(opts: { messages?: CaseMessageRecord[] } = {}) {
  const store = opts.messages ?? [];
  const caseRow = { id: 'CASE-1', assignedPhysicianId: 'PHYS-1', assignedRnId: 'RN-1' };
  const caseMessage = {
    findMany: vi.fn(async () => store),
    count: vi.fn(async (a: { where: { senderSub: { not: string } } }) => store.filter((m) => m.readAt === null && m.senderSub !== a.where.senderSub.not).length),
    create: vi.fn(async (a: { data: { senderSub: string; senderRole: string; body: string } }) => msg({ id: 'M-NEW', senderSub: a.data.senderSub, senderRole: a.data.senderRole, body: a.data.body })),
    findFirst: vi.fn(async (a: { where: { id: string } }) => store.find((m) => m.id === a.where.id) ?? null),
    updateMany: vi.fn(async (a: { where: { senderSub: { not: string } } }) => ({ count: store.filter((m) => m.senderSub !== a.where.senderSub.not && m.readAt === null).length })),
  };
  // findUnique = participant gate; findMany = the actor-name resolver (batch by cognitoSub).
  const physicianPool = [{ cognitoSub: 'DR-SUB', fullName: 'Dr. Pat Healer' }];
  const physician = {
    findUnique: vi.fn(async (a: { where: { cognitoSub?: string } }) => (a.where.cognitoSub === 'DR-SUB' ? PHYS : null)),
    findMany: vi.fn(async (a: { where?: { cognitoSub?: { in?: string[] } } }) => {
      const wanted = a.where?.cognitoSub?.in ?? [];
      return physicianPool.filter((p) => wanted.includes(p.cognitoSub));
    }),
  };
  const appUserPool = [{ id: 'RN-1', cognitoSub: 'RN-SUB', name: 'Nina RN', email: 'rn@x', roles: [{ role: 'ops_staff' }] }];
  const appUser = {
    findUnique: vi.fn(async (a: { where: { cognitoSub?: string } }) =>
      a.where.cognitoSub === 'RN-SUB' ? { id: 'RN-1', cognitoSub: 'RN-SUB', email: 'rn@x', roles: [{ role: 'ops_staff' }] }
      : a.where.cognitoSub === 'OTHER-SUB' ? { id: 'RN-OTHER', cognitoSub: 'OTHER-SUB', email: 'o@x', roles: [{ role: 'ops_staff' }] }
      : null),
    findMany: vi.fn(async (a: { where?: { cognitoSub?: { in?: string[] } } }) => {
      const wanted = a.where?.cognitoSub?.in ?? [];
      return appUserPool.filter((u) => wanted.includes(u.cognitoSub)).map((u) => ({ cognitoSub: u.cognitoSub, name: u.name, email: u.email }));
    }),
  };
  const db = { case: { findFirst: vi.fn(async () => caseRow) }, caseMessage, physician, appUser } as unknown as AppDb;
  return { db, caseMessage };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCaseMessagesRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('case messaging routes (D4)', () => {
  beforeEach(() => { mockUser = undefined; });

  it('assigned physician can list the thread + gets unreadCount', async () => {
    mockUser = { sub: 'DR-SUB', roles: ['physician'] };
    const { db } = makeDb({ messages: [msg({ id: 'M1', senderSub: 'RN-SUB', senderRole: 'ops_staff' })] });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1); // the RN's message is unread for the physician
    // The author resolves to a NAME, never the raw Cognito sub (Ryan 2026-06-24).
    expect(res.body.data[0].senderName).toBe('Nina RN');
    expect(res.body.data[0].senderName).not.toBe('RN-SUB');
  });

  it('resolves a physician sender via the physician directory + falls back to "Staff" for an unknown sub', async () => {
    mockUser = { sub: 'DR-SUB', roles: ['physician'] };
    const { db } = makeDb({ messages: [msg({ id: 'M1', senderSub: 'DR-SUB', senderRole: 'physician' }), msg({ id: 'M2', senderSub: 'ghost-sub-no-account', senderRole: 'ops_staff' })] });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.data[0].senderName).toBe('Dr. Pat Healer');
    expect(res.body.data[1].senderName).toBe('Staff');
    expect(res.body.data[1].senderName).not.toContain('ghost');
  });

  it('assigned RN can post a message -> 201 with senderRole', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/messages').send({ body: 'Records uploaded, ready for your review.' });
    expect(res.status).toBe(201);
    expect(res.body.data.senderRole).toBe('ops_staff');
  });

  it('an ops_staff who is NOT the assigned RN -> 403', async () => {
    mockUser = { sub: 'OTHER-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/messages');
    expect(res.status).toBe(403);
  });

  it('an unassigned physician -> 403', async () => {
    mockUser = { sub: 'DR-OTHER-SUB', roles: ['physician'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/messages');
    expect(res.status).toBe(403);
  });

  it('admin can read any thread', async () => {
    mockUser = { sub: 'admin-sub', roles: ['admin'] };
    const { db } = makeDb();
    expect((await request(appFor(db)).get('/api/v1/cases/CASE-1/messages')).status).toBe(200);
  });

  it('empty body -> 400', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/messages').send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('mark-read only flips counterparty messages (never self-authored)', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb({ messages: [msg({ id: 'M1', senderSub: 'DR-SUB' }), msg({ id: 'M2', senderSub: 'RN-SUB' })] });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/messages/mark-read').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.markedCount).toBe(1); // only the physician's message, not the RN's own
  });
});
