// SC-STATUS PROVENANCE / SOURCE-AUTHORITY (Woodley fix, 2026-06-26 — Ryan "garbage in, garbage out").
//
// The chart-extraction LLM read a VETERAN-AUTHORED goal/scaffolding doc ("30% — Recurrent esophageal
// stricture, DC 7203" = the rating he is TARGETING) and wrote it into the SC-conditions list as a real
// grant (status='service_connected', ratingPct 30). Ask-Aegis + the drafter then argued from that false
// premise. Only the VA grants service connection; a percentage/DC code/even the words "service-connected"
// in a NON-authoritative document (the veteran's own doc, an intake field, a clinical-note mention) is the
// veteran's CLAIM or GOAL — never a grant.
//
// This module is the pure SSOT for: (a) classifying a SOURCE document's authority over SC status, and
// (b) deciding a row's EFFECTIVE SC status given that authority. Every consumer that trusts
// `status==='service_connected'` for anchoring/grounding routes through `effectiveScStatus`.
//
// DARK BY DEFAULT: the master flag SC_PROVENANCE_ENFORCED gates the DEMOTION (not the classification). With
// the flag off, `effectiveScStatus` returns the raw status (byte-identical legacy behavior) while tiers are
// still stamped + logged; with it on, a non-authoritative or legacy-unverified extracted grant demotes to
// 'claimed_unverified' (treated as pending for anchoring, surfaced for RN confirmation). Manual (RN-typed)
// rows are ALWAYS trusted. See ARCHITECTURE.md + the 3-agent scope.

import type { KeyDocType } from './db-types.js';

// Authority of a SOURCE document over SERVICE-CONNECTION status.
export type ScAuthorityTier =
  | 'va_decision' // rating_decision | supplemental_decision | rated_disabilities_view | code sheet — AUTHORITATIVE for grants
  | 'va_summary' // benefit_summary | denial_letter — AUTHORITATIVE (a denial letter is authoritative for 'denied')
  | 'clinical' // C&P exam | DBQ | progress notes | Blue Button — diagnosis-authoritative, NOT SC-status-authoritative
  | 'veteran_or_lay' // statement in support | lay/buddy statement | intake | the veteran's own goal/scaffolding doc — NON-authoritative
  | 'unknown'; // unclassified / no docType — treated as NON-authoritative (fail-safe)

// The ONLY tiers that may establish service connection + a rating %.
const SC_AUTHORITATIVE_TIERS: ReadonlySet<ScAuthorityTier> = new Set(['va_decision', 'va_summary']);

export function scStatusAuthoritativeFor(tier: ScAuthorityTier): boolean {
  return SC_AUTHORITATIVE_TIERS.has(tier);
}

// Master flag: enforcement is DARK by default (compute + stamp + log, but do not demote) until validated.
export function isScProvenanceEnforced(): boolean {
  return String(process.env.SC_PROVENANCE_ENFORCED || '').toLowerCase() === 'on';
}

// ── Layer 1: docType → tier (clean map when the document type IS known) ─────────────────────────────
export function authorityTierForDocType(docType: KeyDocType | null | undefined): ScAuthorityTier {
  switch (docType) {
    case 'rating_decision':
    case 'supplemental_decision':
    case 'rated_disabilities_view':
      return 'va_decision';
    case 'benefit_summary':
    case 'denial_letter':
      return 'va_summary';
    case 'c_and_p_exam':
    case 'dbq':
    case 'progress_notes':
    case 'blue_button':
    case 'audiogram':
    case 'sleep_study':
    case 'pulmonary_function_test':
    case 'service_treatment_record_summary':
    case 'separation_exam':
    case 'entrance_exam':
    case 'imaging':
    case 'medical_opinion':
    case 'nexus_letter_prior':
      return 'clinical';
    case 'statement_in_support':
    case 'lay_statement':
    case 'buddy_statement':
    case 'intake_summary':
      return 'veteran_or_lay';
    // dd_214 / personnel_record / tera_memo / individual_exposure_summary / cover_index / unspecified:
    // not authoritative for SC STATUS specifically → unknown (fail-safe non-authoritative).
    default:
      return 'unknown';
  }
}

// ── Layer 2: deterministic fingerprint over filename + a text sample, used when docType is missing /
// 'unspecified' (docTag classification does not reliably populate — draft-readiness.ts). FAIL-SAFE: any
// ambiguity returns 'unknown' (non-authoritative). A wrongly-non-authoritative real grant surfaces for RN
// confirmation (safe); a wrongly-authoritative goal-doc reaches a veteran's letter (the harm we prevent). ─
const RE_VA_DECISION = /\b(rating\s*decision|code\s*sheet|codesheet|rated\s+disabilities|notification\s+of\s+(?:rating\s+)?decision)\b/i;
const RE_VA_SUMMARY = /\b(benefit\s*summary|benefits?\s+summary|decision\s+(?:letter|notice)|denial\s+letter)\b/i;
const RE_VETERAN_LAY = /\b(statement\s+in\s+support|personal\s+statement|lay\s+statement|buddy\s+statement|in\s+support\s+of\s+claim|va\s*form\s*21-?4138)\b/i;
const RE_GOAL_DOC = /\b(goals?|seeking|targeting|i\s+am\s+(?:claiming|seeking|requesting)|increased\s+rating\s+sought|misc)\b/i;
const RE_CLINICAL = /\b(c\s*&\s*p|c\s+and\s+p\s+exam|compensation\s+and\s+pension|progress\s+note|blue\s*button|treatment\s+record|cprs|dbq|disability\s+benefits?\s+questionnaire)\b/i;
const RE_VA_HEADER = /department\s+of\s+veterans\s+affairs/i;
const RE_DECISION_SECTION = /\b(decision|the\s+evidence\s+(?:shows|supports)|service\s+connection\s+(?:for|is)\b.*\b(?:granted|denied|established))\b/i;

export function authorityTierForDocument(input: {
  docType?: KeyDocType | null;
  filename?: string | null;
  textSample?: string | null; // first ~3-4k chars is plenty for the header/title
}): ScAuthorityTier {
  // Trust an explicit, non-default docType classification first.
  const byType = authorityTierForDocType(input.docType);
  if (byType !== 'unknown') return byType;

  const name = String(input.filename || '');
  const text = String(input.textSample || '').slice(0, 4000);
  const hay = `${name}\n${text}`;

  // A veteran-authored / lay / goal doc is NON-authoritative even if it parrots VA phrasing.
  if (RE_VETERAN_LAY.test(hay) || /\.docx?$/i.test(name) || (RE_GOAL_DOC.test(hay) && !RE_VA_HEADER.test(text))) {
    return 'veteran_or_lay';
  }
  // A VA decision: the VA letterhead + a decision/grant/denial recital, or a decision-doc title.
  if (RE_VA_DECISION.test(hay) || (RE_VA_HEADER.test(text) && RE_DECISION_SECTION.test(text))) {
    return 'va_decision';
  }
  if (RE_VA_SUMMARY.test(hay)) return 'va_summary';
  if (RE_CLINICAL.test(hay)) return 'clinical';
  return 'unknown'; // fail-safe: don't trust an unidentified source to grant SC
}

// ── The trust gate every consumer calls. Returns the EFFECTIVE status for anchoring / grounding. ────────
// 'claimed_unverified' is a DERIVED presentation value (never stored): "the source asserts a grant we
// cannot verify against an authoritative VA document — treat as pending for anchoring, surface for
// confirmation." With `enforce=false` (flag off) this is a pure pass-through (byte-identical).
export type EffectiveScStatus = 'service_connected' | 'pending' | 'denied' | 'claimed_unverified';
export function effectiveScStatus(
  row: { status: string; source?: string | null; scStatusAuthoritative?: boolean | null },
  opts: { enforce: boolean },
): EffectiveScStatus {
  const status = String(row.status || '').toLowerCase(); // case-insensitive (mirrors the legacy filter)
  if (status !== 'service_connected') return (status as EffectiveScStatus) || 'pending'; // pending/denied untouched
  if (!opts.enforce) return 'service_connected'; // DARK: no demotion
  // Manual rows = an RN typed the grant deliberately → always trusted (the extractor never touches manual).
  if (row.source == null || row.source === 'manual') return 'service_connected';
  if (row.scStatusAuthoritative === true) return 'service_connected'; // authoritative VA source
  // Extracted + (explicitly non-authoritative OR legacy-null pre-fix) → demote.
  return 'claimed_unverified';
}
