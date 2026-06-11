/**
 * Config-gating + the cover-memo predicate for the delivery workflow. Pure (predicate) +
 * env-reading (config). No external SDK calls — Stripe and the email transport are STUBBED in this
 * build; this module reports whether each is configured and, for Stripe, composes the link from the
 * configured base.
 *
 * Why stubs: compact-EMR has NO Stripe and NO email-send infra in the cloud (verified — see
 * project_compact_emr_delivery_workflow). The operator drops in secrets later and these gates flip
 * to "configured" with no code change.
 */

import type { CoverMemoPathway } from './delivery-templates.js';

// ── Stripe link (config-gated stub) ─────────────────────────────────────────────────────────────
// Mirrors the local FRN stripe.js link model: a Payment Link base + ?client_reference_id=CASE_<id>
// so a future webhook/poller can reconcile by case. We do NOT create a Stripe Checkout Session here
// (no SDK, no live charge). When STRIPE_LINK_500 is unset, link is null and the RN pastes one in.
export function isStripeConfigured(): boolean {
  return typeof process.env.STRIPE_LINK_500 === 'string' && process.env.STRIPE_LINK_500.trim() !== '';
}

/** Which fee a Stripe link is for. 500 → STRIPE_LINK_500, 350 → STRIPE_LINK_350. Defaults to 500. */
export type StripeFee = 500 | 350;

export function buildStripeLink(caseId: string, fee: StripeFee = 500): string | null {
  const base = fee === 350 ? process.env.STRIPE_LINK_350 : process.env.STRIPE_LINK_500;
  if (typeof base !== 'string' || base.trim() === '') return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base.trim()}${sep}client_reference_id=CASE_${encodeURIComponent(caseId)}`;
}

// ── Email transport (config gate) ───────────────────────────────────────────────────────────────
// Chunk E3 gate-truthfulness fix: this gate previously keyed on DELIVERY_EMAIL_TRANSPORT /
// SES_REGION / RESEND_API_KEY / GMAIL_REFRESH_TOKEN, but the REAL transport (mailer.sendEmail, SES)
// no-ops unless SES_FROM_ADDRESS is set — so the UI banner could say "configured" while sendEmail
// refused, or vice-versa. The gate now keys on EXACTLY the precondition sendEmail checks
// (mailer.ts: `if (!from) return { sent:false, ... }`), so the banner and the real send can never
// disagree. delivery-config.test.ts binds this to the mailer's behavior.
export function isEmailTransportConfigured(): boolean {
  return typeof process.env.SES_FROM_ADDRESS === 'string' && process.env.SES_FROM_ADDRESS.trim() !== '';
}

// ── Cover-memo predicate (mirror of coverMemo.coverMemoRequirement) ──────────────────────────────
// Returns whether an appeals cover memo applies + the administrative pathway. Mirrors the local FRN
// single-source predicate so cloud + local can never diverge (feedback_supplemental_appeals_need_
// cover_letter HARD RULE). Inputs come from the Case row.
export interface CoverMemoPredicateInput {
  /** Case.claimType — initial | supplemental | hlr | appeal_bva. */
  readonly claimType: string;
  /** Case.previouslyDenied (additive field). */
  readonly previouslyDenied?: boolean | null;
  /** Case.priorDenialReason (additive field). */
  readonly priorDenialReason?: string | null;
}

export interface CoverMemoRequirement {
  readonly required: boolean;
  readonly pathway: CoverMemoPathway | null;
  readonly reason: 'administrative_pathway' | 'prior_denial_signal' | 'original_claim_no_denial';
}

export function coverMemoRequirement(input: CoverMemoPredicateInput): CoverMemoRequirement {
  const ct = String(input.claimType || '').toLowerCase().trim();
  // ClaimType enum maps: supplemental→supplemental, hlr→hlr_request, appeal_bva→board_appeal.
  const pathway: CoverMemoPathway | null =
    /^supplement/.test(ct) ? 'supplemental' :
    /^tdiu|individual\s+unemployab/.test(ct) ? 'tdiu' :
    /^hlr|higher.level\s+review/.test(ct) ? 'hlr_request' :
    /board|bva|appeal/.test(ct) ? 'board_appeal' :
    /continu|reduction/.test(ct) ? 'continuance' :
    null;
  if (pathway) return { required: true, pathway, reason: 'administrative_pathway' };

  const hasPriorDenial =
    input.previouslyDenied === true ||
    (typeof input.priorDenialReason === 'string' && input.priorDenialReason.trim().length > 0);
  if (hasPriorDenial) return { required: true, pathway: 'supplemental', reason: 'prior_denial_signal' };

  return { required: false, pathway: null, reason: 'original_claim_no_denial' };
}
