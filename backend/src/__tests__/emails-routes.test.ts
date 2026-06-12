import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmailsRouter } from '../routes/emails.js';
import { isHttpError, sendError } from '../http/errors.js';
import { listVeteranCorrespondence } from '../services/gmail-readonly.js';
import type { AppDb, Role } from '../services/db-types.js';

// Emails ROUTE suite (the email-matching service has its own unit suite). Today this covers the
// live `/cases/:id/gmail-thread` endpoint — the service is mocked; its real behavior (degrade,
// cache, PHI discipline) is covered in gmail-readonly.test.ts.
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

vi.mock('../services/gmail-readonly', () => ({ listVeteranCorrespondence: vi.fn() }));
const gmailMock = vi.mocked(listVeteranCorrespondence);

function makeDb() {
  const findUnique = vi.fn(async (a: { where: { id: string } }) =>
    a.where.id === 'CASE-1' ? ({ veteran: { email: 'vet@example.com' } } as unknown as Awaited<ReturnType<AppDb['case']['findUnique']>>) : null);
  const db = { case: { findUnique } } as unknown as AppDb;
  return { db, spies: { findUnique } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createEmailsRouter(db, {}));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('emails routes — GET /cases/:id/gmail-thread', () => {
  beforeEach(() => {
    mockUser = { sub: 'U1', email: 'rn@x.com', roles: ['ops_staff'] };
    gmailMock.mockReset();
  });

  it('200 with the live messages when the scope is granted', async () => {
    const { db, spies } = makeDb();
    gmailMock.mockResolvedValueOnce({
      available: true,
      messages: [{ id: 'm1', direction: 'inbound', otherParty: 'vet@example.com', subject: 'S', snippet: 'sn', date: 'Wed, 10 Jun 2026 14:03:00 -0700' }],
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/gmail-thread');
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.messages).toHaveLength(1);
    expect(spies.findUnique).toHaveBeenCalledWith({ where: { id: 'CASE-1' }, select: { veteran: { select: { email: true } } } });
    expect(gmailMock).toHaveBeenCalledWith('vet@example.com');
  });

  it('200 (NOT 5xx) with the degraded shape while the Workspace scope is ungranted — ships dark', async () => {
    const { db } = makeDb();
    gmailMock.mockResolvedValueOnce({ available: false, reason: 'workspace_scope_not_granted' });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/gmail-thread');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ available: false, reason: 'workspace_scope_not_granted' });
  });

  it('404 for an unknown case', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/NOPE/gmail-thread');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(gmailMock).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/gmail-thread');
    expect(res.status).toBe(401);
  });
});
