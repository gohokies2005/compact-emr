import { type S3Client } from '@aws-sdk/client-s3';
import type { AppDb } from './db-types.js';
import { generateToken, phoneLast4 } from './delivery-token.js';
import { sendEmail } from './mailer.js';
import { assertDeliveryEligible } from './delivery-eligibility.js';

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

export async function resolveSignedPdf(db: AppDb, caseId: string, currentVersion: number): Promise<{ version: number; pdfS3Key: string } | null> {
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
  readonly status: 'delivered' | 'delivered_email_pending' | 'logged' | 'duplicate' | 'no_case' | 'no_pdf' | 'blocked_ineligible' | 'ignored_amount';
  readonly emailId?: string;
  readonly reason?: string;
}

const isP2002 = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

export async function processStripePayment(
  db: AppDb,
  input: { caseId: string; amountCents: number; chargeId: string },
  // s3 + bucketName feed the delivery-eligibility byte re-hash (correction-round SSOT, audit
  // 2026-06-13). The real Stripe→portal egress previously had NO sign/byte gate — a version
  // advanced after sign-off shipped unsigned/wrong bytes. They are OPTIONAL: when absent the byte
  // step fails open (same as delivery.ts), but the sign-off exists + affirmative checks still run.
  cfg: { portalBaseUrl: string; adminBcc?: string; s3?: S3Client; bucketName?: string },
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
    // NO caseId on the row: activity_log.case_id is an FK, and by definition this caseId matches no
    // case — setting it made the breadcrumb ITSELF throw (FK violation) and the .catch ate the only
    // evidence (Yorde incident 2026-06-12). The unmatched reference lives in detailsJson instead.
    await db.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action: 'payment_received_no_case', detailsJson: { chargeId, amountCents, clientReferenceId: caseId } } }).catch((e) => { console.warn('[payment] no_case breadcrumb failed:', e); });
    return { status: 'no_case', reason: `case ${caseId} not found` };
  }

  const isLetter = kind === 'letter_500' || kind === 'letter_350';

  // ── DELIVERY-ELIGIBILITY GATE (correction-round SSOT, audit 2026-06-13) ── The REAL patient egress.
  // Before minting a DeliveryToken + emailing the portal link, the letter must pass the same sign/byte
  // contract the RN delivery panel enforces: an AFFIRMATIVE physician sign-off bound to the CURRENT
  // letter bytes. Without this gate a version advanced after sign-off (an editor save, a correction
  // round, a bare status flip) shipped UNSIGNED or WRONG bytes — a signed legal opinion the physician
  // never attested to, for money. CRITICAL: the payment is ALWAYS recorded + the case ALWAYS flips to
  // paid (we never lose money tracking); only the DELIVERY (token + email) is withheld. An ineligible
  // case takes the same shape as the pdf===null branch below (paid, loud breadcrumb, no token), so an
  // admin can re-sign + deliver manually. Byte step fails open exactly where assertDeliveryEligible /
  // delivery.ts do (legacy/no-hash sign-off, or S3/bucket unconfigured); exists + affirmative do NOT.
  const eligibility = isLetter
    ? await assertDeliveryEligible(db, caseId, c.currentVersion, { ...(cfg.s3 ? { s3: cfg.s3 } : {}), ...(cfg.bucketName ? { bucketName: cfg.bucketName } : {}) })
    : { eligible: true as const };
  if (isLetter && !eligibility.eligible) {
    const action = eligibility.reason === 'signed_bytes_changed' ? 'payment_received_unsigned_bytes' : 'payment_received_not_affirmative';
    try {
      await db.$transaction(async (tx) => {
        const invoicedRow = await tx.payment.findFirst({ where: { caseId, kind, status: 'invoiced' } });
        if (invoicedRow !== null) {
          await tx.payment.update({ where: { id: invoicedRow.id }, data: { status: 'paid', settledAt: new Date(), stripeChargeId: chargeId } });
        } else {
          await tx.payment.create({ data: { caseId, kind, amountCents, status: 'paid', settledAt: new Date(), stripeChargeId: chargeId } });
        }
        await tx.case.update({ where: { id: caseId }, data: { status: 'paid' } });
        // LOUD breadcrumb: money recorded + case paid, but NO token/email — the letter is not
        // deliverable until it is re-signed against its current bytes. An admin re-signs, then
        // re-issues delivery (the token path is intact; nothing was minted to clean up).
        await tx.activityLog.create({ data: { actorUserId: STRIPE_ACTOR, action, caseId, veteranId: c.veteranId, detailsJson: { chargeId, amountCents, reason: eligibility.reason, ...(eligibility.details ?? {}) } } });
      });
    } catch (e) {
      if (isP2002(e)) return { status: 'duplicate', reason: 'charge already processed (race)' };
      throw e;
    }
    return { status: 'blocked_ineligible', reason: `delivery blocked: ${eligibility.reason}` };
  }

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
      // RECONCILE the invoiced row instead of inserting a second one (Yorde live incident
      // 2026-06-12): the invoice-idempotency unique index (payments_case_id_letter_500_uq,
      // ONE letter_500 row per case) made the webhook's paid-row INSERT throw P2002 — which the
      // catch below read as 'charge already processed' → the WHOLE payment (case flip, token,
      // email) silently rolled back while reporting 200/duplicate to Stripe. The invoice row
      // becoming the paid row is also the correct ledger shape (no forever-'invoiced' orphans).
      const invoicedRow = await tx.payment.findFirst({ where: { caseId, kind, status: 'invoiced' } });
      if (invoicedRow !== null) {
        await tx.payment.update({ where: { id: invoicedRow.id }, data: { status: 'paid', settledAt: new Date(), stripeChargeId: chargeId } });
      } else {
        await tx.payment.create({ data: { caseId, kind, amountCents, status: 'paid', settledAt: new Date(), stripeChargeId: chargeId } });
      }
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

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// RN "Publish corrected letter" re-issue (Ryan 2026-07-03). When an already-DELIVERED-and-PAID letter is
// surgically corrected (a detail added) and re-signed, the customer's existing download link is FROZEN on
// the OLD version — a DeliveryToken's pdfS3Key/letterVersion are captured once at Stripe-payment time and
// nothing re-points them. This mints a FRESH identity-mode token bound to the CORRECTED version's signed
// PDF, EXPIRES all prior tokens (so the stale version can no longer be pulled), and emails the veteran a new
// portal link. NO new charge (a minor correction to a paid letter is not a new $500; a new THEORY still is).
//
// SAFETY: reuses the SAME sign/byte egress gate the money path uses (assertDeliveryEligible) — a corrected
// letter that is not signed + byte-consistent on its current version is REFUSED (physician must re-sign
// first). It also requires a PRIOR token to exist (proof the letter was already delivered to a paying
// customer), so this can never be used to deliver a letter that was never paid for (that stays the Stripe
// path). s3 + bucketName are REQUIRED here (we do NOT fail the byte check open on a re-publish).
export interface ReissueResult {
  readonly status:
    | 'reissued'
    | 'reissued_email_pending'
    | 'already_current'
    | 'no_case'
    | 'no_prior_delivery'
    | 'ineligible'
    | 'no_pdf';
  readonly emailId?: string;
  readonly reason?: string;
  readonly version?: number;
}

export async function reissueCorrectedDelivery(
  db: AppDb,
  input: { caseId: string; actorUserId: string },
  cfg: { portalBaseUrl: string; adminBcc?: string; s3: S3Client; bucketName: string },
): Promise<ReissueResult> {
  const { caseId, actorUserId } = input;
  const c = (await db.case.findFirst({
    where: { id: caseId },
    select: { id: true, veteranId: true, currentVersion: true, status: true },
  })) as { id: string; veteranId: string; currentVersion: number; status: string } | null;
  if (c === null) return { status: 'no_case' };

  // A prior DeliveryToken = the customer was already delivered a link (tokens mint only at payment). No
  // prior token → this letter was never paid-delivered; use the normal invoice→pay flow, not a re-issue.
  // Fetch the LATEST token (createdAt desc) — it holds the version the customer can currently access.
  const latestToken = (await db.deliveryToken.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' } })) as
    | { token: string; letterVersion: number; expiresAt: Date; createdAt: Date }
    | null;
  if (latestToken === null) {
    return { status: 'no_prior_delivery', reason: 'no delivery token exists for this case — use the normal delivery flow' };
  }

  // Same sign/byte contract as the money egress: the CURRENT version must carry an affirmative sign-off
  // bound to its current bytes. A correction that was not re-signed is REFUSED here (never fail-open).
  const eligibility = await assertDeliveryEligible(db, caseId, c.currentVersion, { s3: cfg.s3, bucketName: cfg.bucketName });
  if (!eligibility.eligible) {
    return { status: 'ineligible', reason: eligibility.reason };
  }
  // FAIL-CLOSED on a legacy sign-off with no bound content hash (byteCheckSkipped). The money path must
  // honor legacy already-paid cases and fails OPEN there, but a CORRECTION is by definition freshly
  // re-signed — so a corrected letter with no modern byte-binding means it was NOT re-signed; refuse it.
  if (eligibility.details?.byteCheckSkipped === true) {
    return { status: 'ineligible', reason: 'signoff_not_byte_bound' };
  }

  const pdf = await resolveSignedPdf(db, caseId, c.currentVersion);
  if (pdf === null) return { status: 'no_pdf' };

  const vet = (await db.veteran.findUnique({ where: { id: c.veteranId } })) as { email?: string; firstName?: string; phone?: string | null } | null;

  // Send the corrected-letter portal email for a given token. Returns the SES messageId (or undefined when
  // the veteran has no email on file). Throws on an SES failure so the caller can breadcrumb + return pending.
  const sendCorrectedEmail = async (tok: string): Promise<string | undefined> => {
    if (vet?.email === undefined || vet.email.length === 0) return undefined;
    const link = `${cfg.portalBaseUrl.replace(/\/$/, '')}/d/${tok}`;
    const text = buildCorrectedDeliveryEmailText({ firstName: vet.firstName, link, expiresDays: TOKEN_TTL_DAYS });
    const r = await sendEmail({ to: vet.email, subject: 'Your updated nexus letter is ready', textBody: text, ...(cfg.adminBcc ? { bcc: cfg.adminBcc } : {}) });
    return r.messageId;
  };

  // SAME-VERSION handling (idempotent + self-healing). If the latest token already serves the CURRENT
  // version, there is no NEW correction to publish — UNLESS that token's delivery email never actually went
  // out (an SES failure on a prior publish). A CONFIRMED delivery is a success breadcrumb (the original
  // payment_delivered, or a prior delivery_correction_published) stamped at/after the token was created.
  //   - delivered → true no-op (handles an unchanged letter whose link is active OR expired; NO false
  //     "we updated your letter" email — reviewer finding #3).
  //   - not delivered → the token was minted but its email failed; RE-SEND for the SAME token, no new mint,
  //     no re-expire (self-heals the stranded-customer case — reviewer finding #5).
  if (latestToken.letterVersion === pdf.version) {
    const deliveredLog = await db.activityLog.findFirst({
      where: { caseId, action: { in: ['payment_delivered', 'delivery_correction_published'] }, ts: { gte: latestToken.createdAt } },
    });
    if (deliveredLog !== null) {
      return { status: 'already_current', version: pdf.version };
    }
    try {
      const emailId = await sendCorrectedEmail(latestToken.token);
      await db.activityLog.create({ data: { actorUserId, action: 'delivery_correction_published', caseId, veteranId: c.veteranId, detailsJson: { version: pdf.version, emailedTo: vet?.email ?? null, resend: true } } });
      return { status: 'reissued', version: pdf.version, ...(emailId !== undefined ? { emailId } : {}) };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await db.activityLog.create({ data: { actorUserId, action: 'delivery_correction_email_failed', caseId, veteranId: c.veteranId, detailsJson: { token: latestToken.token, emailTo: vet?.email ?? null, error: errMsg } } }).catch(() => undefined);
      return { status: 'reissued_email_pending', reason: `corrected link retry failed: ${errMsg}`, version: pdf.version };
    }
  }

  // NEW corrected version → mint a fresh token, expire the stale ones, restore paid, then email.
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  // Was this letter already PAID? (a token exists, so it was — but confirm the ledger to decide whether to
  // restore the 'paid' terminal, since the correction round left the case at 'delivered' post-approve.)
  const paidRow = await db.payment.findFirst({ where: { caseId, kind: { in: ['letter_500', 'letter_350'] }, status: 'paid' } });
  const now = new Date();

  await db.$transaction(async (tx) => {
    // EXPIRE every still-active token so the veteran can no longer pull the STALE (pre-correction) PDF.
    await tx.deliveryToken.updateMany({ where: { caseId, expiresAt: { gt: now } }, data: { expiresAt: now } });
    // Mint the corrected identity-mode token (DOB + phone last-4 unlock; nothing secret in transit).
    await tx.deliveryToken.create({ data: { caseId, token, passwordHash: null, letterVersion: pdf.version, pdfS3Key: pdf.pdfS3Key, expiresAt } });
    // Restore the billed-terminal 'paid' status (the correction round left the case at 'delivered' after
    // /letter/approve). Billing is untouched — no new charge, no refund; this is only the status label.
    if (paidRow !== null && c.status !== 'paid') {
      await tx.case.update({ where: { id: caseId }, data: { status: 'paid' } });
    }
    await tx.activityLog.create({ data: { actorUserId, action: 'delivery_correction_reissued', caseId, veteranId: c.veteranId, detailsJson: { version: pdf.version, expiredPriorTokens: true, recharged: false } } });
  });

  // POST-COMMIT email (an SES failure must not roll back the token — it persists and re-sends via the
  // self-healing same-version path above on the next publish click).
  try {
    const emailId = await sendCorrectedEmail(token);
    await db.activityLog.create({ data: { actorUserId, action: 'delivery_correction_published', caseId, veteranId: c.veteranId, detailsJson: { version: pdf.version, emailedTo: vet?.email ?? null } } });
    return { status: 'reissued', version: pdf.version, ...(emailId !== undefined ? { emailId } : {}) };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db.activityLog.create({ data: { actorUserId, action: 'delivery_correction_email_failed', caseId, veteranId: c.veteranId, detailsJson: { token, emailTo: vet?.email ?? null, error: errMsg } } }).catch(() => undefined);
    return { status: 'reissued_email_pending', reason: `corrected token issued; delivery email failed: ${errMsg}`, version: pdf.version };
  }
}

// The corrected-letter portal email. Same identity-unlock link-only shape as the first delivery email, with
// copy that signals this is an UPDATED letter replacing the prior one (so the veteran uses the new link).
export function buildCorrectedDeliveryEmailText(input: { firstName?: string; link: string; expiresDays: number }): string {
  const hi = input.firstName ? `Hi ${input.firstName},` : 'Hello,';
  return [
    hi, '',
    'Your nexus letter has been updated with the additional details, and the revised version is ready. It',
    'replaces the earlier one. For your security it is available through a private, verified link rather than',
    'as an email attachment.', '',
    `Link: ${input.link}`, '',
    'When you open the link, you will be asked to confirm your date of birth and the last 4 digits of your',
    'phone number. That is all you need — there is no password to keep track of.', '',
    `Please use THIS link for the current version; any earlier download link no longer works. This link is`,
    `valid for ${input.expiresDays} days.`, '',
    'Thank you,', 'Flat Rate Nexus', 'flatratenexus.com', '',
    'All correspondence should be directed to info@flatratenexus.com.',
  ].join('\n');
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
    'P.S. If our work helped you, a quick review helps other veterans find us:',
    'Google: https://g.page/r/CaYDGwvikxZEEAE/review',
    'Trustpilot: https://www.trustpilot.com/review/flatratenexus.com',
    'And if you\'re ever in r/Veterans or r/VeteransBenefits and see someone asking where to get a nexus letter — a word from you carries more weight than any ad we could run.',
  ].join('\n');
}
