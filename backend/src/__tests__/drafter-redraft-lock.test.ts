import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterClientRouter } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

/**
 * G1 — REDRAFT LOCK AT SEND-TO-DOCTOR (ratified sign/edit lifecycle, Ryan 2026-06-12:
 * "lock redraft after sent to doctor. if doc sends back to RN that reopens.")
 *
 * POST /cases/:id/draft must 409 {reason:'locked_physician_review'} for ops_staff while the
 * case sits in physician_review — the same envelope shape as the letter editor's RN lock —
 * and must NOT lock admin, nor ops_staff in the statuses that stay redraftable
 * (rn_review / correction_review / drafting).
 *
 * The pass-the-lock tests use a case with NO assigned physician/RN: the request then dies at
 * the NEXT gate (400 assignment_required), which proves it got past the lock without needing
 * S3/SQS mocks — the lock fires before any bundle/enqueue work.
 */

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

function makeDb(status: string) {
  const caseRow = {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Lumbosacral strain', status,
    // No reviewers assigned ON PURPOSE: requests that pass the lock 400 at the assignment
    // gate instead of reaching the bundle/S3/SQS machinery.
    assignedPhysicianId: null, assignedRnId: null,
    currentVersion: 1, version: 1, createdAt: new Date(), updatedAt: new Date(),
  };
  const db = {
    case: { findFirst: vi.fn(async () => caseRow) },
    draftJob: { findFirst: vi.fn(async () => null) },
    fileReadStatus: { findMany: vi.fn(async () => []) },
    activityLog: { create: vi.fn(async () => ({})) },
  } as unknown as AppDb;
  return { db };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createDrafterClientRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('POST /cases/:id/draft — G1 redraft lock (ratified lifecycle 2026-06-12)', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  it('locks ops_staff redraft while in physician_review (409 locked_physician_review — same shape as the letter lock)', async () => {
    const { db } = makeDb('physician_review');
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/draft').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.details.reason).toBe('locked_physician_review');
    expect(res.body.error.details.caseId).toBe('CASE-1');
  });

  it('does NOT lock admin in physician_review (passes the lock; dies at the assignment gate)', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db } = makeDb('physician_review');
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/draft').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('assignment_required');
    expect(res.body?.error?.details?.reason).not.toBe('locked_physician_review');
  });

  // "Send back to RN" reopens: correction_requested → correction_review, where the RN works the
  // correction — these (plus rn_review and a held 'drafting') must stay redraftable for ops_staff.
  it.each(['rn_review', 'correction_review', 'drafting'])('ops_staff still passes the lock in %s', async (status) => {
    const { db } = makeDb(status);
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/draft').send({});
    expect(res.status).toBe(400); // the assignment gate, NOT the lock
    expect(res.body.error.details.reason).toBe('assignment_required');
  });
});
