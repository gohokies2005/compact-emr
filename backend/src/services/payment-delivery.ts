import type { AppDb } from './db-types.js';
import { generatePassword, generateToken, hashPassword } from './delivery-token.js';
import { sendEmail } from './mailer.js';

// Stripe payment → password-portal delivery orchestration (Ryan 2026-06-06). Thin route, testable
// service. IDEMPOTENT on the Stripe charge id (a Payment row already on that charge = already handled).
const LETTER_FEE_CENTS = 50000; // $500 letter fee → triggers delivery
const REVIEW_FEE_CENTS = 5000;  // $50 review fee → logged only
const TOKEN_TTL_DAYS = 90;
const STRIPE_ACTOR = 'service:stripe-webhook';

/** "CASE_<id>" or "<id>" → <id>. */
export function parseCaseRef(clientRef: string | null | undefined): string | null {
  if (typeof clientRef !== 'string' || !clientRef.trim()) return null;
  const v = clientRef.trim();
  return v.startsWith('CASE_') ? v.slice(5) : v;
}

function paymentKindForAmount(cents: number): 'letter_500' | 'review_50' | null {
  if (cents === LETTER_FEE_CENTS) return 'letter_500';
  if (cents === REVIEW_FEE_CENTS) return 'review_50';
  return null;
}

async function resolveSignedPdf(db: AppDb, caseId: string): Promise<{ version: number; pdfS3Key: string } | null> {
  const jobs = await db.draftJob.findMany({ where: { caseId, artifactPdfS3Key: { not: null } }, orderBy: { version: 'desc' }, take: 1 }) as readonly { version: number; artifactPdfS3Key: string | null }[];
  const j = jobs[0];
  return j && j.artifactPdfS3Key ? { version: j.version, pdfS3Key: j.artifactPdfS3Key } : null;
}

export interface ProcessResult {
  readonly status: 'delivered' | 'logged' | 'duplicate' | 'no_case' | 'no_pdf' | 'ignored_amount';
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

  const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true } });
  if (c === null) return { status: 'no_case', reason: `case ${caseId} not found` };

  const isLetter = kind === 'letter_500';
  // Reads + pure generation happen BEFORE the transaction (no side effects to roll back).
  const pdf = isLetter ? await resolveSignedPdf(db, caseId) : null;
  const vet = isLetter && pdf !== null ? ((await db.veteran.findUnique({ where: { id: c.veteranId } })) as { email?: string; firstName?: string } | null) : null;
  const token = generateToken();
  const password = generatePassword();
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
      await tx.deliveryToken.create({ data: { caseId, token, passwordHash: hashPassword(password), letterVersion: pdf.version, pdfS3Key: pdf.pdfS3Key, expiresAt } });
    });
  } catch (e) {
    if (isP2002(e)) return { status: 'duplicate', reason: 'charge already processed (race)' };
    throw e;
  }

  if (!isLetter) return { status: 'logged' };
  if (pdf === null) return { status: 'no_pdf', reason: 'no signed PDF found for case' };

  // POST-COMMIT: email the portal link + password.
  let emailId: string | undefined;
  if (vet?.email) {
    const link = `${cfg.portalBaseUrl.replace(/\/$/, '')}/d/${token}`;
    const text = buildDeliveryEmailText({ firstName: vet.firstName, link, password, expiresDays: TOKEN_TTL_DAYS });
    const r = await sendEmail({ to: vet.email, subject: 'Your nexus letter is ready', textBody: text, ...(cfg.adminBcc ? { bcc: cfg.adminBcc } : {}) });
    emailId = r.messageId;
  }
  await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_delivered', caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents, tokenIssued: true, emailedTo: vet?.email ?? null } } });
  return { status: 'delivered', emailId };
}

export function buildDeliveryEmailText(input: { firstName?: string; link: string; password: string; expiresDays: number }): string {
  const hi = input.firstName ? `Hi ${input.firstName},` : 'Hello,';
  return [
    hi, '',
    'Thank you. Your nexus letter is ready. For your security it is available through a private,',
    'password-protected link rather than as an email attachment.', '',
    `Link: ${input.link}`,
    `Password: ${input.password}`, '',
    `This link is valid for ${input.expiresDays} days. Open it, enter the password, and download your letter (PDF).`, '',
    'Thank you,', 'Flat Rate Nexus', 'flatratenexus.com', '',
    'All correspondence should be directed to info@flatratenexus.com.',
  ].join('\n');
}
