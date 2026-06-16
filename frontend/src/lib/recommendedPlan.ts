// Recommended-plan SELECTOR (2026-06-16) — ONE BRAIN, zero new decisions.
//
// This is a PURE READOUT of what the existing engine already concluded. It introduces NO new
// thresholds and makes NO independent decision: it reads the strategy-preview tier (the same value
// the headline chip shows), the engine's own anchor-switch signal (recommendedPathway.differsFromCurrent),
// and the viability/bridge/missing-fact fields the engine already emits, and maps them 1:1 to a
// recommendation label. When it cannot map cleanly it returns 'needs_review' — it never invents.
//
// Architect QA 2026-06-16 (CRITICAL): the recommendation must key on the strategy TIER first, NOT the
// info-light viability band alone — the band cannot see a missing diagnosis or a barred theory, so a
// band-only read would emit DRAFT over a strategy 'Stop'. Precedence: Stop → differsFromCurrent → strength.

import type { StrategyPreview } from '../api/strategy-preview';
import type { CaseViability, BridgePathway } from '../api/case-viability';

export type RecommendationKind =
  | 'draft'
  | 'draft_with_changes'
  | 'contact_records'
  | 'contact_alternative'
  | 'not_draftable'
  | 'needs_review';

export interface RecommendedPlan {
  readonly kind: RecommendationKind;
  /** Short section title, e.g. "Draft the letter" / "Contact the veteran". */
  readonly title: string;
  /** One-line plain-language why, sourced from engine fields (never a fabricated rationale). */
  readonly detail: string;
  /** draft_with_changes only: the stronger anchor the engine picked (e.g. "PTSD"). */
  readonly switchToAnchor?: string;
  /** contact_alternative only: the engine's bridge pathway (rendered as-is). */
  readonly bridge?: BridgePathway;
  /** contact_records only: the specific missing fact/record to request. */
  readonly missingFact?: string;
  /** true for the contact_* kinds — the surface offers the copy-paste customer email. */
  readonly emailEligible: boolean;
}

export interface RecommendedPlanInputs {
  readonly strategy: StrategyPreview | null;
  readonly viability: CaseViability | null;
  /** From the extraction-completeness signal: part of the record is still unread. Softens a
   *  "contact for records" into "needs review" — don't ask for a record that may be in the unparsed chart. */
  readonly hasUnreadPages?: boolean;
}

function contactAlternative(bridge: BridgePathway): RecommendedPlan {
  return {
    kind: 'contact_alternative',
    title: 'Contact the veteran — alternative route',
    detail: `No direct service-connected anchor, but a presumptive route may work: establish ${bridge.intermediate_dx} first, then claim ${bridge.claimed} secondary to it.`,
    bridge,
    emailEligible: true,
  };
}
function contactRecords(missingFact: string): RecommendedPlan {
  return {
    kind: 'contact_records',
    title: 'Contact the veteran — records needed',
    detail: missingFact,
    missingFact,
    emailEligible: true,
  };
}
function needsReview(detail: string): RecommendedPlan {
  return { kind: 'needs_review', title: 'Needs review', detail, emailEligible: false };
}
function notDraftable(detail: string): RecommendedPlan {
  return { kind: 'not_draftable', title: 'Not supportable as filed', detail, emailEligible: false };
}

/**
 * Map the EXISTING engine output to a single recommendation. Pure; returns null only when no engine
 * read exists yet (the section then hides). NEVER re-thresholds — it reads tier, differsFromCurrent,
 * the band, the bridge, and missing_fact, all already computed upstream.
 */
export function recommendedPlan({ strategy, viability, hasUnreadPages = false }: RecommendedPlanInputs): RecommendedPlan | null {
  if (strategy === null && viability === null) return null; // nothing computed yet → hide
  const bridge = viability?.bridge_pathways?.[0];
  const missingFact = (viability?.missing_fact ?? '').trim() || null;

  const contactFallback = (): RecommendedPlan => {
    if (bridge) return contactAlternative(bridge);
    if (hasUnreadPages) return needsReview('Part of the record is still unread — finish extraction before deciding the plan.');
    if (missingFact) return contactRecords(missingFact);
    return notDraftable('No recognized service-connected anchor and no presumptive route on the current record.');
  };

  // 1) STOP wins first (architect CRITICAL). The strategy engine saw a hard gate (no diagnosis /
  //    barred theory / no anchor) the info-light viability band cannot see. Never DRAFT over a Stop.
  if (strategy?.tier === 'Stop') return contactFallback();

  // 2) The engine's OWN anchor-switch decision — a stronger eligible anchor than the current framing
  //    (e.g. the engine picked PTSD while the case is framed on tinnitus). We surface the switch; the
  //    framing change auto-notifies via the existing framingGate. We do NOT decide the anchor here.
  if (strategy?.recommendedPathway?.differsFromCurrent && strategy.recommendedPathway.anchor) {
    const anchor = strategy.recommendedPathway.anchor;
    return {
      kind: 'draft_with_changes',
      title: 'Draft — with a stronger anchor',
      detail: `The record better supports anchoring on ${anchor} than the current framing. Draft anchored on ${anchor}.`,
      switchToAnchor: anchor,
      emailEligible: false,
    };
  }

  // 3) Strength, read from the engine's tier (the value the headline chip already shows). Strong /
  //    Plausible are draftable; Thin (and any non-Stop weak read) routes to contact.
  if (strategy?.tier === 'Strong' || strategy?.tier === 'Plausible') {
    return { kind: 'draft', title: 'Draft the letter', detail: 'A recognized, supportable theory is on the record.', emailEligible: false };
  }
  if (strategy?.tier === 'Thin') return contactFallback();

  // No strategy tier (strategy read absent) → fall back to the viability band as the strength signal.
  const band = viability?.viability;
  if (band === 'strong' || band === 'moderate' || band === 'conditional') {
    return { kind: 'draft', title: 'Draft the letter', detail: 'A recognized, supportable anchor is on the record.', emailEligible: false };
  }
  return contactFallback();
}
