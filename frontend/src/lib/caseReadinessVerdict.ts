// Case Readiness Verdict — THE one brain for the Overview's single go/no-go (2026-06-18, Cluster 3).
//
// Ryan: the Overview showed 4+ chips from independent engines that contradict each other, so an RN
// couldn't tell go/no-go. This module reconciles them into ONE top-line verdict + next action +
// explicit disagreements. It is a PURE function over signals the Overview ALREADY fetches — it makes
// NO new model call and introduces NO new clinical threshold. recommendedPlan() (the existing plan
// selector) is re-exported from here and delegates to this, so there is exactly ONE implementation
// (no frontend/backend divergence; RecommendedPlanCard is untouched).
//
// Design rules baked in (dual-expert QA 2026-06-18):
//  • DETERMINISTIC CORE first: the theory plan keys on the strategy tier (Stop → anchor-switch →
//    strength), exactly as before — the deterministic engine sees a missing dx / barred theory the
//    info-light viability band cannot.
//  • OVER-CALL GUARD: an unreviewed mechanism (the resolver's recommended_action → escalate/physician)
//    never reads as a clean "draft" — it becomes "draft, confirm the mechanism with the physician".
//  • EXTRACTION = add-caution-only, CONSERVATIVE (Ryan 2026-06-18): an incomplete parse LOWERS
//    confidence + adds a "read the chart first" note; it does NOT by itself flip a supportable theory
//    to not-supportable (a thin parse that still caught the rating decision is fine). It DOES soften a
//    "request records" into "read the chart first" — never chase a record that may be in the unread chart.
//  • AI SANITY = add-caution-only, ASYMMETRIC: a 'concern' raises an explicit disagreement + lowers
//    confidence, but NEVER silently moves the deterministic verdict; a 'clear' has ZERO authority to
//    relax any deterministic caution; 'unavailable' (null) is NOT 'clear'. The LLM may ADD caution,
//    never REMOVE it.
//  • Every signal has an explicit UNAVAILABLE (null) state distinct from its negative; a missing input
//    degrades confidence toward 'low' / the verdict toward needs_review, never toward a confident draft.

import type { StrategyPreview } from '../api/strategy-preview';
import type { CaseViability, BridgePathway, RoutePickerViability } from '../api/case-viability';
import type { ExtractionCoverage } from '../api/extraction-coverage';
import type { ImpressionLevel } from '../api/sanity-impression';

// ── The detailed plan (unchanged shape — RecommendedPlanCard consumes this) ──────────────────────
export type RecommendationKind =
  | 'draft'
  | 'draft_with_changes'
  | 'contact_records'
  | 'contact_alternative'
  | 'not_draftable'
  | 'needs_review';

export interface RecommendedPlan {
  readonly kind: RecommendationKind;
  readonly title: string;
  readonly detail: string;
  readonly switchToAnchor?: string;
  readonly bridge?: BridgePathway;
  readonly missingFact?: string;
  readonly emailEligible: boolean;
}

export interface RecommendedPlanInputs {
  readonly strategy: StrategyPreview | null;
  readonly viability: CaseViability | null;
  /** Part of the record is still unread — softens "request records" into "read the chart first". */
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
  return { kind: 'contact_records', title: 'Contact the veteran — records needed', detail: missingFact, missingFact, emailEligible: true };
}
function needsReview(detail: string): RecommendedPlan {
  return { kind: 'needs_review', title: 'Needs review', detail, emailEligible: false };
}
function notDraftable(detail: string): RecommendedPlan {
  return { kind: 'not_draftable', title: 'Not supportable as filed', detail, emailEligible: false };
}

/**
 * The DETERMINISTIC theory plan (unchanged precedence: Stop → anchor-switch → strength). Pure;
 * null only when no engine read exists yet. This is the deterministic CORE the verdict builds on.
 */
export function recommendedPlan({ strategy, viability, hasUnreadPages = false }: RecommendedPlanInputs): RecommendedPlan | null {
  if (strategy === null && viability === null) return null;
  const bridge = viability?.bridge_pathways?.[0];
  const missingFact = (viability?.missing_fact ?? '').trim() || null;

  const contactFallback = (): RecommendedPlan => {
    if (bridge) return contactAlternative(bridge);
    if (hasUnreadPages) return needsReview('Part of the record is still unread — finish extraction before deciding the plan.');
    if (missingFact) return contactRecords(missingFact);
    return notDraftable('No recognized service-connected anchor and no presumptive route on the current record.');
  };

  if (strategy?.tier === 'Stop') return contactFallback();

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

  if (strategy?.tier === 'Strong' || strategy?.tier === 'Plausible') {
    return { kind: 'draft', title: 'Draft the letter', detail: 'A recognized, supportable theory is on the record.', emailEligible: false };
  }
  if (strategy?.tier === 'Thin') return contactFallback();

  const band = viability?.viability;
  if (band === 'strong' || band === 'moderate' || band === 'conditional') {
    return { kind: 'draft', title: 'Draft the letter', detail: 'A recognized, supportable anchor is on the record.', emailEligible: false };
  }
  return contactFallback();
}

// ── The reconciled top-line verdict ──────────────────────────────────────────────────────────────
export type ReadinessVerdict =
  | 'draft' // clean go
  | 'draft_confirm_mechanism' // go, but the anchor mechanism is not physician-reviewed
  | 'draft_reconcile' // draftable, but the strategy + viability engines disagree on the anchor — reconcile first
  | 'draft_with_changes' // go, with a stronger anchor than the current framing
  | 'read_chart_first' // the chart isn't fully read — finish before deciding
  | 'contact_records' // a specific record is needed from the veteran
  | 'contact_alternative' // a presumptive/bridge route to pursue
  | 'not_supportable' // no anchor and no route on the current record
  | 'needs_review'; // signals conflict / too little to decide → a human looks

export type Confidence = 'high' | 'medium' | 'low';
export type DisagreementSource = 'ai_sanity' | 'extraction' | 'viability_vs_strategy' | 'band_vs_deterministic';
export interface Disagreement {
  readonly source: DisagreementSource;
  readonly note: string;
}

export interface ReadinessResult {
  readonly verdict: ReadinessVerdict;
  readonly title: string;
  /** One-line plain-language summary of the verdict (no fabricated rationale). */
  readonly detail: string;
  /** The single concrete next action for the RN. */
  readonly nextAction: string;
  readonly confidence: Confidence;
  /** Explicit, structured engine-vs-engine / engine-vs-AI disagreements (first-class, not an error). */
  readonly disagreements: readonly Disagreement[];
  /** The detailed plan (RecommendedPlanCard renders this) — same brain, fuller view. */
  readonly plan: RecommendedPlan;
}

export interface ReadinessSignals {
  readonly strategy: StrategyPreview | null; // null = unavailable
  readonly viability: CaseViability | null; // null = unavailable
  /**
   * The DECISION input for "is the chart fully read" — sourced ONCE by the parent (the same
   * useChartReadiness value RecommendedPlanCard receives) so the headline and the detail card can't
   * disagree. true = unread pages exist; false = fully read; null = unknown (not asserted unread).
   */
  readonly hasUnreadPages: boolean | null;
  /** DISPLAY-ONLY: the coverage report, for the % in the disagreement note. Never the decision input. */
  readonly extraction: ExtractionCoverage | null; // null = report unavailable
  readonly sanity: ImpressionLevel | null; // null = unavailable (NOT 'clear')
  /**
   * ONE-BRAIN (Ryan 2026-06-22): the AI route-picker plan's viability band — the SAME brain the drafter
   * pleads and the SOAP Assessment/Plan render. When present (a 'ready' plan), the HEADLINE verdict is a
   * PROJECTION of this band (routePickerBandToVerdict), so the chip can never contradict the note. The
   * deterministic core is still computed (it populates the detail plan + missingFact + the over-call /
   * extraction / sanity overlays), but it no longer OWNS the headline — when it would say Stop while the
   * band says supportable, that becomes a VISIBLE 'band_vs_deterministic' disagreement, NOT a silent flip.
   * null = no ready plan (flag off / cold / error) → the deterministic core drives the headline (fallback).
   */
  readonly routePickerViability?: RoutePickerViability | null;
}

/**
 * Project the AI route-picker plan's viability band → the top-line headline verdict (ONE-BRAIN, Ryan
 * 2026-06-22). This is the chip's source of truth when a ready plan exists. It MUST agree, band-for-band,
 * with soap-overview.ts `planViabilityToAction` (same band → same go/no-go in two enums) — a cross-module
 * agreement test pins that. The mapping:
 *   supportable             → draft           (go; planViabilityToAction → 'draft')
 *   marginal                → needs_review    (no-go; planViabilityToAction → 'physician_review')
 *   needs_physician_review  → needs_review    (no-go; planViabilityToAction → 'physician_review')
 *   not_supportable         → not_supportable (no-go; planViabilityToAction → 'reject')
 * The conservative unread-chart overlay still applies on top (a negative band on an unread chart →
 * read_chart_first), so the band never asserts "not supportable" on a chart we haven't finished reading.
 */
export function routePickerBandToVerdict(band: RoutePickerViability): ReadinessVerdict {
  switch (band) {
    case 'supportable': return 'draft';
    case 'marginal': return 'needs_review';
    case 'needs_physician_review': return 'needs_review';
    case 'not_supportable': return 'not_supportable';
    default: return 'needs_review';
  }
}

/** Is a verdict a "go" (drafting may proceed)? Used to detect a band-wins-over-deterministic-Stop conflict. */
function isGoVerdict(v: ReadinessVerdict): boolean {
  return v === 'draft' || v === 'draft_confirm_mechanism' || v === 'draft_reconcile' || v === 'draft_with_changes';
}

const VERDICT_TITLE: Record<ReadinessVerdict, string> = {
  draft: 'Ready to draft',
  draft_confirm_mechanism: 'Draftable — confirm the mechanism',
  draft_reconcile: 'Draftable — reconcile the anchor',
  draft_with_changes: 'Draftable — with a stronger anchor',
  read_chart_first: 'Read the chart first',
  contact_records: 'Contact the veteran — records needed',
  contact_alternative: 'Contact the veteran — alternative route',
  not_supportable: 'Not supportable as filed',
  needs_review: 'Needs review',
};

function lower(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

/** The deterministic over-call signal: the resolver routed an UNREVIEWED green-band anchor to a
 *  physician (consumed, never re-derived — same predicate the viability card uses). */
function isUnreviewedOvercall(v: CaseViability | null): boolean {
  if (!v) return false;
  const green = v.viability === 'strong' || v.viability === 'moderate' || v.viability === 'conditional';
  const ra = v.recommended_action;
  return green && v.best_anchor?.physician_reviewed === false && ra?.action === 'escalate' && ra?.route === 'physician';
}

/**
 * Reconcile the four signals into ONE verdict. Pure. Returns null only when nothing is computed yet
 * (the same hide condition as recommendedPlan). Builds on the deterministic plan, then layers the
 * over-call guard, the conservative extraction overlay, and the asymmetric add-caution-only sanity
 * overlay — each surfaced as an explicit disagreement, never a silent band change.
 */
export function computeReadinessVerdict(signals: ReadinessSignals): ReadinessResult | null {
  const { strategy, viability, extraction, sanity } = signals;
  const hasUnreadPages = signals.hasUnreadPages === true; // single-sourced by the parent; null ≠ unread

  const plan = recommendedPlan({ strategy, viability, hasUnreadPages });
  if (plan === null) return null; // nothing computed yet → hide the surface

  const disagreements: Disagreement[] = [];
  // Base confidence from the deterministic strength signal.
  let confidence: Confidence =
    strategy?.tier === 'Strong' ? 'high'
    : strategy?.tier === 'Plausible' ? 'medium'
    : strategy?.tier === 'Thin' || strategy?.tier === 'Stop' ? 'low'
    : viability?.viability === 'strong' || viability?.viability === 'moderate' ? 'medium'
    : 'low';

  // A go-plan with only a viability fallback (no strategy read) is inherently less certain.
  if (strategy === null && (plan.kind === 'draft')) confidence = lower(confidence);

  // ── viability-vs-strategy HARD disagreement (explicit, not silent): strategy says supportable but
  //    the viability band is weak/abstaining. The verdict stays DRAFTABLE (strategy tier is authoritative
  //    for the theory — the band is info-light) but the HEADLINE goes amber (draft_reconcile, below) so
  //    the RN doesn't read a confident green over an unresolved engine conflict. ──
  const goPlan = plan.kind === 'draft' || plan.kind === 'draft_with_changes';
  const bandWeak = viability?.viability === 'weak' || viability?.viability === 'abstain';
  const hardDisagreement = goPlan && bandWeak;
  if (hardDisagreement) {
    disagreements.push({
      source: 'viability_vs_strategy',
      note: 'The strategy engine reads this as supportable but the anchor-viability engine is weak/abstaining — reconcile the anchor (or get more records) before drafting.',
    });
    confidence = lower(confidence);
  }

  // ── OVER-CALL guard: applies to BOTH go-plans (draft AND draft_with_changes) — an unreviewed winning
  //    mechanism must never ship as a clean green "go". For a plain draft the verdict itself downgrades
  //    to draft_confirm_mechanism; an anchor-switch stays draft_with_changes (already a non-clean go) but
  //    gets the same confirm-the-mechanism disagreement + confidence hit. ──
  const overcall = (plan.kind === 'draft' || plan.kind === 'draft_with_changes') && isUnreviewedOvercall(viability);
  if (overcall) {
    confidence = lower(confidence);
    disagreements.push({
      source: 'viability_vs_strategy',
      note: viability?.recommended_action?.reason
        ?? 'The anchor mechanism is not physician-reviewed — confirm the medicine with the physician before drafting.',
    });
  }

  // ── map the plan kind → the top-line verdict. Caution states take precedence over a clean "draft":
  //    an unreviewed mechanism (over-call) → confirm-mechanism; otherwise a hard engine disagreement →
  //    reconcile (amber). Neither flips the case to not-supportable. ──
  let verdict: ReadinessVerdict;
  if (plan.kind === 'draft') {
    verdict = overcall ? 'draft_confirm_mechanism' : hardDisagreement ? 'draft_reconcile' : 'draft';
  } else if (plan.kind === 'draft_with_changes') {
    verdict = 'draft_with_changes';
  } else if (plan.kind === 'contact_records') {
    verdict = 'contact_records';
  } else if (plan.kind === 'contact_alternative') {
    verdict = 'contact_alternative';
  } else if (plan.kind === 'not_draftable') {
    verdict = 'not_supportable';
  } else {
    verdict = 'needs_review';
  }
  // The deterministic verdict BEFORE the route-picker band projects over it — kept so we can detect a
  // genuine band-vs-core conflict (band says supportable while the core would Stop) and surface it.
  const deterministicVerdict = verdict;

  // ── ONE-BRAIN HEADLINE (Ryan 2026-06-22): the chip is a PROJECTION of the AI route-picker band when a
  //    ready plan exists. The band is the SAME brain the drafter pleads + the SOAP Assessment renders, so
  //    the chip cannot contradict the note. The deterministic core above is NOT discarded — it populated
  //    `plan` (the detail card), `missingFact`, confidence, and the over-call / hard-disagreement entries —
  //    but it no longer OWNS the headline. When the core would have said Stop/not-supportable while the band
  //    says supportable, we DO NOT silently flip: the band wins the headline AND we add a VISIBLE
  //    'band_vs_deterministic' disagreement so the RN sees the core's concern (e.g. a dx the info-light core
  //    thinks is missing). When the band is null (flag off / cold / error) the deterministic verdict stands
  //    (fallback-only — the prior behavior, fully preserved). The conservative unread-chart overlay below
  //    still applies on top of the band-projected verdict, so a negative band never asserts "not supportable"
  //    on an unread chart. ──
  const band = signals.routePickerViability ?? null;
  if (band != null) {
    const bandVerdict = routePickerBandToVerdict(band);
    // Conflict: the band clears the case for drafting but the deterministic core would have stopped it.
    if (isGoVerdict(bandVerdict) && (deterministicVerdict === 'not_supportable' || deterministicVerdict === 'needs_review')) {
      disagreements.push({
        source: 'band_vs_deterministic',
        note: `The route-picker plan reads this as ${band.replace(/_/g, ' ')}, but the deterministic check would ${deterministicVerdict === 'not_supportable' ? 'call it not supportable' : 'route it for review'} (it may see a missing diagnosis or anchor the plan resolved differently). Confirm before drafting.`,
      });
      confidence = lower(confidence);
    }
    verdict = bandVerdict; // the band wins the headline (one-brain)
  }

  // Conservative extraction overlay (Ryan 2026-06-18): a NEGATIVE verdict reached on a chart that is
  // not fully read becomes "read the chart first" — never conclude "not supportable" / "request a
  // record" / "needs review" on an incomplete parse (the record may be in the unread pages). A GO
  // verdict is NOT downgraded (it only loses confidence, handled below); a found bridge route stands.
  if (hasUnreadPages && (verdict === 'contact_records' || verdict === 'not_supportable' || verdict === 'needs_review')) {
    verdict = 'read_chart_first';
  }

  // ── extraction overlay: incomplete parse lowers confidence + is surfaced (never flips supportable).
  //    Decision input (hasUnreadPages) is single-sourced; extraction is DISPLAY-ONLY for the % detail. ──
  if (hasUnreadPages) {
    confidence = lower(confidence);
    const pct = extraction?.coveragePct;
    disagreements.push({
      source: 'extraction',
      note: typeof pct === 'number'
        ? `Only ${pct}% of the record is read — finish extraction before finalizing the plan.`
        : 'Part of the record is still unread — finish extraction before finalizing the plan.',
    });
  } else if (signals.hasUnreadPages === null) {
    // Read-state unknown is NOT "fully read" — note it and stay cautious, but don't block.
    disagreements.push({ source: 'extraction', note: 'Chart read-state unavailable — confirm the record is fully read.' });
    confidence = lower(confidence);
  }

  // ── AI sanity overlay: ADD-CAUTION-ONLY, asymmetric. concern/caution flag + lower; clear/unavailable do nothing. ──
  if (sanity === 'concern') {
    confidence = lower(confidence);
    disagreements.push({ source: 'ai_sanity', note: 'The AI sanity check flagged a CONCERN about this case — review it before proceeding.' });
  } else if (sanity === 'caution') {
    confidence = lower(confidence);
    disagreements.push({ source: 'ai_sanity', note: 'The AI sanity check flagged a CAUTION — give the case a closer look.' });
  }
  // sanity === 'clear' → no effect (it may never RELAX a deterministic caution).
  // sanity === null (unavailable) → no effect (absence is not all-clear).

  const nextAction = nextActionFor(verdict, plan, disagreements, sanity);
  // The headline DETAIL must match the (possibly band-projected) verdict, not the deterministic plan's
  // detail — otherwise a band-won "Ready to draft" headline would carry a "Not supportable as filed" line.
  // When the band drove the headline to a verdict the deterministic core would NOT have produced, use a
  // band-derived line; otherwise the deterministic plan.detail is the right summary (it matches). The detail
  // CARD still renders `plan` (the full deterministic plan) unchanged — only this one-line summary follows
  // the headline. read_chart_first (the conservative overlay) gets its own line regardless of source.
  const detail = (band != null && verdict !== deterministicVerdict)
    ? detailForBandVerdict(verdict, plan)
    : plan.detail;
  return { verdict, title: VERDICT_TITLE[verdict], detail, nextAction, confidence, disagreements, plan };
}

/** One-line summary for a headline verdict the route-picker band projected (so detail matches the chip). */
function detailForBandVerdict(verdict: ReadinessVerdict, plan: RecommendedPlan): string {
  switch (verdict) {
    case 'draft': return 'A supportable theory is on the record per the route-picker plan.';
    case 'draft_confirm_mechanism': return 'Draftable per the route-picker plan — confirm the mechanism with the physician.';
    case 'draft_reconcile': return 'Draftable per the route-picker plan — reconcile the flagged disagreement first.';
    case 'draft_with_changes': return plan.detail; // anchor-switch detail still applies
    case 'read_chart_first': return 'Part of the record is still unread — finish reading the chart before deciding.';
    case 'not_supportable': return 'The route-picker plan reads this as not supportable as filed.';
    case 'needs_review': return 'The route-picker plan routes this for a physician review before drafting.';
    default: return plan.detail;
  }
}

function nextActionFor(verdict: ReadinessVerdict, plan: RecommendedPlan, disagreements: readonly Disagreement[], sanity: ImpressionLevel | null): string {
  // The AI sanity signal nudges the next action ONE WAY ONLY — toward more diligence. A 'concern' that
  // CORROBORATES an unresolved engine disagreement strengthens the steer to "get more records / a
  // physician review" (never toward "just draft"). A 'clear' has no say here — it cannot relax the steer.
  const aiCorroboratesCaution = sanity === 'concern';
  switch (verdict) {
    case 'draft':
      return 'Send to the drafter.';
    case 'draft_confirm_mechanism':
      return 'Confirm the mechanism with the physician, then send to the drafter.';
    case 'draft_reconcile':
      return aiCorroboratesCaution
        ? 'The engines disagree and the AI check also flags a concern — get more records or a physician review before drafting.'
        : 'Reconcile the anchor — get more records or a physician review before drafting.';
    case 'draft_with_changes':
      return plan.switchToAnchor ? `Draft anchored on ${plan.switchToAnchor}.` : 'Draft with the stronger anchor.';
    case 'read_chart_first':
      return 'Finish reading the chart, then re-check the plan.';
    case 'contact_records':
      return plan.missingFact ? `Request from the veteran: ${plan.missingFact}` : 'Request the missing record from the veteran.';
    case 'contact_alternative':
      return 'Contact the veteran about the alternative (presumptive) route.';
    case 'not_supportable':
      return 'Discuss other conditions to consider before declining.';
    case 'needs_review':
    default:
      return disagreements.length > 0 ? 'Resolve the flagged disagreement before proceeding.' : 'A reviewer should take a look.';
  }
}
