import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryRouter } from '../routes/delivery.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role, EmailRecord, PaymentRecord } from '../services/db-types.js';

// Mirrors assign-rn-routes.test.ts conventions (mock requireRole + a hand-built AppDb).
interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Auth required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

const FROM = 'info@flatratenexus.com';
const SUBJECT = 'Your nexus letter is ready, invoice enclosed';

// A finalized letter TXT with a §VII opinion + §VIII references so buildOpinionExcerpt has content.
const LETTER_TXT = [
  '**I. Introduction**',
  'Intro prose.',
  '',
  '**VII. Opinion**',
  'It is more likely than not (greater than 50% probability) that the condition is related to service.',
  '',
  '**VIII. References**',
  '1. Some Author et al. A study. Journal. 2020.',
].join('\n');

// P2002 shaped like Prisma's PrismaClientKnownRequestError (code property is all the route checks).
function p2002(target: string): Error & { code: string } {
  const e = new Error(`Unique constraint failed on ${target}`) as Error & { code: string };
  e.code = 'P2002';
  return e;
}

interface MakeDbOpts {
  status?: string;
  caseExists?: boolean;
  claimType?: string;
  previouslyDenied?: boolean;
}

// Build an AppDb whose email/payment create() ENFORCE the partial unique indexes in-memory: the
// second delivery insert for the same case throws P2002 (exactly what the DB does in prod). This
// lets us prove the route converges on ONE row under a double / concurrent send.
function makeDb(opts: MakeDbOpts = {}) {
  const status = opts.status ?? 'delivered';
  const caseRow = {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'knee', claimType: opts.claimType ?? 'initial',
    claimedConditions: ['knee'], previouslyDenied: opts.previouslyDenied ?? false, priorDenialReason: null,
    priorDecisionDate: null, status, currentVersion: 1, assignedPhysicianId: null, assignedRnId: null,
    refundEligible: false, version: 1, createdAt: new Date(), updatedAt: new Date(),
  };

  const emails: EmailRecord[] = [];
  const payments: PaymentRecord[] = [];
  let emailSeq = 0;
  let paymentSeq = 0;

  const isDeliveryEmail = (e: { direction?: string; fromAddress?: string; subject?: string }) =>
    e.direction === 'outbound' && e.fromAddress === FROM && e.subject === SUBJECT;

  const emailDelegate = {
    findFirst: vi.fn(async (a: { where?: { direction?: string; fromAddress?: string; subject?: string } }) => {
      const w = a?.where ?? {};
      const found = emails.find((e) => isDeliveryEmail({ direction: w.direction, fromAddress: w.fromAddress, subject: w.subject }) ? isDeliveryEmail(e) : false);
      return found ?? null;
    }),
    findMany: vi.fn(async () => emails),
    create: vi.fn(async (a: { data: Partial<EmailRecord> }) => {
      const d = a.data;
      // Enforce emails_case_id_delivery_uq.
      if (isDeliveryEmail(d as EmailRecord) && emails.some((e) => isDeliveryEmail(e))) throw p2002('emails_case_id_delivery_uq');
      const row = {
        id: `EMAIL-${++emailSeq}`, caseId: d.caseId ?? 'CASE-1', direction: d.direction ?? 'outbound',
        subject: d.subject ?? '', body: d.body ?? '', fromAddress: d.fromAddress ?? '', toAddress: d.toAddress ?? '',
        sentAt: d.sentAt ?? null, status: d.status ?? 'sent', gmailMessageId: null,
        createdAt: new Date(), updatedAt: new Date(), version: 1,
      } as EmailRecord;
      emails.push(row);
      return row;
    }),
  };

  const paymentDelegate = {
    findFirst: vi.fn(async (a: { where?: { kind?: string } }) => payments.find((p) => p.kind === a?.where?.kind) ?? null),
    findMany: vi.fn(async () => payments),
    create: vi.fn(async (a: { data: Partial<PaymentRecord> }) => {
      const d = a.data;
      // Enforce payments_case_id_letter_500_uq.
      if (d.kind === 'letter_500' && payments.some((p) => p.kind === 'letter_500')) throw p2002('payments_case_id_letter_500_uq');
      const row = {
        id: `PAY-${++paymentSeq}`, caseId: d.caseId ?? 'CASE-1', kind: d.kind ?? 'letter_500',
        amountCents: d.amountCents ?? 0, stripeChargeId: d.stripeChargeId ?? null, status: d.status ?? 'invoiced',
        settledAt: null, createdAt: new Date(), updatedAt: new Date(), version: 1,
      } as PaymentRecord;
      payments.push(row);
      return row;
    }),
  };

  const db = {
    case: { findFirst: vi.fn(async () => (opts.caseExists === false ? null : caseRow)) },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' })) },
    letterRevision: { findFirst: vi.fn(async () => ({ version: 1, artifactTxtS3Key: 'letter-revisions/CASE-1/v1/letter.txt', artifactPdfS3Key: 'letter-revisions/CASE-1/v1/letter.pdf' })) },
    draftJob: { findFirst: vi.fn(async () => null) },
    physician: { findFirst: vi.fn(async () => null) },
    email: emailDelegate,
    payment: paymentDelegate,
    activityLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ email: emailDelegate, payment: paymentDelegate, activityLog: { create: vi.fn(async () => ({})) } })),
  } as unknown as AppDb;

  return { db, emails, payments, emailDelegate, paymentDelegate };
}

// A fake S3 that returns the canonical letter TXT.
function fakeS3() {
  return {
    send: vi.fn(async () => ({ Body: { transformToString: async () => LETTER_TXT } })),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createDeliveryRouter(db, { s3: fakeS3(), bucketName: 'phi-bucket' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('POST /cases/:id/delivery/send — idempotency + no false "sent"', () => {
  beforeEach(() => { mockUser = { sub: 'admin-sub', roles: ['admin'] }; });

  it('(a) double POST /send creates exactly ONE Payment + ONE Email (idempotent)', async () => {
    const { db, emails, payments, emailDelegate, paymentDelegate } = makeDb();
    const app = appFor(db);

    const first = await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(second.status).toBe(200);

    // Exactly one of each row persisted.
    expect(emails.length).toBe(1);
    expect(payments.length).toBe(1);
    // Both responses return the SAME row ids (re-use, not duplicate).
    expect(second.body.data.emailId).toBe(first.body.data.emailId);
    expect(second.body.data.paymentId).toBe(first.body.data.paymentId);
    // Sequential re-send short-circuits via the pre-flight findFirst: the second request sees the
    // existing row and never even attempts a second create.
    expect(emailDelegate.create).toHaveBeenCalledTimes(1);
    expect(paymentDelegate.create).toHaveBeenCalledTimes(1);
  });

  it('(a2) CONCURRENT send (both pre-flight reads see nothing) still yields ONE row via the P2002 catch', async () => {
    // Force the race: make the FIRST findFirst on both delegates return null (as if neither request
    // has committed yet), so BOTH requests proceed to create(). The unique index makes the second
    // create() throw P2002; the route must catch it, re-fetch, and converge on one row.
    const { db, emails, payments, emailDelegate, paymentDelegate } = makeDb();
    let emailReads = 0;
    const realEmailFind = emailDelegate.findFirst.getMockImplementation()!;
    emailDelegate.findFirst.mockImplementation(async (a: unknown) => {
      emailReads += 1;
      if (emailReads <= 2) return null; // both pre-flight reads miss
      return realEmailFind(a as never); // post-P2002 re-fetch sees the winner
    });
    let payReads = 0;
    const realPayFind = paymentDelegate.findFirst.getMockImplementation()!;
    paymentDelegate.findFirst.mockImplementation(async (a: unknown) => {
      payReads += 1;
      if (payReads <= 2) return null;
      return realPayFind(a as never);
    });

    const app = appFor(db);
    const [r1, r2] = await Promise.all([
      request(app).post('/api/v1/cases/CASE-1/delivery/send').send({}),
      request(app).post('/api/v1/cases/CASE-1/delivery/send').send({}),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Exactly one row each despite both requests attempting create().
    expect(emails.length).toBe(1);
    expect(payments.length).toBe(1);
    expect(emailDelegate.create).toHaveBeenCalledTimes(2);
    expect(paymentDelegate.create).toHaveBeenCalledTimes(2);
    // Both converge on the same surviving ids.
    expect(r1.body.data.emailId).toBe(r2.body.data.emailId);
    expect(r1.body.data.paymentId).toBe(r2.body.data.paymentId);
  });

  it('(b) stub-mode send does NOT set sentAt and reports pending (not "sent")', async () => {
    const { db, emails } = makeDb();
    delete process.env.DELIVERY_EMAIL_TRANSPORT; delete process.env.SES_REGION;
    delete process.env.RESEND_API_KEY; delete process.env.GMAIL_REFRESH_TOKEN;

    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);

    // Persisted email is queued with NO sentAt.
    expect(emails.length).toBe(1);
    expect(emails[0].sentAt).toBeNull();
    expect(emails[0].status).toBe('queued');

    // API never reports "sent".
    expect(res.body.data.emailSent).toBe(false);
    expect(res.body.data.emailStatus).toBe('queued');
    expect(String(res.body.data.message).toLowerCase()).toContain('pending send');
  });

  it('still reports pending (emailSent false) even if a transport env is set — no live send code exists', async () => {
    const { db, emails } = makeDb();
    process.env.RESEND_API_KEY = 're_test_key';
    try {
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
      expect(res.status).toBe(200);
      expect(res.body.data.emailTransportConfigured).toBe(true);
      expect(res.body.data.emailSent).toBe(false);
      expect(emails[0].sentAt).toBeNull();
      expect(emails[0].status).toBe('queued');
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('GET /delivery exposes a queued saved email with null sentAt after a stub send', async () => {
    const { db } = makeDb();
    const app = appFor(db);
    await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    const res = await request(app).get('/api/v1/cases/CASE-1/delivery');
    expect(res.status).toBe(200);
    expect(res.body.data.savedEmail).not.toBeNull();
    expect(res.body.data.savedEmail.sentAt).toBeNull();
    expect(res.body.data.savedEmail.status).toBe('queued');
    expect(res.body.data.savedPayment.kind).toBe('letter_500');
  });

  it('non-deliverable status -> 409', async () => {
    const { db } = makeDb({ status: 'records' });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(409);
  });

  it('physician role is forbidden from the delivery panel -> 403', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'dr-sub', roles: ['physician'] };
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(403);
  });
});
