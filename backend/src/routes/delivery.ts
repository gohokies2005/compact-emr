import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { parseCredentialBlock, KASKY_CREDENTIALS } from '../services/credential-block.js';
import { getAiViabilityState } from '../services/ai-viability.js';
import { buildOpinionExcerpt } from '../services/letter-opinion-excerpt.js';
import {
  buildDeliveryEmail,
  buildCoverMemoText,
  DELIVERY_FROM_ADDRESS,
  DELIVERY_EMAIL_SUBJECT,
  type CoverMemoPathway,
} from '../services/delivery-templates.js';
import {
  isStripeConfigured,
  buildStripeLink,
  isEmailTransportConfigured,
  coverMemoRequirement,
} from '../services/delivery-config.js';
import { resolveCurrentRevisionMeta } from '../services/letter-current.js';
import { assertDeliveryEligible } from '../services/delivery-eligibility.js';
import { sendEmail } from '../services/mailer.js';
import { renderMemoPdf } from '../services/memo-render.js';
import type { AppDb } from '../services/db-types.js';

/**
 * Post-approval DELIVERY workflow (cloud). Shown once the physician approves (POST
 * /cases/:id/letter/approve sets status='delivered'). The RN verifies the letter + memo, confirms,
 * then sends the ONE fixed delivery email from info@ with the §VII+§VIII excerpt and the Stripe
 * link. Both external sends (Stripe + email) are STUBBED here: the route composes + persists and
 * reports whether each is configured, so the operator drops in secrets later with no code change.
 *
 * Idempotency: POST /send re-uses an existing outbound delivery Email + letter_500 Payment for the
 * case rather than duplicating (a double-click or retry is safe). Additive — touches only the
 * already-existing Email/Payment tables and never mutates the approve/sign/draft flows.
 */

const LETTER_500_CENTS = 50000;
// The delivery panel only applies once the letter is finalized.
const DELIVERY_STATUSES: ReadonlySet<string> = new Set(['delivered', 'paid']);
// Cover-memo presigned-GET lifetime — short, single-use "open in a new tab" window (mirrors the
// letter-editor's PRESIGN_TTL_SECONDS). The RN clicks "Verify the cover memo" and the browser opens
// it immediately; 5 minutes is ample and keeps the URL from lingering as a usable PHI link.
const MEMO_PRESIGN_TTL_SECONDS = 300;

export interface DeliveryRouterDeps {
  s3?: S3Client;
  bucketName?: string;
}

interface CurrentLetter {
  version: number;
  txtKey: string;
  pdfKey: string | null;
}

export function createDeliveryRouter(db: AppDb, deps: DeliveryRouterDeps = {}): Router {
  const router = Router();
  const s3 = (): S3Client => deps.s3 ?? new S3Client({});
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // Resolve the current letter's artifacts strictly by Case.currentVersion (single source of
  // truth) — same resolution the letter editor uses. Prefer the LetterRevision row; fall back to
  // the DraftJob row for drafted-but-pre-mirror cases.
  async function resolveCurrent(caseId: string, currentVersion: number): Promise<CurrentLetter | null> {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) return null;
    const rev = await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } });
    if (rev !== null) return { version: rev.version, txtKey: rev.artifactTxtS3Key, pdfKey: rev.artifactPdfS3Key };
    const job = await db.draftJob.findFirst({ where: { caseId, version: currentVersion } });
    if (job !== null && typeof job.artifactTxtS3Key === 'string') {
      return { version: job.version, txtKey: job.artifactTxtS3Key, pdfKey: job.artifactPdfS3Key };
    }
    return null;
  }

  async function readTxtFromS3(bucketName: string, key: string): Promise<string> {
    const obj = await s3().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (obj.Body === undefined) {
      throw new HttpError(502, 'internal_error', 'Letter TXT object had no body.', { reason: 'read_failed', key });
    }
    return obj.Body.transformToString('utf-8');
  }

  // Compose the cover memo (predicate + text) for a case row. Shared by composeDelivery and the
  // memo.pdf route (E4) so the PDF can never diverge from the preview text — and so the PDF route
  // does not need the letter TXT / S3 at all (the memo is built from the Case + physician rows).
  async function composeMemo(c: {
    id: string;
    claimType: string;
    previouslyDenied: boolean | null;
    priorDenialReason: string | null;
    priorDecisionDate: Date | null;
    claimedCondition: string;
    assignedPhysicianId: string | null;
    coverMemoSuppressed?: boolean | null;
    coverMemoTextOverride?: string | null;
  }, vFirst: string | null, vLast: string): Promise<{
    required: boolean;
    pathway: CoverMemoPathway | null;
    reason: string;
    text: string | null;
  }> {
    // (C) SUPPRESS (Dr. Kasky 2026-06-26, Spring): staff chose to send ONLY the nexus letter, no cover
    // memo. Drop the memo out of the preview + confirm gate; the memo.pdf route 404s via its !required guard.
    if (c.coverMemoSuppressed === true) {
      return { required: false, pathway: null, reason: 'suppressed_by_staff', text: null };
    }
    const req = coverMemoRequirement({
      claimType: c.claimType,
      previouslyDenied: c.previouslyDenied,
      priorDenialReason: c.priorDenialReason,
    });
    let memoText: string | null = null;
    if (req.required && req.pathway !== null) {
      let signer = KASKY_CREDENTIALS;
      if (c.assignedPhysicianId !== null) {
        const phys = await db.physician.findFirst({ where: { id: c.assignedPhysicianId } });
        const creds = phys ? parseCredentialBlock(phys.credentialBlockJson) : null;
        if (creds !== null) signer = creds;
      }
      // (C) EDIT: a staff text override replaces the composed memo entirely. Guard the signature anchor —
      // renderMemoPdf throws without [SIGNATURE]; if the editor removed it, re-append the signer block so
      // the PDF still composites the signature. (Dr. Kasky 2026-06-26 — "i need to be able to edit that file".)
      const override = typeof c.coverMemoTextOverride === 'string' ? c.coverMemoTextOverride.trim() : '';
      if (override.length > 0) {
        memoText = override.includes('[SIGNATURE]')
          ? override
          : `${override}\n\nRespectfully submitted,\n\n[SIGNATURE]\n${signer.fullNameWithCredential}`;
      } else {
        // (B) condition LABEL from the route-picker plan (the letter's actual theory), NOT the broad intake
        // claim bucket (Spring: memo said "Skin (eczema, Psoriasis, Dermatitis, Scars)" but the letter was
        // direct ACNE). Falls back to claimedCondition when no ready plan. $0 read-only.
        let memoCondition = c.claimedCondition;
        try {
          const ai = await getAiViabilityState(db, c.id, { compute: false });
          if (ai.status === 'ready' && typeof ai.card.lead.claimed === 'string' && ai.card.lead.claimed.trim().length > 0) {
            memoCondition = ai.card.lead.claimed.trim();
          }
        } catch { /* fall back to claimedCondition */ }
        memoText = buildCoverMemoText({
          pathway: req.pathway,
          veteranFullName: `${vFirst ?? ''} ${vLast}`.trim(),
          veteranLastName: vLast,
          claimedCondition: memoCondition,
          priorDecisionDate: c.priorDecisionDate ? c.priorDecisionDate.toISOString().slice(0, 10) : null,
          signer,
        });
      }
    }
    return { required: req.required, pathway: req.pathway, reason: req.reason, text: memoText };
  }

  // Compose the full delivery preview for a case: excerpt + email body + memo (when applicable) +
  // configured flags + Stripe link + any already-saved delivery email/payment. Shared by GET and
  // POST so the two never diverge.
  async function composeDelivery(caseId: string): Promise<{
    version: number;
    excerpt: ReturnType<typeof buildOpinionExcerpt>;
    email: { subject: string; fromAddress: string; body: string };
    memo: { applies: boolean; pathway: CoverMemoPathway | null; reason: string; text: string | null; suppressed: boolean; textOverridden: boolean };
    stripe: { configured: boolean; link: string | null };
    emailTransport: { configured: boolean };
    savedEmail: { id: string; subject: string; body: string; sentAt: Date | null; status: string } | null;
    savedPayment: { id: string; kind: string; amountCents: number; status: string } | null;
    status: string;
  }> {
    const c = await db.case.findFirst({ where: { id: caseId } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
    if (!DELIVERY_STATUSES.has(c.status)) {
      throw new HttpError(409, 'conflict', `Delivery is available only after the letter is finalized (status delivered/paid). Current status: '${c.status}'.`, { reason: 'not_deliverable', caseId, status: c.status });
    }

    const bucketName = bucket();
    if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
    const cur = await resolveCurrent(caseId, c.currentVersion);
    if (cur === null) throw new HttpError(409, 'conflict', 'No finalized letter to deliver.', { reason: 'no_letter', caseId });

    // §VII/§VIII excerpt for the veteran email. For an external_import letter the TXT is a
    // placeholder (the canonical content is the imported PDF), so buildOpinionExcerpt would return
    // an empty/garbled block — the imported letter's whole point. Skip the TXT-derived excerpt for
    // imports; the signed PDF (attached/linked in the delivery email) carries the opinion. (consistency
    // sweep fixes, 2026-06-14.)
    const revMeta = await resolveCurrentRevisionMeta(db, caseId, c.currentVersion);
    const isExternalImport = revMeta !== null && revMeta.source === 'external_import';
    const excerpt = isExternalImport
      ? buildOpinionExcerpt('')
      : buildOpinionExcerpt(await readTxtFromS3(bucketName, cur.txtKey));

    const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
    const vFirst = (veteran as { firstName?: string } | null)?.firstName ?? null;
    const vLast = (veteran as { lastName?: string } | null)?.lastName ?? '';

    const stripeConfigured = isStripeConfigured();
    const stripeLink = buildStripeLink(caseId);
    const email = buildDeliveryEmail({ veteranFirstName: vFirst, excerptBlock: excerpt.block, stripeLink });

    // Cover-memo predicate (mirror of local FRN single source). When it applies, build the TEXT
    // using the ASSIGNED physician's credential block (D2); fall back to Kasky only if no assigned
    // physician credential is on file (so a memo preview still renders rather than dead-ending).
    const memo = await composeMemo(c, vFirst, vLast);

    // Existing saved delivery artifacts (idempotency surface). The delivery email is the outbound
    // email from info@ with our fixed subject; the payment is the letter_500 row.
    const savedEmailRow = await db.email.findFirst({
      where: { caseId, direction: 'outbound', fromAddress: DELIVERY_FROM_ADDRESS, subject: DELIVERY_EMAIL_SUBJECT },
      orderBy: { createdAt: 'desc' },
    });
    const savedPaymentRow = await db.payment.findFirst({
      where: { caseId, kind: 'letter_500' },
      orderBy: { createdAt: 'desc' },
    });

    return {
      version: cur.version,
      excerpt,
      email,
      memo: { applies: memo.required, pathway: memo.pathway, reason: memo.reason, text: memo.text, suppressed: c.coverMemoSuppressed === true, textOverridden: typeof c.coverMemoTextOverride === 'string' && c.coverMemoTextOverride.trim().length > 0 },
      stripe: { configured: stripeConfigured, link: stripeLink },
      emailTransport: { configured: isEmailTransportConfigured() },
      savedEmail: savedEmailRow ? { id: savedEmailRow.id, subject: savedEmailRow.subject, body: savedEmailRow.body, sentAt: savedEmailRow.sentAt, status: savedEmailRow.status } : null,
      savedPayment: savedPaymentRow ? { id: savedPaymentRow.id, kind: savedPaymentRow.kind, amountCents: savedPaymentRow.amountCents, status: savedPaymentRow.status } : null,
      status: c.status,
    };
  }

  // ── GET — delivery preview (RN delivery panel data source) ────────────────
  router.get(
    '/cases/:id/delivery',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const out = await composeDelivery(caseId);
      res.json({ data: out });
    }),
  );

  // ── Cover-memo staff controls (Dr. Kasky 2026-06-26, Spring) ──────────────
  // SUPPRESS = send ONLY the nexus letter (no cover memo); EDIT (PUT) = a staff-edited memo body that
  // replaces the composed text; DELETE = clear the override (back to the composed memo). All three flip
  // delivery.composeMemo and return the recomposed memo so the panel updates immediately. This unblocks
  // the case where the memo's auto-derived condition is wrong and the RN couldn't honestly confirm it.
  async function memoStatePayload(caseId: string): Promise<{ applies: boolean; pathway: CoverMemoPathway | null; reason: string; text: string | null; suppressed: boolean }> {
    const c = await db.case.findFirst({ where: { id: caseId } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
    const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
    const vFirst = (veteran as { firstName?: string } | null)?.firstName ?? null;
    const vLast = (veteran as { lastName?: string } | null)?.lastName ?? '';
    const memo = await composeMemo(c, vFirst, vLast);
    return { applies: memo.required, pathway: memo.pathway, reason: memo.reason, text: memo.text, suppressed: c.coverMemoSuppressed === true };
  }
  router.post(
    '/cases/:id/delivery/cover-memo/suppress',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const suppressed = ((req.body ?? {}) as { suppressed?: unknown }).suppressed === true;
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await db.case.update({ where: { id: caseId }, data: { coverMemoSuppressed: suppressed } });
      try { await db.activityLog.create({ data: { actorUserId: user.sub, action: 'cover_memo_suppress', caseId, veteranId: c.veteranId, detailsJson: { suppressed } } }); } catch { /* best-effort audit */ }
      res.json({ data: await memoStatePayload(caseId) });
    }),
  );
  router.put(
    '/cases/:id/delivery/cover-memo',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const text = typeof ((req.body ?? {}) as { text?: unknown }).text === 'string' ? ((req.body as { text: string }).text) : '';
      if (text.trim().length === 0) throw new HttpError(400, 'bad_request', 'Cover memo text is required (use DELETE to clear the override).', { caseId });
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await db.case.update({ where: { id: caseId }, data: { coverMemoTextOverride: text } });
      try { await db.activityLog.create({ data: { actorUserId: user.sub, action: 'cover_memo_edit', caseId, veteranId: c.veteranId, detailsJson: { length: text.length } } }); } catch { /* best-effort audit */ }
      res.json({ data: await memoStatePayload(caseId) });
    }),
  );
  router.delete(
    '/cases/:id/delivery/cover-memo',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await db.case.update({ where: { id: caseId }, data: { coverMemoTextOverride: null } });
      try { await db.activityLog.create({ data: { actorUserId: user.sub, action: 'cover_memo_edit_clear', caseId, veteranId: c.veteranId, detailsJson: {} } }); } catch { /* best-effort audit */ }
      res.json({ data: await memoStatePayload(caseId) });
    }),
  );

  // ── POST — RN confirm + send (stubbed external sends) ─────────────────────
  // Body: { emailBody?: string } — the RN-edited email body (falls back to the composed body).
  // Persists an outbound Email row (from info@) + a letter_500 Payment row, both idempotent.
  router.post(
    '/cases/:id/delivery/send',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const body = (req.body ?? {}) as { emailBody?: unknown; resend?: unknown };

      // ── BYTE-BINDING DELIVERY GATE (#9 Fix 3; consolidated onto #17 SSOT, consistency sweep fixes,
      // 2026-06-14) ── The real patient egress. Before composing or sending, verify the letter has
      // not changed since the physician signed it. We delegate to assertDeliveryEligible (the single
      // source of truth in delivery-eligibility.ts), which re-hashes the CURRENT version's bound
      // content and compares to the latest sign-off. It is IMPORT-AWARE: for an external_import
      // letter the sign-off binds to sha256(PDF) and the TXT is a placeholder, so it re-hashes the
      // PDF — the inline TXT-only re-hash that used to live here ALWAYS tripped 'signed_bytes_changed'
      // for imports, so an imported letter could never be sent.
      //
      // SCOPE (defense-in-depth hardening, 2026-06-14): block egress on ANY verdict that PROVES the
      // current letter is unsigned-against or its bytes don't match the attestation — i.e. a positive
      // 'signoff_not_affirmative' or 'signed_bytes_changed'. This prevents a future direct status-flip
      // to delivered from egressing a letter the physician signed off AGAINST, or whose bytes drifted
      // after sign-off, even though /send is only reachable post-approve today.
      //
      // DELIBERATELY NOT BLOCKED here: 'no_signoff' and 'cannot_verify_import' remain FAIL-OPEN —
      //   - 'no_signoff': the original inline gate failed open when there was no sign-off, and /send is
      //     legitimately reachable on already-delivered/paid cases whose sign-off rows are not re-
      //     presented to this route. Blocking it would regress those + the documented scope above.
      //   - 'cannot_verify_import': a LEGITIMATE imported letter that can't be PDF-re-hashed (no bound
      //     hash / no S3) — the hard-won import-deliver-as-is path. Blocking it would break that path.
      // So we allow-list the two truly-bad, route-provable reasons rather than `if (!verdict.eligible)`.
      {
        const bucketName = bucket();
        if (bucketName !== undefined) {
          const c0 = await db.case.findFirst({ where: { id: caseId } });
          if (c0 !== null) {
            const verdict = await assertDeliveryEligible(db, caseId, c0.currentVersion, { s3: s3(), bucketName });
            // Allow-list the two truly-bad, route-provable reasons. The HttpError CODE must be a valid
            // ErrorCode: 'signed_bytes_changed' has its own code; the non-affirmative case reuses the
            // 'conflict' code (mirroring letter.ts /approve) and carries its precise reason in details.
            if (!verdict.eligible && verdict.reason === 'signoff_not_affirmative') {
              throw new HttpError(409, 'conflict', 'The latest sign-off has a "No" attestation — this letter cannot be delivered. Resolve it or send the case back to the RN.', {
                reason: 'signoff_not_affirmative',
                caseId,
                signedVersion: verdict.details?.signedVersion ?? null,
                currentVersion: verdict.details?.currentVersion ?? c0.currentVersion,
              });
            }
            if (!verdict.eligible && verdict.reason === 'signed_bytes_changed') {
              throw new HttpError(409, 'signed_bytes_changed', 'The letter changed after it was signed. Re-sign before delivering.', {
                reason: 'signed_bytes_changed',
                caseId,
                signedVersion: verdict.details?.signedVersion ?? null,
                currentVersion: verdict.details?.currentVersion ?? c0.currentVersion,
              });
            }
          }
        }
      }

      const out = await composeDelivery(caseId);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      const toAddress = (veteran as { email?: string } | null)?.email ?? '';

      const emailBody = typeof body.emailBody === 'string' && body.emailBody.trim() !== ''
        ? body.emailBody
        : out.email.body;

      const emailTransportConfigured = out.emailTransport.configured;
      const stripeConfigured = out.stripe.configured;

      // Idempotent: re-use the existing delivery email/payment if present (double-click / retry).
      let emailId = out.savedEmail?.id ?? null;
      let paymentId = out.savedPayment?.id ?? null;
      let emailStatus = out.savedEmail?.status ?? null;
      let emailSentAt = out.savedEmail?.sentAt ?? null;

      // Race-proof create-or-reuse. The pre-flight findFirst above is NOT atomic — two concurrent
      // POSTs both see null and both try to insert. The partial unique indexes (migration
      // 20260612000000: emails_case_id_delivery_uq / payments_case_id_letter_500_uq) make the
      // loser's insert fail with Prisma P2002; we catch it and re-fetch the winner's row so a
      // double-click / retry / concurrent request always converges on exactly ONE row. (Same idiom
      // as drafter.ts:511, but here we RE-USE rather than reject — re-send is allowed + idempotent.)
      const isP2002 = (e: unknown): boolean =>
        typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

      if (emailId === null) {
        try {
          // Persist the composed email FIRST, marked 'queued' with NO sentAt. The transmit below
          // flips it to 'sent' on success; on any send failure the row stays 'queued' (truthful
          // state — composed, not transmitted) and is re-sendable.
          const created = await db.email.create({
            data: {
              caseId,
              direction: 'outbound',
              subject: DELIVERY_EMAIL_SUBJECT,
              body: emailBody,
              fromAddress: DELIVERY_FROM_ADDRESS,
              toAddress,
              sentAt: null,
              status: 'queued',
            },
          });
          emailId = created.id;
          emailStatus = created.status;
        } catch (e) {
          if (!isP2002(e)) throw e;
          const existing = await db.email.findFirst({
            where: { caseId, direction: 'outbound', fromAddress: DELIVERY_FROM_ADDRESS, subject: DELIVERY_EMAIL_SUBJECT },
            orderBy: { createdAt: 'desc' },
          });
          if (existing === null) throw e; // index says it exists but we can't read it — surface the error
          emailId = existing.id;
          emailStatus = existing.status;
          emailSentAt = existing.sentAt;
        }
      }
      if (paymentId === null) {
        try {
          // STUB: no Stripe charge is created. We record the invoice intent as a pending letter_500
          // Payment so the ledger reflects "invoice sent". Status flips to settled when payment is
          // reconciled (manual delivered→paid transition, admin-only, already allowed).
          const created = await db.payment.create({
            data: {
              caseId,
              kind: 'letter_500',
              amountCents: LETTER_500_CENTS,
              status: 'invoiced',
              stripeChargeId: null,
            },
          });
          paymentId = created.id;
        } catch (e) {
          if (!isP2002(e)) throw e;
          const existing = await db.payment.findFirst({ where: { caseId, kind: 'letter_500' }, orderBy: { createdAt: 'desc' } });
          if (existing === null) throw e;
          paymentId = existing.id;
        }
      }

      // ── REAL TRANSMIT (Chunk E3, work-order 5a-pre2) ── Send via mailer.sendEmail (SES,
      // forwarding-mode aware — the same transport the post-payment delivery email uses, see
      // services/payment-delivery.ts). Rules:
      //   - Idempotent: a row already 'sent' is NEVER re-transmitted (double-click / retry safe).
      //   - Success: row flips to status 'sent' + sentAt (+ the body actually transmitted).
      //   - sendEmail throw or sent:false: the row STAYS 'queued' and the REAL error/reason is
      //     returned verbatim (standing rule: no silent errors) + one structured CloudWatch warn
      //     (mirrors the server.ts http_error line shape; no PHI — ids + error only).
      let emailSent = false;
      let messageId: string | undefined;
      let redirectedFrom: string | undefined;
      let sendError: string | null = null;
      const alreadySent = emailStatus === 'sent';
      // Resend (Ryan 2026-06-12): an explicit resend RE-transmits an already-sent delivery email
      // (lost / spam-foldered) WITHOUT creating a second invoice — the email + invoiced payment rows
      // were reused (found above), never re-created. Without resend, an already-sent row is never
      // re-transmitted (double-click / retry safe).
      const wantResend = body.resend === true;
      const isResend = alreadySent && wantResend;
      if (alreadySent && !wantResend) {
        emailSent = true; // already sent, no resend requested — refuse to re-transmit
      } else if (toAddress.trim() === '') {
        // SES would reject an empty destination with an opaque validation error — say the real
        // reason instead. The row stays 'queued' and is sendable once the veteran email is fixed.
        sendError = 'The veteran has no email address on file.';
      } else {
        try {
          const r = await sendEmail({ to: toAddress, subject: DELIVERY_EMAIL_SUBJECT, textBody: emailBody, ...(process.env.DELIVERY_ADMIN_BCC ? { bcc: process.env.DELIVERY_ADMIN_BCC } : {}) });
          if (r.sent) {
            const sentAt = new Date();
            // Persist the flip + the exact body transmitted (the RN may have edited it since the
            // row was first composed on an earlier failed attempt).
            await db.email.update({ where: { id: emailId }, data: { status: 'sent', sentAt, body: emailBody } });
            emailSent = true;
            emailStatus = 'sent';
            emailSentAt = sentAt;
            messageId = r.messageId;
            redirectedFrom = r.redirectedFrom;
          } else {
            // mailer's loud no-op (SES_FROM_ADDRESS unset). The config gate keys on the same
            // precondition, so this branch means the env changed between gate-read and send.
            sendError = r.reason ?? 'Email transport is not configured.';
          }
        } catch (e) {
          sendError = e instanceof Error ? e.message : String(e);
          console.warn(JSON.stringify({
            msg: 'delivery_email_send_failed',
            method: 'POST',
            path: req.originalUrl,
            caseId,
            emailId,
            error: sendError,
          }));
        }
      }

      await db.activityLog.create({
        data: {
          actorUserId: user.sub,
          action: 'delivery_sent',
          caseId,
          veteranId: c.veteranId,
          detailsJson: {
            emailId,
            paymentId,
            emailTransportConfigured,
            stripeConfigured,
            emailStatus,
            emailSent,
            alreadySent,
            resend: wantResend,
            ...(messageId !== undefined ? { messageId } : {}),
            ...(redirectedFrom !== undefined ? { redirectedFrom } : {}),
            ...(sendError !== null ? { sendError } : {}),
          },
        },
      });

      const message = (alreadySent && !wantResend)
        ? `This delivery email was already sent${emailSentAt !== null ? ` on ${emailSentAt.toISOString()}` : ''}. It was not re-sent.`
        : emailSent
          ? isResend
            ? `Resent to ${toAddress}.`
            : redirectedFrom !== undefined
              ? `Sent (SES sandbox forwarding): delivered to the staff inbox for manual forwarding to ${redirectedFrom}.`
              : `Sent to ${toAddress}.`
          : `Email send failed: ${sendError}. The email is saved (queued); it can be sent again once the issue is fixed.`;

      res.json({
        data: {
          emailId,
          paymentId,
          // The case stays 'delivered' (invoice composed); reconciliation to 'paid' is the
          // admin-only delivered→paid transition that already exists. We do NOT invent a new status.
          status: c.status,
          emailTransportConfigured,
          stripeConfigured,
          emailSent,
          // Lifecycle of the delivery email: 'queued' = composed, not transmitted; 'sent' = a real
          // SES transmit happened (sentAt set).
          emailStatus: emailStatus ?? 'queued',
          ...(messageId !== undefined ? { messageId } : {}),
          ...(redirectedFrom !== undefined ? { redirectedFrom } : {}),
          ...(sendError !== null ? { error: sendError } : {}),
          message,
        },
      });
    }),
  );

  // ── POST — staff reset of a locked/failed delivery unlock (adversarial-audit #3) ──────────────
  // Without this, a veteran who trips the 5-attempt lockout (fat-fingered DOB, corrected phone) is
  // permanently bricked — fixing their Veteran record does NOT clear lockedAt. Staff verifies the
  // veteran out-of-band, fixes the record if needed, then resets here; the SAME emailed link starts
  // working again (no re-issue, no new email).
  router.post(
    '/cases/:id/delivery/unlock-reset',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const r = await db.deliveryToken.updateMany({
        where: { caseId },
        data: { failedAttempts: 0, lockedAt: null },
      });
      await db.activityLog.create({
        data: { actorUserId: user.sub, action: 'delivery_unlock_reset', caseId, veteranId: c.veteranId, detailsJson: { tokensReset: r.count } },
      });
      res.json({ data: { tokensReset: r.count } });
    }),
  );

  // ── GET — cover memo as a PDF (E4: "Verify the cover memo" opens a real document) ─────────────
  // Same role guard as the other delivery reads. Self-contained render (services/memo-render.ts,
  // pdf-lib) — deliberately NOT the FRN render Lambda, which only knows the nexus-letter shape
  // (signature compositing + letter chrome) and would corrupt a plain memo (decision E-2 / E-4b).
  //
  // We do NOT stream the rendered bytes back through the API Lambda: API Gateway (HttpApi + the
  // serverless-http adapter, which runs binary:false) returns a non-base64 text body, so a raw
  // application/pdf response is corrupted on the wire — the browser blob then fails with "Failed to
  // load PDF document" (confirmed root cause). Instead we mirror the WORKING letter-verify path:
  // render → PUT the bytes to the PHI bucket (KMS-encrypted, like every other artifact) → return a
  // short-lived presigned GET URL. The browser opens the URL straight from S3 = clean binary.
  // Re-rendering to the same versioned key on each click is safe: renderMemoPdf is deterministic
  // (byte-identical output for the same memo text), so the overwrite is a no-op in content.
  router.get(
    '/cases/:id/delivery/memo.pdf',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      if (!DELIVERY_STATUSES.has(c.status)) {
        throw new HttpError(409, 'conflict', `Delivery is available only after the letter is finalized (status delivered/paid). Current status: '${c.status}'.`, { reason: 'not_deliverable', caseId, status: c.status });
      }
      const bucketName = bucket();
      if (bucketName === undefined) {
        throw new HttpError(500, 'internal_error', 'PHI bucket is not configured.', { reason: 'bucket_unconfigured', caseId });
      }
      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      const vFirst = (veteran as { firstName?: string } | null)?.firstName ?? null;
      const vLast = (veteran as { lastName?: string } | null)?.lastName ?? '';
      const memo = await composeMemo(c, vFirst, vLast);
      if (!memo.required || memo.text === null) {
        throw new HttpError(404, 'not_found', 'No cover memo applies to this case (original claim, no prior denial).', { reason: 'no_memo', caseId });
      }

      // SIGNATURE (E4 bug fix 2026-06-14): the memo embeds the ASSIGNED physician's signature PNG —
      // never a literal "[SIGNATURE]". Resolve the assigned physician, require a signature key, fetch
      // the PNG bytes from the PHI bucket, and hand them to renderMemoPdf (which embedPng's them where
      // the placeholder sits). This mirrors the approve path's signature gate (letter.ts:614). If no
      // signature is on file we 409 with a precise reason rather than shipping an unsigned memo.
      if (c.assignedPhysicianId === null) {
        throw new HttpError(409, 'conflict', 'Cannot render the cover memo: no physician is assigned to this case. Assign a signing physician, then retry.', { reason: 'no_assigned_physician', caseId });
      }
      const signer = await db.physician.findFirst({ where: { id: c.assignedPhysicianId } });
      if (signer === null) {
        throw new HttpError(409, 'conflict', 'Cannot render the cover memo: the assigned physician record was not found. Reassign the case to a current physician, then retry.', { reason: 'assigned_physician_not_found', caseId, physicianId: c.assignedPhysicianId });
      }
      const signatureKey = signer.signatureImageS3Key;
      if (signatureKey === null || signatureKey.trim() === '') {
        throw new HttpError(409, 'conflict', `Cannot render the cover memo: ${signer.fullName} has no signature image on file. An administrator must upload the physician's signature on the Physicians admin page, then retry.`, { reason: 'signer_signature_missing', caseId, physicianId: signer.id });
      }
      const sigObj = await s3().send(new GetObjectCommand({ Bucket: bucketName, Key: signatureKey }));
      if (sigObj.Body === undefined) {
        throw new HttpError(502, 'internal_error', 'The physician signature image could not be read.', { reason: 'signature_read_failed', caseId, key: signatureKey });
      }
      const signaturePng = await sigObj.Body.transformToByteArray();

      const pdf = await renderMemoPdf(memo.text, { signaturePng });
      // Versioned key so the URL is scoped to the current letter version (matches the
      // letter-revisions/cover-memo naming convention) and never collides across cases.
      const current = await resolveCurrent(caseId, c.currentVersion);
      const memoKey = `cases/${caseId}/delivery/cover-memo-v${current?.version ?? c.currentVersion}.pdf`;
      const client = s3();
      await client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: memoKey,
        Body: Buffer.from(pdf),
        ContentType: 'application/pdf',
        ServerSideEncryption: 'aws:kms',
      }));
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName, Key: memoKey }), { expiresIn: MEMO_PRESIGN_TTL_SECONDS });
      res.json({ data: { url } });
    }),
  );

  return router;
}
