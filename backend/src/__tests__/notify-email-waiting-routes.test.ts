import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCasesRouter } from '../routes/cases.js';
import { isHttpError, sendError } from '../http/errors.js';
import * as quoClient from '../services/quoClient.js';
import type { AppDb, Role } from '../services/db-types.js';

// Mirrors cases-routes.test.ts conventions: mock requireRole + a hand-built AppDb. Only the delegates the
// notify-email-waiting handler actually touches are mocked (case.findFirst, veteran.findUnique,
// activityLog.findFirst/create).
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

// cases.ts imports these at module load; mock so no AWS SDK is constructed when the router is built.
vi.mock('../services/doctor-pack-generate.js', () => ({
  generateDoctorPackForCase: vi.fn(async () => ({ outcome: 'skipped' })),
}));
vi.mock('../services/recompute-viability-trigger.js', () => ({
  fireRecomputeViability: vi.fn(async () => true),
}));

// The SMS transport is the seam under test's boundary — mock it so no https/Secrets Manager call is made.
// emailWaitingText returns the REAL locked copy (its content is pinned in quo-client.test.ts); this lets us
// assert the route wires emailWaitingText() -> sendSms() with the exact string.
const EXACT_TEXT =
  'Flat Rate Nexus here — you have an email from us waiting in your inbox. Please check it (and your spam folder) and reply when you can. This text line isn\'t monitored, so please reply to our email, not this number.';
vi.mock('../services/quoClient', () => ({
  sendSms: vi.fn(async () => ({ sent: true, id: 'quo-msg-1', code: 202 })),
  emailWaitingText: () => EXACT_TEXT,
}));
const sendSmsMock = vi.mocked(quoClient.sendSms);

interface DbOpts {
  caseRow?: { id: string; veteranId: string } | null;
  veteran?: { id: string; phone: string | null } | null;
  recentSuccess?: { id: string } | null;
}
function makeDb(opts: DbOpts = {}) {
  const caseRow = opts.caseRow === undefined ? { id: 'CASE-1', veteranId: 'VET-1' } : opts.caseRow;
  const veteran = opts.veteran === undefined ? { id: 'VET-1', phone: '(703) 555-1234' } : opts.veteran;
  const activityLogCreate = vi.fn(async (_args: { data: { action: string; detailsJson: Record<string, unknown> } }) => ({}));
  const activityLogFindFirst = vi.fn(async (_args: { where: Record<string, unknown> }) => opts.recentSuccess ?? null);
  const caseFindFirst = vi.fn(async () => caseRow);
  const veteranFindUnique = vi.fn(async () => veteran);
  const db = {
    case: { findFirst: caseFindFirst },
    veteran: { findUnique: veteranFindUnique },
    activityLog: { findFirst: activityLogFindFirst, create: activityLogCreate },
  } as unknown as AppDb;
  return { db, spies: { activityLogCreate, activityLogFindFirst, caseFindFirst, veteranFindUnique } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCasesRouter(db));
  // Minimal error middleware mirroring the real server so HttpError renders the JSON envelope (the shared
  // cases-routes test app omits it and asserts status only — here we assert error.code/message too).
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isHttpError(err)) { sendError(res, err.status, err.code, err.message, err.details); return; }
    next(err);
  });
  return app;
}

describe('POST /cases/:id/notify-email-waiting', () => {
  beforeEach(() => {
    mockUser = { sub: 'USER-1', email: 'rn@example.com', roles: ['ops_staff'] };
    sendSmsMock.mockReset();
    sendSmsMock.mockResolvedValue({ sent: true, id: 'quo-msg-1', code: 202 });
  });

  it('sends ONE SMS with the exact locked text and returns 200 with the phone last-4', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true, phoneLast4: '1234' });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).toHaveBeenCalledWith('(703) 555-1234', EXACT_TEXT);
    // Audits the success with the phone last-4.
    expect(spies.activityLogCreate).toHaveBeenCalledTimes(1);
    const logged = spies.activityLogCreate.mock.calls[0][0] as { data: { action: string; detailsJson: Record<string, unknown> } };
    expect(logged.data.action).toBe('sms_email_waiting_sent');
    expect(logged.data.detailsJson).toMatchObject({ sent: true, phoneLast4: '1234' });
  });

  it('returns 422 (bad_request) and never texts when the veteran has no phone', async () => {
    const { db, spies } = makeDb({ veteran: { id: 'VET-1', phone: null } });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.message).toMatch(/no phone number/i);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(spies.activityLogCreate).not.toHaveBeenCalled();
  });

  it('returns 429 (cooldown) and never texts when a successful send exists in the window', async () => {
    const { db, spies } = makeDb({ recentSuccess: { id: 'AL-RECENT' } });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/already texted/i);
    // The cooldown query filtered on detailsJson.sent === true within a time window.
    const where = (spies.activityLogFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ caseId: 'CASE-1', action: 'sms_email_waiting_sent', detailsJson: { path: ['sent'], equals: true } });
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(spies.activityLogCreate).not.toHaveBeenCalled();
  });

  it('returns 502 but STILL AUDITS the attempt when the SMS transport reports a failure', async () => {
    sendSmsMock.mockResolvedValue({ sent: false, reason: 'http_400', detail: 'A2P not approved' });
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_unavailable');
    // The failed attempt is logged (sent:false + reason) so the trail shows the try.
    expect(spies.activityLogCreate).toHaveBeenCalledTimes(1);
    const logged = spies.activityLogCreate.mock.calls[0][0] as { data: { detailsJson: Record<string, unknown> } };
    expect(logged.data.detailsJson).toMatchObject({ sent: false, reason: 'http_400', phoneLast4: '1234' });
  });

  it('maps an invalid_number failure to a specific message', async () => {
    sendSmsMock.mockResolvedValue({ sent: false, reason: 'invalid_number' });
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/valid us mobile number/i);
  });

  it('returns 404 when the case does not exist', async () => {
    const { db } = makeDb({ caseRow: null });
    const res = await request(appFor(db)).post('/api/v1/cases/NOPE/notify-email-waiting').send({});
    expect(res.status).toBe(404);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockUser = undefined;
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(401);
  });

  it('forbids a role outside admin/ops_staff/physician', async () => {
    mockUser = { sub: 'U-X', roles: ['viewer'] as unknown as Role[] };
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/notify-email-waiting').send({});
    expect(res.status).toBe(403);
  });
});
