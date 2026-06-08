import { describe, expect, it, vi } from 'vitest';
import { buildDeliveryEmailText, parseCaseRef, processStripePayment } from '../services/payment-delivery.js';
import type { AppDb } from '../services/db-types.js';

vi.mock('../services/mailer.js', () => ({
  sendEmail: vi.fn(async () => ({ sent: true, messageId: 'm1' })),
  readSecretByName: vi.fn(async () => 'whsec'),
}));

function makeDb(over: { existingPayment?: boolean; noPdf?: boolean; noCase?: boolean } = {}) {
  const calls = {
    paymentCreate: vi.fn(async () => ({})),
    caseUpdate: vi.fn(async () => ({})),
    tokenCreate: vi.fn(async () => ({})),
    activity: vi.fn(async () => ({})),
  };
  const delegates = {
    payment: { findFirst: vi.fn(async () => (over.existingPayment ? { id: 'P0' } : null)), create: calls.paymentCreate },
    case: { findFirst: vi.fn(async () => (over.noCase ? null : { id: 'C1', veteranId: 'V1' })), update: calls.caseUpdate },
    draftJob: { findMany: vi.fn(async () => (over.noPdf ? [] : [{ version: 5, artifactPdfS3Key: 'drafter-artifacts/C1/v5/letter.pdf' }])) },
    veteran: { findUnique: vi.fn(async () => ({ email: 'vet@example.com', firstName: 'Sam' })) },
    deliveryToken: { create: calls.tokenCreate },
    activityLog: { create: calls.activity },
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
  });

  it('delivery email carries the link + password + expiry', () => {
    const t = buildDeliveryEmailText({ firstName: 'Sam', link: 'https://emr.flatratenexus.com/d/tok', password: 'Abc234xyz', expiresDays: 90 });
    expect(t).toContain('https://emr.flatratenexus.com/d/tok');
    expect(t).toContain('Abc234xyz');
    expect(t).toContain('90 days');
  });
});
