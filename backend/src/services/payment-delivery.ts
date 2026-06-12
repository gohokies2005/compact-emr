import type { AppDb } from './db-types.js';
import { generateToken, phoneLast4 } from './delivery-token.js';
import { sendEmail } from './mailer.js';

// Stripe payment → password-portal delivery orchestration (Ryan 2026-06-06). Thin route, testable
// service. IDEMPOTENT on the Stripe charge id (a Payment row already on that charge = already handled).
const LETTER_FEE_CENTS = 50000;     // $500 letter fee → triggers delivery
const LETTER_350_FEE_CENTS = 35000; // $350 letter fee → triggers delivery (same path as $500)
const REVIEW_FEE_CENTS = 5000;      // $50 review fee → logged only
const TOKEN_TTL_DAYS = 90;
const STRIPE_ACTOR = 'service:stripe-webhook';

/** "CASE_<id>" or "<id>" → <id>. */
export function parseCaseRef(clientRef: string | null | undefined): string | null {
  if (typeof clientRef !== 'string' || !clientRef.trim()) return null;
  const v = clientRef.trim();
  return v.startsWith('CASE_') ? v.slice(5) : v;
}

function paymentKindForAmount(cents: number): 'letter_500' | 'letter_350' | 'review_50' | null {
  if (cents === LETTER_FEE_CENTS) return 'letter_500';
  if (cents === LETTER_350_FEE_CENTS) return 'letter_350';
  if (cents === REVIEW_FEE_CENTS) return 'review_50';
  return null;
}

async function resolveSignedPdf(db: AppDb, caseId: string, currentVersion: number): Promise<{ version: number; pdfS3Key: string } | null> {
  // PREFER the case's CURRENT letter (Case.currentVersion → LetterRevision) — the artifact the
  // physician actually approved/signed. The draftJob fallback alone shipped an OLDER render for any
  // case whose letter advanced via editor saves/approve after drafting (the Seam-B remediated cases
  // are exactly this shape: the approved v<N> is a LetterRevision; draft jobs stop at the drafter run).
  if (Number.isInteger(currentVersion) && currentVersion >= 1) {
    const rev = await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } }) as { version: number; artifactPdfS3Key: string | null } | null;
    if (rev && rev.artifactPdfS3Key) return { version: rev.version, pdfS3Key: rev.artifactPdfS3Key };
  }
  const jobs = await db.draftJob.findMany({ where: { caseId, artifactPdfS3Key: { not: null } }, orderBy: { version: 'desc' }, take: 1 }) as readonly { version: number; artifactPdfS3Key: string | null }[];
  const j = jobs[0];
  return j && j.artifactPdfS3Key ? { version: j.version, pdfS3Key: j.artifactPdfS3Key } : null;
}

export interface ProcessResult {
  readonly status: 'delivered' | 'delivered_email_pending' | 'logged' | 'duplicate' | 'no_case' | 'no_pdf' | 'ignored_amount';
  readonly emailId?: string;
  readonly reason?: string;
}

const isP2002 = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

export async function processStripePayment(
  db: AppDb,
  input: { caseId: string; amountCents: number; chargeId: string },
  cfg: { portalBaseUrl: string; adminBcc?: string },
): Promise<ProcessResult> {
  const { caseId, amountCents, chargeId } = input;
  const kind = paymentKindForAmount(amountCents);
  if (kind === null) {
    // A PAID session for an amount we don't recognize must be loud, not silently dropped (architect).
    await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_unrecognized_amount', caseId, detailsJson: { chargeId, amountCents } } }).catch(() => undefined);
    return { status: 'ignored_amount', reason: `unhandled amount ${amountCents}` };
  }

  // Fast-path idempotency (most retries); the partial-unique index on stripe_charge_id is the
  // RACE-SAFE backstop (concurrent retries → payment.create throws P2002, caught below).
  if (await db.payment.findFirst({ where: { stripeChargeId: chargeId } })) return { status: 'duplicate', reason: 'charge already processed' };

  const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true, currentVersion: true } }) as { id: string; veteranId: string; currentVersion: number } | null;
  if (c === null) {
    // A real PAID charge whose client_reference_id matched no EMR case leaves NO other trace (Stripe
    // gets 200 and never retries) — record a breadcrumb so an admin can reconcile it manually.
    await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_received_no_case', caseId, detailsJson: { chargeId, amountCents, clientReferenceId: caseId } } }).catch(() => undefined);
    return { status: 'no_case', reason: `case ${caseId} not found` };
  }

  const isLetter = kind === 'letter_500' || kind === 'letter_350';
  // Reads + pure generation happen BEFORE the transaction (no side effects to roll back).
  const pdf = isLetter ? await resolveSignedPdf(db, caseId, c.currentVersion) : null;
  const vet = isLetter && pdf !== null ? ((await db.veteran.findUnique({ where: { id: c.veteranId } })) as { email?: string; firstName?: string; phone?: string | null } | null) : null;
  const token = generateToken();
  // Unlock mode (HIPAA audit APP-1 fix, Ryan 2026-06-11): when the veteran has a usable phone on
  // file, mint an IDENTITY-mode token (passwordHash null — the portal verifies DOB + phone last-4,
  // nothing secret ever rides the email). Only when the phone is missing/garbled do we fall back
  // to a password token — and even then the password is NEVER emailed (staff texts it out-of-band;
  // the loud breadcrumb below tells them to).
  const phoneUsable = phoneLast4(vet?.phone ?? null) !== null;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  // All writes in ONE transaction so a partial failure can't leave paid-but-no-token. The unique index
  // makes a concurrent duplicate throw P2002 → 'duplicate'. The EMAIL is sent AFTER commit (an SES
  // failure must not roll back a recorded payment).
  try {
    await db.$transaction(async (tx) => {
      await tx.payment.create({ data: { caseId, kind, amountCents, status: 'paid', settledAt: new Date(), stripeChargeId: chargeId } });
      if (!isLetter) {
        await tx.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_logged', caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents, kind } } });
        return;
      }
      await tx.case.update({ where: { id: caseId }, data: { status: 'paid' } });
      if (pdf === null) {
        // Paid but no signed PDF — log loudly so an admin can deliver manually (money recorded, case paid).
        await tx.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_received_no_pdf', caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents } } });
        return;
      }
      // ALL new tokens are identity-mode (passwordHash null) — the unlock is DOB + phone last-4,
      // so nothing secret exists to transmit or convey. (generatePassword/hashPassword remain only
      // for legacy tokens minted before this fix; verifyPassword still honors them at the portal.)
      await tx.deliveryToken.create({ data: { caseId, token, passwordHash: null, letterVersion: pdf.version, pdfS3Key: pdf.pdfS3Key, expiresAt } });
      if (!phoneUsable) {
        // No usable phone on file → the veteran CANNOT pass identity unlock until staff adds one.
        // Loud breadcrumb: verify the veteran out-of-band, add their phone to the Veteran record,
        // and the existing link starts working — no re-issue needed.
        await tx.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'delivery_identity_unlock_needs_phone', caseId, veteranId: c.veteranId, detailsJson: { chargeId, reason: 'no usable phone on file — add phone to veteran record to enable identity unlock' } } });
      }
    });
  } catch (e) {
    if (isP2002(e)) return { status: 'duplicate', reason: 'charge already processed (race)' };
    throw e;
  }

  if (!isLetter) return { status: 'logged' };
  if (pdf === null) return { status: 'no_pdf', reason: 'no signed PDF found for case' };

  // POST-COMMIT: email the portal link + password. The payment, case→paid, and DeliveryToken are
  // ALREADY committed above. If the email throws (e.g. SES sandbox rejects an external veteran
  // address until production access), we must NOT let Stripe retry: a retry hits the idempotency dup
  // and would never re-send → silent half-delivery. So we breadcrumb the failure and STILL return
  // success. The token persists, so the email is re-sendable later.
  let emailId: string | undefined;
  if (vet?.email) {
    const link = `${cfg.portalBaseUrl.replace(/\/$/, '')}/d/${token}`;
    const text = buildDeliveryEmailText({ firstName: vet.firstName, link, expiresDays: TOKEN_TTL_DAYS });
    try {
      const r = await sendEmail({ to: vet.email, subject: 'Your nexus letter is ready', textBody: text, ...(cfg.adminBcc ? { bcc: cfg.adminBcc } : {}) });
      emailId = r.messageId;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_delivery_email_failed', caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents, token, emailTo: vet.email, error: errMsg } } }).catch(() => undefined);
      return { status: 'delivered_email_pending', reason: `token issued; delivery email failed: ${errMsg}` };
    }
  }
  await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_delivered', caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents, tokenIssued: true, emailedTo: vet?.email ?? null } } });
  return { status: 'delivered', emailId };
}

// Link-ONLY delivery email (HIPAA audit APP-1 fix): no password, no secret of any kind in transit.
// The portal verifies the veteran with their date of birth + the last 4 digits of their phone —
// things they already know — so a compromised or mis-forwarded mailbox gets a link it cannot open.
export function buildDeliveryEmailText(input: { firstName?: string; link: string; expiresDays: number }): string {
  const hi = input.firstName ? `Hi ${input.firstName},` : 'Hello,';
  return [
    hi, '',
    'Thank you. Your nexus letter is ready. For your security it is available through a private,',
    'verified link rather than as an email attachment.', '',
    `Link: ${input.link}`, '',
    'When you open the link, you will be asked to confirm your date of birth and the last 4 digits',
    'of your phone number. That is all you need — there is no password to keep track of.', '',
    `This link is valid for ${input.expiresDays} days. Open it, verify, and download your letter (PDF).`, '',
    'Thank you,', 'Flat Rate Nexus', 'flatratenexus.com', '',
    'All correspondence should be directed to info@flatratenexus.com.', '',
    // Passive review touch — AFTER payment + delivery, never on the invoice (Ryan 2026-06-11:
    // the invoice has one job; the review ask rides the moment the value lands).
    'P.S. If our work helped you, a quick Google review helps other veterans find us:',
    'https://g.page/r/CaYDGwvikxZEEAE/review',
  ].join('\n');
}
