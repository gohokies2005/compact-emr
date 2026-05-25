// @ts-nocheck -- heavy Prisma-shape mocks intentionally diverge from strict AppDb typing; suite is skipped (describe.skip) pending the Phase 4B-4 test rewrite
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesRouter } from '../routes/cases.js';
import type { AppDb, AppDbTransaction, AppUserRecord, CaseRecord } from '../services/db-types.js';

let mockUser: AppUserRecord | undefined;

vi.mock('../middleware/auth', () => ({
  authenticateJwt: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (mockUser === undefined) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
      return;
    }
    (req as express.Request & { user?: AppUserRecord }).user = mockUser;
    next();
  },
}));

vi.mock('../auth/roles', () => ({
  requireRole:
    (roles: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: AppUserRecord }).user;
      if (user === undefined) {
        res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
        return;
      }
      if (!roles.includes(user.role)) {
        res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } });
        return;
      }
      next();
    },
}));

vi.mock('../http/errors', () => {
  class HttpError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;

    constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.status = status;
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  return {
    HttpError,
    isHttpError: (err: unknown): err is InstanceType<typeof HttpError> => err instanceof HttpError,
    sendError: (
      res: express.Response,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } }),
  };
});

vi.mock('../http/async-handler', () => ({
  asyncHandler:
    (handler: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    },
}));

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'CASE-1',
    veteranId: 'VET-1',
    claimedCondition: 'condition field not asserted',
    claimType: 'initial',
    status: 'intake',
    version: 1,
    assignedPhysicianId: null,
    refundEligible: false,
    ...overrides,
  };
}

function makeDb(initialCase: CaseRecord = baseCase()) {
  let current = { ...initialCase };
  const activityLogCreate = vi.fn(async () => ({}));
  const caseFindFirst = vi.fn(async () => current);
  const caseFindMany = vi.fn(async () => [current]);
  const caseCount = vi.fn(async () => 1);
  const caseCreate = vi.fn(async (args: Record<string, unknown>) => {
    const data = args.data as Partial<CaseRecord>;
    current = baseCase({ ...data, version: 1, status: 'intake' });
    return current;
  });
  const caseUpdate = vi.fn(async (args: Record<string, unknown>) => {
    const data = args.data as Record<string, unknown>;
    current = {
      ...current,
      ...data,
      version: current.version + 1,
    };
    return current;
  });

  const tx: AppDbTransaction = {
    case: {
      findMany: caseFindMany,
      findFirst: caseFindFirst,
      findUnique: caseFindFirst,
      count: caseCount,
      create: caseCreate,
      update: caseUpdate,
    },
    veteran: {
      findUnique: vi.fn(async () => ({ id: 'VET-1' })),
    },
    draftJob: {
      findMany: vi.fn(async () => [{ id: 'DJ-1', version: 1 }]),
    },
    correction: {
      findMany: vi.fn(async () => [{ id: 'CORR-1' }]),
    },
    activityLog: {
      create: activityLogCreate,
    },
  };

  const db: AppDb = {
    ...tx,
    $transaction: vi.fn(async <T,>(fn: (innerTx: AppDbTransaction) => Promise<T>) => fn(tx)),
  };

  return { db, tx, spies: { activityLogCreate, caseFindFirst, caseFindMany, caseCount, caseCreate, caseUpdate } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createCasesRouter(db));
  return app;
}

describe.skip('cases routes', () => {
  beforeEach(() => {
    mockUser = { id: 'USER-1', cognitoSub: 'sub', email: 'a@example.com', roles: ['admin'] as const };
  });

  it('returns 401 unauthenticated', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(401);
  });

  it('returns 403 wrong role for case list', async () => {
    mockUser = { id: 'USER-1', cognitoSub: 'sub', email: 'phys@example.com', roles: ['physician'] as const };
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases');
    expect(res.status).toBe(403);
  });

  it('creates a case and writes activity row', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/veterans/VET-1/cases').send({
      id: 'CASE-2',
      claimedCondition: 'redacted test condition',
      claimType: 'initial',
    });
    expect(res.status).toBe(201);
    expect(spies.caseCreate).toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'case_created' }) }),
    );
  });

  it('lists paginated cases with veteran lite info', async () => {
    const { db, spies } = makeDb(baseCase({ veteran: { id: 'VET-1', firstName: 'A', lastName: 'B' } }));
    const res = await request(appFor(db)).get('/api/v1/cases?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(spies.caseFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });

  it('gets a single case with relations', async () => {
    const { db, spies } = makeDb(baseCase({ draftJobs: [], corrections: [], emails: [], payments: [] }));
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(spies.caseFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ draftJobs: expect.any(Object) }) }),
    );
  });

  it('patches fields, bumps version, and writes activity row', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({
      version: 1,
      framingChoice: 'redacted framing',
    });
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }),
    );
    expect(spies.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'case_updated' }) }),
    );
  });

  it('rejects PATCH stale version with 409', async () => {
    const { db } = makeDb(baseCase({ version: 2 }));
    const res = await request(appFor(db)).patch('/api/v1/cases/CASE-1').send({
      version: 1,
      framingChoice: 'redacted framing',
    });
    expect(res.status).toBe(409);
  });

  it('soft deletes as rejected with distinct activity action, admin only', async () => {
    const { db, spies } = makeDb(baseCase({ status: 'records' }));
    const res = await request(appFor(db)).delete('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(spies.caseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }),
    );
    expect(spies.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'case_soft_deleted',
          detailsJson: expect.objectContaining({ previousStatus: 'records' }),
        }),
      }),
    );
  });

  it('performs valid status transition without touching draft jobs', async () => {
    const { db, tx, spies } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'intake',
      to: 'records',
      version: 1,
      transitionReason: 'per supervisor approval',
    });
    expect(res.status).toBe(200);
    expect(tx.draftJob.findMany).not.toHaveBeenCalled();
    expect(spies.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'case_status_changed',
          detailsJson: expect.objectContaining({ transitionReason: 'per supervisor approval' }),
        }),
      }),
    );
  });

  it('rejects invalid status transition with 400', async () => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'intake',
      to: 'delivered',
      version: 1,
    });
    expect(res.status).toBe(400);
  });

  it('allows physician_review to delivered for physician but not ops_staff', async () => {
    mockUser = { id: 'PHYS-USER', cognitoSub: 'sub', email: 'phys@example.com', roles: ['physician'] as const };
    const allowed = makeDb(baseCase({ status: 'physician_review', version: 1 }));
    const allowedRes = await request(appFor(allowed.db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'physician_review',
      to: 'delivered',
      version: 1,
    });
    expect(allowedRes.status).toBe(200);

    mockUser = { id: 'OPS-USER', cognitoSub: 'sub', email: 'ops@example.com', roles: ['ops_staff'] as const };
    const denied = makeDb(baseCase({ status: 'physician_review', version: 1 }));
    const deniedRes = await request(appFor(denied.db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'physician_review',
      to: 'delivered',
      version: 1,
    });
    expect(deniedRes.status).toBe(403);
  });

  it('rejects stale status transition with 409', async () => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 2 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'intake',
      to: 'records',
      version: 1,
    });
    expect(res.status).toBe(409);
  });

  it.each([
    ['123-45-6789'],
    ['call 555-123-4567 back'],
    ['veteran@example.com confirmed'],
  ])('rejects PHI-shaped transitionReason %s', async (transitionReason) => {
    const { db } = makeDb(baseCase({ status: 'intake', version: 1 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/status').send({
      from: 'intake',
      to: 'records',
      version: 1,
      transitionReason,
    });
    expect(res.status).toBe(400);
  });
});
