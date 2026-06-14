import { describe, expect, it, vi } from 'vitest';
import { buildDeliveryEmailText, parseCaseRef, processStripePayment } from '../services/payment-delivery.js';
import { sha256OfText } from '../services/letter-current.js';
import type { AppDb } from '../services/db-types.js';

vi.mock('../services/mailer.js', () => ({
  sendEmail: vi.fn(async () => ({ sent: true, messageId: 'm1' })),
  readSecretByName: vi.fn(async () => 'whsec'),
}));

// Correction-round SSOT (audit 2026-06-13): processStripePayment now gates token+email on
// assertDeliveryEligible. The default cfg passes NO s3/bucket, so the byte step fails open and an
// affirmative sign-off alone is sufficient for the happy-path tests below. The ineligible tests at
// the bottom override the sign-off (missing / non-affirmative) to prove delivery is withheld while
// the payment is STILL recorded + the case STILL flips to paid.
const SIGNED_TXT = 'Signed letter body.\n';
const AFFIRMATIVE_SIGNOFF = { answersJson: { a: true, b: true }, signedVersion: 7, signedContentSha256: sha256OfText(SIGNED_TXT) };

function makeDb(over: { existingPayment?: boolean; noPdf?: boolean; noCase?: boolean; phone?: string | null; approvedRevision?: boolean; invoicedRow?: boolean; signOff?: { answersJson: unknown; signedVersion: number | null; signedContentSha256: string | null } | null } = {}) {
  const calls = {
    paymentCreate: vi.fn(async () => ({})),
    paymentUpdate: vi.fn(async () => ({})),
    caseUpdate: vi.fn(async () => ({})),
    tokenCreate: vi.fn(async () => ({})),
    activity: vi.fn(async () => ({})),
  };
  const delegates = {
    payment: {
      // Two findFirst call sites: the chargeId fast-path dedup (where.stripeChargeId) and the
      // invoice-reconciliation lookup (where.status='invoiced') — answer per-args like Prisma.
      findFirst: vi.fn(async (a: { where?: { stripeChargeId?: string; status?: string } }) => {
        if (a?.where?.stripeChargeId !== undefined) return over.existingPayment ? { id: 'P0' } : null;
        if (a?.where?.status === 'invoiced') return over.invoicedRow ? { id: 'P-INV', status: 'invoiced' } : null;
        return null;
      }),
      create: calls.paymentCreate,
      update: calls.paymentUpdate,
    },
    case: { findFirst: vi.fn(async () => (over.noCase ? null : { id: 'C1', veteranId: 'V1', currentVersion: 7 })), update: calls.caseUpdate },
    // Default: no LetterRevision at currentVersion → resolveSignedPdf falls back to the draftJob path.
    letterRevision: { findFirst: vi.fn(async () => (over.approvedRevision ? { version: 7, artifactPdfS3Key: 'letter-revisions/C1/v7/letter.pdf' } : null)) },
    draftJob: { findMany: vi.fn(async () => (over.noPdf ? [] : [{ version: 5, artifactPdfS3Key: 'drafter-artifacts/C1/v5/letter.pdf' }])) },
    veteran: { findUnique: vi.fn(async () => ({ email: 'vet@example.com', firstName: 'Sam', phone: over.phone !== undefined ? over.phone : '(702) 555-1234' })) },
    deliveryToken: { create: calls.tokenCreate },
    activityLog: { create: calls.activity },
    // Default: an affirmative sign-off so the eligibility gate passes (byte step fails open — the
    // default cfg below passes no s3/bucket). over.signOff===null => no sign-off; an object overrides.
    signOff: {
      findMany: vi.fn(async () => {
        if (over.signOff === null) return [];
        return [{ id: 'S0', ...(over.signOff ?? AFFIRMATIVE_SIGNOFF) }];
      }),
    },
  };
  // $transaction runs its callback against the SAME delegate spies (so tx writes are observed).
  const db = { ...delegates, $transaction: vi.fn(async (fn: (tx: typeof delegates) => unknown) => fn(delegates)) } as unknown as AppDb;
  return { db, calls };
}

const cfg = { portalBaseUrl: 'https://emr.flatratenexus.com', adminBcc: 'admin@flatratenexus.com' };

describe('payment-delivery', () => {
  it('parseCaseRef strips the CASE_ prefix', () => {
    expect(parseCaseRef('CASE_ABC')).toBe('ABC');
    expect(parseCaseRef('ABC')).toBe('ABC');
    expect(parseCaseRef('')).toBeNull();
  });

  it('letter fee ($500) → records payment, flips case to paid, mints token, delivers', async () => {
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_1' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.paymentCreate).toHaveBeenCalled();
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    expect(calls.tokenCreate).toHaveBeenCalled();
  });

  it('letter fee ($350) → delivers exactly like $500 (records payment, paid, token, kind letter_350)', async () => {
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 35000, chargeId: 'pi_350' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.paymentCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'letter_350', amountCents: 35000 }) }));
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    expect(calls.tokenCreate).toHaveBeenCalled();
  });

  it('email throw → still success (delivered_email_pending), payment stays recorded, breadcrumb written, no Stripe retry', async () => {
    const { sendEmail } = await import('../services/mailer.js');
    (sendEmail as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('SES sandbox: email address not verified'));
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_email_fail' }, cfg);
    expect(r.status).toBe('delivered_email_pending');
    // Payment recording + token issuance happened BEFORE (and independent of) the email.
    expect(calls.paymentCreate).toHaveBeenCalled();
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    expect(calls.tokenCreate).toHaveBeenCalled();
    // Mandatory breadcrumb on email failure.
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payment_delivery_email_failed' }) }));
  });

  it('duplicate charge → idempotent no-op (no new payment)', async () => {
    const { db, calls } = makeDb({ existingPayment: true });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_1' }, cfg);
    expect(r.status).toBe('duplicate');
    expect(calls.paymentCreate).not.toHaveBeenCalled();
  });

  it('unhandled amount → ignored (no DB writes)', async () => {
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 12345, chargeId: 'x' }, cfg);
    expect(r.status).toBe('ignored_amount');
    expect(calls.paymentCreate).not.toHaveBeenCalled();
  });

  it('review fee ($50) → logged, NOT delivered (no token)', async () => {
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 5000, chargeId: 'pi_2' }, cfg);
    expect(r.status).toBe('logged');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
  });

  it('paid but no signed PDF → no_pdf (logged loudly, never a silent fail)', async () => {
    const { db, calls } = makeDb({ noPdf: true });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_3' }, cfg);
    expect(r.status).toBe('no_pdf');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payment_received_no_pdf' }) }));
  });

  it('concurrent duplicate (unique-index P2002 on payment.create) → duplicate, no delivery', async () => {
    const { db, calls } = makeDb();
    calls.paymentCreate.mockRejectedValueOnce({ code: 'P2002' }); // race: another webhook beat us
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_race' }, cfg);
    expect(r.status).toBe('duplicate');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
  });

  it('unknown case → no_case, breadcrumb written (only trace of a paid-but-unmatched charge)', async () => {
    const { db, calls } = makeDb({ noCase: true });
    const r = await processStripePayment(db, { caseId: 'NOPE', amountCents: 50000, chargeId: 'x' }, cfg);
    expect(r.status).toBe('no_case');
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payment_received_no_case' }) }));
    // The breadcrumb must NOT set the FK column — activity_log.case_id references cases, and this
    // caseId by definition matches none; setting it made the breadcrumb itself throw and the catch
    // swallowed the only evidence (Yorde 2026-06-12). The reference rides detailsJson only.
    const crumbCalls = calls.activity.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
    const crumb = crumbCalls.find((call) => call[0].data['action'] === 'payment_received_no_case')?.[0];
    expect(crumb?.data['caseId']).toBeUndefined();
    expect((crumb?.data['detailsJson'] as Record<string, unknown>)['clientReferenceId']).toBe('NOPE');
  });

  // ── Identity-unlock (HIPAA audit APP-1 fix, 2026-06-11) ──────────────────────────────────────

  it('delivery email is LINK-ONLY: carries link + expiry + the DOB/phone explanation, and NO password of any kind', () => {
    const t = buildDeliveryEmailText({ firstName: 'Sam', link: 'https://emr.flatratenexus.com/d/tok', expiresDays: 90 });
    expect(t).toContain('https://emr.flatratenexus.com/d/tok');
    expect(t).toContain('90 days');
    expect(t).toContain('date of birth');
    expect(t).toContain('last 4 digits');
    // The APP-1 regression guard: no password line, no password word implying one exists to enter.
    expect(t).not.toMatch(/Password:/i);
    // The review touch rides the delivery email (post-payment) — and the unlock instructions
    // must come BEFORE it (the email's job first, the favor after).
    expect(t).toContain('https://g.page/r/CaYDGwvikxZEEAE/review');
    expect(t.indexOf('date of birth')).toBeLessThan(t.indexOf('g.page'));
  });

  it('token PDF prefers the CURRENT approved LetterRevision over an older draftJob render', async () => {
    const { db, calls } = makeDb({ approvedRevision: true });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_rev' }, cfg);
    expect(r.status).toBe('delivered');
    // The veteran must receive what the physician approved (v7), never the stale drafter v5 render.
    expect(calls.tokenCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ letterVersion: 7, pdfS3Key: 'letter-revisions/C1/v7/letter.pdf' }),
    }));
  });

  it('RECONCILES the invoiced row to paid (never a second letter_500 row — the unique index made that P2002→silent rollback; Yorde 2026-06-12)', async () => {
    const { db, calls } = makeDb({ invoicedRow: true });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_yorde' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.paymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'P-INV' },
      data: expect.objectContaining({ status: 'paid', stripeChargeId: 'pi_yorde' }),
    }));
    expect(calls.paymentCreate).not.toHaveBeenCalled();
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    expect(calls.tokenCreate).toHaveBeenCalled();
  });

  it('mints an IDENTITY-mode token (passwordHash null) when the veteran has a usable phone', async () => {
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_idmode' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.tokenCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ passwordHash: null }) }));
    // No needs-phone breadcrumb when the phone is usable.
    expect(calls.activity).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'delivery_identity_unlock_needs_phone' }) }));
  });

  it('no usable phone on file → token still mints (identity-mode) + loud needs-phone breadcrumb', async () => {
    const { db, calls } = makeDb({ phone: null });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_nophone' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.tokenCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ passwordHash: null }) }));
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'delivery_identity_unlock_needs_phone' }) }));
  });

  // ── Delivery-eligibility gate (correction-round SSOT, audit 2026-06-13) ───────────────────────
  // A paid letter whose case has NO sign-off (or a non-affirmative one, or post-sign edited bytes)
  // must STILL record the payment + flip the case to paid (never lose money tracking) but mint NO
  // token, send NO email, and leave a LOUD breadcrumb so an admin can re-sign + deliver manually.

  it('NO sign-off → payment recorded + case flips to paid, but NO token minted + loud breadcrumb (blocked_ineligible)', async () => {
    const { db, calls } = makeDb({ signOff: null });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_nosign' }, cfg);
    expect(r.status).toBe('blocked_ineligible');
    // Money tracking is preserved: payment created, case -> paid.
    expect(calls.paymentCreate).toHaveBeenCalled();
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    // But delivery is withheld: no token, no email send.
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    // Loud breadcrumb naming the reason (the reason rides detailsJson, like the other breadcrumbs).
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payment_received_not_affirmative', detailsJson: expect.objectContaining({ reason: 'no_signoff' }) }) }));
  });

  it('NON-AFFIRMATIVE sign-off (a "No" attestation) → blocked_ineligible, payment+paid recorded, no token', async () => {
    const { db, calls } = makeDb({ signOff: { answersJson: { a: true, b: false }, signedVersion: 7, signedContentSha256: null } });
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_notaffirm' }, cfg);
    expect(r.status).toBe('blocked_ineligible');
    expect(calls.paymentCreate).toHaveBeenCalled();
    expect(calls.caseUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'paid' } }));
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    expect(calls.activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payment_received_not_affirmative', detailsJson: expect.objectContaining({ reason: 'signoff_not_affirmative' }) }) }));
  });

  it('ELIGIBLE-by-default (affirmative sign-off, byte check fails open with no s3) → delivers normally', async () => {
    // Guards that the gate does NOT over-block: the default affirmative sign-off + no-s3 cfg is eligible.
    const { db, calls } = makeDb();
    const r = await processStripePayment(db, { caseId: 'C1', amountCents: 50000, chargeId: 'pi_ok' }, cfg);
    expect(r.status).toBe('delivered');
    expect(calls.tokenCreate).toHaveBeenCalled();
  });
});
