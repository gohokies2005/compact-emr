import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryRouter } from '../routes/delivery.js';
import { sendEmail } from '../services/mailer.js';
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

// E3: the route transmits via mailer.sendEmail — stub it so no SES client is ever constructed.
// Each test programs the stub (resolve sent / resolve redirected / reject) per its scenario.
vi.mock('../services/mailer', () => ({ sendEmail: vi.fn() }));
const sendEmailMock = vi.mocked(sendEmail);

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
  veteranEmail?: string;
  // Byte-binding gate (#9 Fix 3 → #17 SSOT): sign-off rows the gate reads (latest by signedAt first).
  // answersJson defaults to an AFFIRMATIVE attestation so the gate reaches the byte step (the SSOT
  // checks exists → affirmative → bytes); a test can pass a non-affirmative answersJson to exercise
  // the affirmative gate.
  signOffs?: ReadonlyArray<{ signedVersion: number | null; signedContentSha256: string | null; signedAt: Date; answersJson?: unknown }>;
  // External-import letter (import deliver-as-is): the current LetterRevision's source + PDF artifact.
  // When set, resolveCurrentRevisionMeta sees source='external_import' and the gate/excerpt take the
  // PDF path instead of the placeholder TXT.
  revisionSource?: string;
  pdfBytes?: Uint8Array;
}

const AFFIRMATIVE_ANSWERS = { records_reviewed: true, dx_documented: true, nexus_supported: true };

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
    // E3: the real send flips the row to status 'sent' + sentAt via update().
    update: vi.fn(async (a: { where: { id: string }; data: Partial<EmailRecord> }) => {
      const row = emails.find((e) => e.id === a.where.id);
      if (!row) throw new Error(`email ${a.where.id} not found`);
      Object.assign(row, a.data);
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
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: opts.veteranEmail ?? 'jane@example.com' })) },
    letterRevision: { findFirst: vi.fn(async () => ({ id: 'REV-1', version: 1, source: opts.revisionSource ?? 'drafter', artifactTxtS3Key: 'letter-revisions/CASE-1/v1/letter.txt', artifactPdfS3Key: 'letter-revisions/CASE-1/v1/letter.pdf' })) },
    draftJob: { findFirst: vi.fn(async () => null) },
    physician: { findFirst: vi.fn(async () => null) },
    email: emailDelegate,
    payment: paymentDelegate,
    // Byte-binding delivery gate (#9 Fix 3 → #17 SSOT): default = no sign-off rows → gate is a no-op
    // (pass, fail-open on the exists step is NOT how the SSOT behaves — no sign-off blocks; but the
    // legacy tests that want a clean pass pass NO signOffs to keep their original shape). Each row
    // gets an AFFIRMATIVE answersJson by default so the gate reaches the byte step.
    signOff: {
      findMany: vi.fn(async () =>
        (opts.signOffs ?? []).map((s, i) => ({
          id: `SO-${i}`,
          ...s,
          answersJson: s.answersJson ?? AFFIRMATIVE_ANSWERS,
        })),
      ),
    },
    activityLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ email: emailDelegate, payment: paymentDelegate, activityLog: { create: vi.fn(async () => ({})) } })),
  } as unknown as AppDb;

  return { db, emails, payments, emailDelegate, paymentDelegate };
}

// A fake S3 that returns the canonical letter TXT for TXT reads and (when provided) the imported PDF
// bytes for binary reads. The delivery email's excerpt + the TXT byte gate use transformToString; the
// import PDF byte gate (assertDeliveryEligible → readPdfBytesWithHash) uses transformToByteArray. For
// an external_import case the TXT served is the PLACEHOLDER (so the excerpt-skip is exercised).
function fakeS3(opts: { txt?: string; pdfBytes?: Uint8Array } = {}) {
  const txt = opts.txt ?? LETTER_TXT;
  const pdfBytes = opts.pdfBytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  return {
    send: vi.fn(async () => ({
      Body: {
        transformToString: async () => txt,
        transformToByteArray: async () => pdfBytes,
      },
    })),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}

function appFor(db: AppDb, s3Opts: { txt?: string; pdfBytes?: Uint8Array } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createDeliveryRouter(db, { s3: fakeS3(s3Opts), bucketName: 'phi-bucket' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('POST /cases/:id/delivery/send — real SES send (E3) + idempotency', () => {
  beforeEach(() => {
    mockUser = { sub: 'admin-sub', roles: ['admin'] };
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ sent: true, messageId: 'ses-msg-1' });
  });
  afterEach(() => { delete process.env.SES_FROM_ADDRESS; });

  it('SUCCESS: transmits via sendEmail, flips the row to sent + sentAt, returns emailSent:true + messageId', async () => {
    const { db, emails } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendArg = sendEmailMock.mock.calls[0][0];
    expect(sendArg.to).toBe('jane@example.com');
    expect(sendArg.subject).toBe(SUBJECT);
    expect(sendArg.textBody).toContain('more likely than not');

    expect(emails).toHaveLength(1);
    expect(emails[0].status).toBe('sent');
    expect(emails[0].sentAt).toBeInstanceOf(Date);

    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.emailStatus).toBe('sent');
    expect(res.body.data.messageId).toBe('ses-msg-1');
    expect(res.body.data.message).toContain('Sent to jane@example.com');
  });

  it('FAILURE: sendEmail throws → row STAYS queued, the REAL error surfaces verbatim, structured warn logged', async () => {
    const { db, emails } = makeDb();
    sendEmailMock.mockRejectedValue(new Error('Email address is not verified: jane@example.com (SES sandbox)'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
      expect(res.status).toBe(200);

      // Row persisted but NOT flipped — still re-sendable.
      expect(emails).toHaveLength(1);
      expect(emails[0].status).toBe('queued');
      expect(emails[0].sentAt).toBeNull();

      // The REAL transport error, verbatim (standing rule: no silent errors).
      expect(res.body.data.emailSent).toBe(false);
      expect(res.body.data.emailStatus).toBe('queued');
      expect(res.body.data.error).toBe('Email address is not verified: jane@example.com (SES sandbox)');
      expect(res.body.data.message).toContain('Email address is not verified');

      // One structured CloudWatch warn (http_error-pattern sibling).
      const warnLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('delivery_email_send_failed'));
      expect(warnLine).toBeDefined();
      const parsed = JSON.parse(warnLine!);
      expect(parsed).toMatchObject({ msg: 'delivery_email_send_failed', caseId: 'CASE-1' });
      expect(parsed.error).toContain('not verified');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ALREADY SENT: a row with status sent is NEVER re-transmitted (sendEmail not called)', async () => {
    const { db, emails } = makeDb();
    const app = appFor(db);
    // First send succeeds and flips the row.
    await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(emails[0].status).toBe('sent');
    sendEmailMock.mockClear();

    const res = await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.emailStatus).toBe('sent');
    expect(res.body.data.message).toContain('already sent');
    expect(res.body.data.message).toContain('not re-sent');
    expect(emails).toHaveLength(1);
  });

  it('SES-sandbox forwarding: redirectedFrom surfaces in the response + message', async () => {
    const { db } = makeDb();
    sendEmailMock.mockResolvedValue({ sent: true, messageId: 'ses-msg-2', redirectedFrom: 'jane@example.com' });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.redirectedFrom).toBe('jane@example.com');
    expect(res.body.data.message).toContain('forwarding to jane@example.com');
  });

  it('mailer loud no-op (sent:false reason) → row stays queued + the reason surfaces', async () => {
    const { db, emails } = makeDb();
    sendEmailMock.mockResolvedValue({ sent: false, reason: 'SES_FROM_ADDRESS not configured' });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(emails[0].status).toBe('queued');
    expect(res.body.data.emailSent).toBe(false);
    expect(res.body.data.error).toBe('SES_FROM_ADDRESS not configured');
  });

  it('no veteran email on file → no transmit attempt, precise error, row stays queued', async () => {
    const { db, emails } = makeDb({ veteranEmail: '' });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(emails[0].status).toBe('queued');
    expect(res.body.data.emailSent).toBe(false);
    expect(res.body.data.error).toContain('no email address on file');
  });

  it('RETRY AFTER FAILURE: a failed send leaves the row queued; the retry transmits and flips it', async () => {
    const { db, emails } = makeDb();
    const app = appFor(db);
    sendEmailMock.mockRejectedValueOnce(new Error('SES throttled'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
      expect(first.body.data.emailSent).toBe(false);
      expect(emails[0].status).toBe('queued');

      const second = await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
      expect(second.body.data.emailSent).toBe(true);
      expect(emails).toHaveLength(1);
      expect(emails[0].status).toBe('sent');
      expect(second.body.data.emailId).toBe(first.body.data.emailId);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('(a) double POST /send creates exactly ONE Payment + ONE Email (idempotent rows)', async () => {
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
    // existing row and never even attempts a second create. The transmit also happened ONCE.
    expect(emailDelegate.create).toHaveBeenCalledTimes(1);
    expect(paymentDelegate.create).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
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

  it('GET /delivery exposes the sent saved email (status sent, sentAt set) after a real send', async () => {
    const { db } = makeDb();
    const app = appFor(db);
    await request(app).post('/api/v1/cases/CASE-1/delivery/send').send({});
    const res = await request(app).get('/api/v1/cases/CASE-1/delivery');
    expect(res.status).toBe(200);
    expect(res.body.data.savedEmail).not.toBeNull();
    expect(res.body.data.savedEmail.status).toBe('sent');
    expect(res.body.data.savedEmail.sentAt).not.toBeNull();
    expect(res.body.data.savedPayment.kind).toBe('letter_500');
  });

  it('non-deliverable status -> 409 (and nothing transmits)', async () => {
    const { db } = makeDb({ status: 'records' });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(409);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── G2(a) — byte-binding gate PINNED (ratified sign/edit lifecycle 2026-06-12) ──────────────
  // "only the signed copy can ship": a sign-off whose bound hash no longer matches the current
  // TXT must block delivery until re-sign. This is the ULTIMATE enforcement behind the G1/G4
  // door-level guards in drafter.ts/letter.ts — pinned so a refactor can't soften it.
  it('G2a: sign-off hash mismatch (post-sign edit) blocks /delivery/send with 409 signed_bytes_changed and nothing transmits', async () => {
    const { db } = makeDb({ signOffs: [{ signedVersion: 1, signedContentSha256: 'f'.repeat(64), signedAt: new Date() }] });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('signed_bytes_changed');
    expect(res.body.error.details.reason).toBe('signed_bytes_changed');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('G2a: a re-signed letter (hash matches the current TXT) delivers normally', async () => {
    const sha = createHash('sha256').update(LETTER_TXT, 'utf-8').digest('hex');
    const { db } = makeDb({ signOffs: [{ signedVersion: 1, signedContentSha256: sha, signedAt: new Date() }] });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.emailSent).toBe(true);
  });

  it('G2a back-compat: a legacy sign-off with NO bound hash skips the byte check (delivers)', async () => {
    const { db } = makeDb({ signOffs: [{ signedVersion: null, signedContentSha256: null, signedAt: new Date() }] });
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.emailSent).toBe(true);
  });

  it('physician role is forbidden from the delivery panel -> 403', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'dr-sub', roles: ['physician'] };
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(403);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── P0-2 — imported-letter delivery (consistency sweep fixes, 2026-06-14) ────────────────────
  // An external_import letter binds its sign-off to sha256(PDF); the TXT is a placeholder. The byte
  // gate must re-hash the PDF (via the #17 SSOT), NOT the placeholder TXT. The OLD inline TXT-only
  // re-hash ALWAYS tripped 'signed_bytes_changed' for imports → an imported letter could never ship.
  const IMPORT_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x42]); // "%PDF-1.7\nB"
  const IMPORT_PDF_SHA = createHash('sha256').update(IMPORT_PDF).digest('hex');
  // For an import the served TXT is a placeholder with NO §VII/§VIII — buildOpinionExcerpt → block:null.
  const PLACEHOLDER_TXT = '[external import placeholder]';

  it('P0-2: an external_import letter whose sign-off hash matches the PDF DELIVERS (PDF byte gate, not TXT)', async () => {
    const { db } = makeDb({
      revisionSource: 'external_import',
      signOffs: [{ signedVersion: 1, signedContentSha256: IMPORT_PDF_SHA, signedAt: new Date() }],
    });
    const res = await request(appFor(db, { txt: PLACEHOLDER_TXT, pdfBytes: IMPORT_PDF })).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.emailSent).toBe(true);
    // The §VII excerpt was NOT built from the placeholder TXT (P1-1): the email points to the full
    // letter instead of shipping a blank/garbled excerpt.
    const sendArg = sendEmailMock.mock.calls[0][0];
    expect(sendArg.textBody).toContain('contained in your full letter');
    expect(sendArg.textBody).not.toContain('[external import placeholder]');
  });

  it('P0-2: an external_import letter whose PDF changed AFTER sign-off is BLOCKED 409 (false ALLOW would ship the wrong PDF)', async () => {
    const { db } = makeDb({
      revisionSource: 'external_import',
      signOffs: [{ signedVersion: 1, signedContentSha256: 'old_pdf_hash_deadbeef', signedAt: new Date() }],
    });
    const res = await request(appFor(db, { txt: PLACEHOLDER_TXT, pdfBytes: IMPORT_PDF })).post('/api/v1/cases/CASE-1/delivery/send').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('signed_bytes_changed');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('P1-1: GET /delivery for an external_import returns a null excerpt block (placeholder TXT never becomes the excerpt)', async () => {
    const { db } = makeDb({
      revisionSource: 'external_import',
      signOffs: [{ signedVersion: 1, signedContentSha256: IMPORT_PDF_SHA, signedAt: new Date() }],
    });
    const res = await request(appFor(db, { txt: PLACEHOLDER_TXT, pdfBytes: IMPORT_PDF })).get('/api/v1/cases/CASE-1/delivery');
    expect(res.status).toBe(200);
    expect(res.body.data.excerpt.block).toBeNull();
    // The composed email body degrades to the generic "in your full letter" line, not a garbled excerpt.
    expect(res.body.data.email.body).toContain('contained in your full letter');
  });
});

describe('GET /cases/:id/delivery/memo.pdf — self-contained memo PDF (E4)', () => {
  beforeEach(() => { mockUser = { sub: 'admin-sub', roles: ['admin'] }; });

  // supertest does not buffer application/pdf by default — collect the raw bytes ourselves.
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('returns a real inline PDF for a memo-applicable case (supplemental claim)', async () => {
    const { db } = makeDb({ claimType: 'supplemental' });
    const res = await request(appFor(db))
      .get('/api/v1/cases/CASE-1/delivery/memo.pdf')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(500);
    expect(body.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('404s with a precise reason when no memo applies (original claim, no denial)', async () => {
    const { db } = makeDb({ claimType: 'initial' });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/delivery/memo.pdf');
    expect(res.status).toBe(404);
    expect(res.body.error.details.reason).toBe('no_memo');
  });

  it('409s before the letter is finalized (same delivery gate as the panel)', async () => {
    const { db } = makeDb({ claimType: 'supplemental', status: 'records' });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/delivery/memo.pdf');
    expect(res.status).toBe(409);
  });

  it('physician role is forbidden (same guard as the other delivery reads) -> 403', async () => {
    const { db } = makeDb({ claimType: 'supplemental' });
    mockUser = { sub: 'dr-sub', roles: ['physician'] };
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/delivery/memo.pdf');
    expect(res.status).toBe(403);
  });
});
