import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaffMessagesRouter } from '../routes/staff-messages.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({ requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() }));

// In-memory rows.
interface MsgRow { id: string; threadId: string; caseId: string | null; authorSub: string; subject: string | null; body: string; createdAt: Date }
interface RecipRow { id: string; threadId: string; recipientSub: string; kind: string; addedBySub: string; addedAt: Date; readAt: Date | null; archivedAt: Date | null }
interface AttRow { id: string; messageId: string | null; filename: string; contentType: string; sizeBytes: bigint; s3Key: string; uploadedBySub: string; createdAt: Date }

// Active member pool: RN-SUB (ops_staff), RN2-SUB (ops_staff), DR-SUB (physician), ADMIN-SUB (admin).
const APP_USERS = [
  { id: 'RN-1', cognitoSub: 'RN-SUB', email: 'rn@x', active: true, roles: [{ role: 'ops_staff' }] },
  { id: 'RN-2', cognitoSub: 'RN2-SUB', email: 'rn2@x', active: true, roles: [{ role: 'ops_staff' }] },
  { id: 'ADMIN-1', cognitoSub: 'ADMIN-SUB', email: 'admin@x', active: true, roles: [{ role: 'admin' }] },
];
const PHYSICIANS = [
  { id: 'PHYS-1', cognitoSub: 'DR-SUB', fullName: 'Dr One', npi: '1', specialty: 'x', medicalLicense: 'y', email: 'e', phone: null, signatureImageS3Key: null, active: true, createdAt: new Date(), updatedAt: new Date(), version: 1 },
  { id: 'PHYS-2', cognitoSub: 'DR2-SUB', fullName: 'Dr Two', npi: '2', specialty: 'x', medicalLicense: 'y', email: 'e2', phone: null, signatureImageS3Key: null, active: true, createdAt: new Date(), updatedAt: new Date(), version: 1 },
];
// CASE-1: assigned RN = RN-1, assigned physician = PHYS-1.
const CASE = { id: 'CASE-1', assignedPhysicianId: 'PHYS-1', assignedRnId: 'RN-1' };

function makeDb(seed: { messages?: MsgRow[]; recipients?: RecipRow[]; attachments?: AttRow[] } = {}) {
  const messages = seed.messages ?? [];
  const recipients = seed.recipients ?? [];
  const attachments = seed.attachments ?? [];

  const matchWhere = <T>(rows: T[], where: Record<string, unknown> | undefined): T[] => {
    if (!where) return rows.slice();
    return rows.filter((row) => Object.entries(where).every(([k, v]) => {
      const rv = (row as Record<string, unknown>)[k];
      if (v !== null && typeof v === 'object') {
        const cond = v as Record<string, unknown>;
        if ('not' in cond) return rv !== cond.not;
        if ('in' in cond) return (cond.in as unknown[]).includes(rv);
        return true;
      }
      return rv === v;
    }));
  };

  const staffMessage = {
    findMany: vi.fn(async (a: { where?: Record<string, unknown>; orderBy?: { createdAt?: 'asc' | 'desc' } }) => {
      let rows = matchWhere(messages, a?.where);
      if (a?.orderBy?.createdAt) rows = rows.slice().sort((x, y) => (a.orderBy!.createdAt === 'asc' ? 1 : -1) * (x.createdAt.getTime() - y.createdAt.getTime()));
      return rows;
    }),
    findFirst: vi.fn(async (a: { where?: Record<string, unknown>; orderBy?: unknown }) => matchWhere(messages, a?.where)[0] ?? null),
    findUnique: vi.fn(async (a: { where: { id: string } }) => messages.find((m) => m.id === a.where.id) ?? null),
    create: vi.fn(async (a: { data: Omit<MsgRow, 'id' | 'createdAt'> }) => {
      const row: MsgRow = { id: 'MSG-' + randomUUID().slice(0, 8), createdAt: new Date(Date.now() + messages.length), ...a.data };
      messages.push(row); return row;
    }),
    count: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(messages, a?.where).length),
  };

  const staffMessageRecipient = {
    findMany: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(recipients, a?.where)),
    findFirst: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(recipients, a?.where)[0] ?? null),
    create: vi.fn(async (a: { data: Partial<RecipRow> }) => {
      const row: RecipRow = { id: 'R-' + randomUUID().slice(0, 8), addedAt: new Date(), readAt: null, archivedAt: null, kind: 'to', addedBySub: 'x', threadId: '', recipientSub: '', ...a.data } as RecipRow;
      recipients.push(row); return row;
    }),
    createMany: vi.fn(async (a: { data: Array<Partial<RecipRow>> }) => {
      for (const d of a.data) recipients.push({ id: 'R-' + randomUUID().slice(0, 8), addedAt: new Date(), readAt: null, archivedAt: null, kind: 'to', addedBySub: 'x', threadId: '', recipientSub: '', ...d } as RecipRow);
      return { count: a.data.length };
    }),
    updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Partial<RecipRow> }) => {
      const targets = matchWhere(recipients, a.where);
      for (const t of targets) Object.assign(t, a.data);
      return { count: targets.length };
    }),
    update: vi.fn(async () => { throw new Error('not used'); }),
    count: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(recipients, a?.where).length),
  };

  const staffMessageAttachment = {
    findMany: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(attachments, a?.where)),
    findUnique: vi.fn(async (a: { where: { id: string } }) => attachments.find((x) => x.id === a.where.id) ?? null),
    findFirst: vi.fn(async (a: { where?: Record<string, unknown> }) => matchWhere(attachments, a?.where)[0] ?? null),
    create: vi.fn(async (a: { data: Partial<AttRow> }) => {
      const row: AttRow = { id: 'ATT-' + randomUUID().slice(0, 8), messageId: null, createdAt: new Date(), filename: '', contentType: '', sizeBytes: 0n, s3Key: '', uploadedBySub: '', ...a.data } as AttRow;
      attachments.push(row); return row;
    }),
    updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Partial<AttRow> }) => {
      const targets = matchWhere(attachments, a.where);
      for (const t of targets) Object.assign(t, a.data);
      return { count: targets.length };
    }),
    update: vi.fn(async () => { throw new Error('not used'); }),
  };

  const appUser = {
    findUnique: vi.fn(async (a: { where: { cognitoSub?: string; id?: string } }) =>
      APP_USERS.find((u) => (a.where.cognitoSub ? u.cognitoSub === a.where.cognitoSub : u.id === a.where.id)) ?? null),
    findMany: vi.fn(async () => APP_USERS),
  };
  const physician = {
    findUnique: vi.fn(async (a: { where: { cognitoSub?: string } }) => PHYSICIANS.find((p) => p.cognitoSub === a.where.cognitoSub) ?? null),
    findMany: vi.fn(async () => PHYSICIANS),
  };
  const activityLog = { create: vi.fn(async () => ({})) };

  const txApi = { staffMessage, staffMessageRecipient, staffMessageAttachment, activityLog, appUser, physician, case: { findFirst: vi.fn(async () => CASE) } };
  const db = {
    case: { findFirst: vi.fn(async (a: { where: { id: string } }) => (a.where.id === 'CASE-1' ? CASE : null)) },
    staffMessage, staffMessageRecipient, staffMessageAttachment, appUser, physician, activityLog,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txApi)),
  } as unknown as AppDb;
  return { db, messages, recipients, attachments };
}

function appFor(db: AppDb) {
  const s3 = { send: vi.fn(async () => ({})) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createStaffMessagesRouter(db, { s3, bucketName: 'test-bucket' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', `Unexpected: ${(error as Error).message}`);
  });
  return app;
}

// vitest can't mock getSignedUrl easily here — stub it to a static URL.
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.example/url') }));

describe('staff messaging routes (chunk 3)', () => {
  beforeEach(() => { mockUser = undefined; });

  it('SEND: creates a thread + recipient rows, expanding a role alias', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db, messages, recipients } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/messages').send({ subject: 'Hi team', body: 'please review', recipients: [{ alias: 'all_rns', kind: 'to' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.threadId).toBeTruthy();
    expect(messages).toHaveLength(1);
    // all_rns expands to RN-SUB + RN2-SUB (author ADMIN-SUB not in pool, so both kept).
    expect(recipients.map((r) => r.recipientSub).sort()).toEqual(['RN-SUB', 'RN2-SUB']);
  });

  it('SEND: self-only is rejected (400)', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/messages').send({ subject: 'x', body: 'y', recipients: [{ sub: 'RN-SUB', kind: 'to' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('self_only');
  });

  it('SEND: subject required on a new thread (400 when missing)', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/messages').send({ body: 'y', recipients: [{ sub: 'RN-SUB', kind: 'to' }] });
    expect(res.status).toBe(400);
  });

  it('REPLY: inherits recipients, re-flips unread for everyone but the reply author', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const tid = 'T1';
    const { db, recipients } = makeDb({
      messages: [{ id: 'M1', threadId: tid, caseId: null, authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
      recipients: [
        { id: 'R1', threadId: tid, recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: new Date(), archivedAt: null },
        { id: 'R2', threadId: tid, recipientSub: 'RN2-SUB', kind: 'cc', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: new Date(), archivedAt: null },
      ],
    });
    const res = await request(appFor(db)).post(`/api/v1/messages/${tid}/reply`).send({ body: 'replying' });
    expect(res.status).toBe(201);
    // RN2 (not the reply author) -> unread; RN-SUB (reply author) -> read.
    expect(recipients.find((r) => r.recipientSub === 'RN2-SUB')!.readAt).toBeNull();
    expect(recipients.find((r) => r.recipientSub === 'RN-SUB')!.readAt).not.toBeNull();
  });

  it('INBOX: lists my threads with unread + last-message + case chip', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const tid = 'T1';
    const { db } = makeDb({
      messages: [
        { id: 'M1', threadId: tid, caseId: 'CASE-1', authorSub: 'ADMIN-SUB', subject: 'S', body: 'first', createdAt: new Date(1) },
        { id: 'M2', threadId: tid, caseId: 'CASE-1', authorSub: 'ADMIN-SUB', subject: null, body: 'latest', createdAt: new Date(2) },
      ],
      recipients: [{ id: 'R1', threadId: tid, recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: null, archivedAt: null }],
    });
    const res = await request(appFor(db)).get('/api/v1/messages/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ threadId: tid, subject: 'S', caseId: 'CASE-1', lastMessageBody: 'latest', unread: true, messageCount: 2 });
    expect(res.body.unreadCount).toBe(1);
  });

  it('UNREAD-COUNT: distinct unread threads for me', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb({
      recipients: [
        { id: 'R1', threadId: 'T1', recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'a', addedAt: new Date(), readAt: null, archivedAt: null },
        { id: 'R2', threadId: 'T2', recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'a', addedAt: new Date(), readAt: new Date(), archivedAt: null },
        { id: 'R3', threadId: 'T3', recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'a', addedAt: new Date(), readAt: null, archivedAt: null },
      ],
    });
    const res = await request(appFor(db)).get('/api/v1/messages/unread-count');
    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(2);
  });

  it('THREAD-GET: linked thread allows a case-collaborator who is NOT a named recipient', async () => {
    mockUser = { sub: 'DR-SUB', roles: ['physician'] }; // PHYS-1 = assigned physician on CASE-1
    const tid = 'T1';
    const { db } = makeDb({
      messages: [{ id: 'M1', threadId: tid, caseId: 'CASE-1', authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
      recipients: [{ id: 'R1', threadId: tid, recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: null, archivedAt: null }],
    });
    const res = await request(appFor(db)).get(`/api/v1/messages/threads/${tid}`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
  });

  it('THREAD-GET: unlinked thread DENIES a non-recipient (403)', async () => {
    mockUser = { sub: 'DR-SUB', roles: ['physician'] };
    const tid = 'T1';
    const { db } = makeDb({
      messages: [{ id: 'M1', threadId: tid, caseId: null, authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
      recipients: [{ id: 'R1', threadId: tid, recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: null, archivedAt: null }],
    });
    const res = await request(appFor(db)).get(`/api/v1/messages/threads/${tid}`);
    expect(res.status).toBe(403);
  });

  it('MARK-READ: flips my recipient row to read', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const tid = 'T1';
    const { db, recipients } = makeDb({
      messages: [{ id: 'M1', threadId: tid, caseId: null, authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
      recipients: [{ id: 'R1', threadId: tid, recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: null, archivedAt: null }],
    });
    const res = await request(appFor(db)).post(`/api/v1/messages/threads/${tid}/read`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.markedCount).toBe(1);
    expect(recipients[0]!.readAt).not.toBeNull();
  });

  it('CASE-SCOPED: returns case-linked threads to a case collaborator', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] }; // assigned RN on CASE-1
    const { db } = makeDb({
      messages: [{ id: 'M1', threadId: 'T1', caseId: 'CASE-1', authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/staff-messages');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('ATTACHMENT: presign -> register -> download (participant) -> 200; non-participant denied', async () => {
    const { db, attachments } = makeDb({
      messages: [{ id: 'M1', threadId: 'T1', caseId: null, authorSub: 'ADMIN-SUB', subject: 'S', body: 'b', createdAt: new Date(1) }],
      recipients: [{ id: 'R1', threadId: 'T1', recipientSub: 'RN-SUB', kind: 'to', addedBySub: 'ADMIN-SUB', addedAt: new Date(), readAt: null, archivedAt: null }],
    });
    // presign
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const pres = await request(appFor(db)).post('/api/v1/messages/attachments/presign').send({ filename: 'report.txt', contentType: 'application/octet-stream', sizeBytes: 10 });
    expect(pres.status).toBe(200);
    expect(pres.body.data.contentType).toBe('text/plain'); // extension-inferred
    expect(pres.body.data.s3Key).toMatch(/^message-attachments\//);
    // register
    const reg = await request(appFor(db)).post('/api/v1/messages/attachments/register').send({ filename: 'report.txt', s3Key: pres.body.data.s3Key, contentType: 'text/plain', sizeBytes: 10 });
    expect(reg.status).toBe(201);
    const attId = reg.body.data.attachmentId;
    // bind to the message so download access resolves a thread
    attachments.find((x) => x.id === attId)!.messageId = 'M1';

    // participant (RN-SUB) can download
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const ok = await request(appFor(db)).get(`/api/v1/messages/attachments/${attId}/download`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.downloadUrl).toBeTruthy();

    // non-participant (DR2-SUB, not assigned, not a recipient, unlinked thread) denied
    mockUser = { sub: 'DR2-SUB', roles: ['physician'] };
    const denied = await request(appFor(db)).get(`/api/v1/messages/attachments/${attId}/download`);
    expect(denied.status).toBe(403);
  });

  it('REGISTER: rejects a bad s3Key (400)', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/messages/attachments/register').send({ filename: 'x.pdf', s3Key: 'cases/evil/../x.pdf', contentType: 'application/pdf', sizeBytes: 5 });
    expect(res.status).toBe(400);
  });
});
