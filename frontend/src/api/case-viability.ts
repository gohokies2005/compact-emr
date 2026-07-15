// CaseViabilityCard data client (build plan §4.2, mirrors strategy-preview.ts). The 14-key
// caseViability v1 shape + optional route-stamped derivedAt — the contract is
// backend/src/config/caseViability.v1.schema.json (sha-pinned cross-repo).
//
// data: null ⇒ the surface is OFF (EMR_CASE_VIABILITY_ENABLED dark flag) or the read failed open —
// the card renders nothing. The vet-facing-leak guard is STRUCTURAL in the resolver (design §9
// SF-3: no BVA %, win/grant rate, IMO rate, or pair-atlas string can appear in why /
// excluded_traps.reason / missing_fact) — the card needs no scrubber of its own; the e2e asserts
// no BVA % renders as a belt-and-suspenders check.

import { apiGet, apiPost } from './client';

export type ViabilityBand = 'strong' | 'moderate' | 'conditional' | 'weak' | 'abstain' | 'redirect';
export type AnchorTier = 'blessed' | 'conditional' | 'chain' | 'plausible' | 'excluded';

export interface ViabilityBestAnchor {
  readonly upstream_canonical: string;
  readonly upstream_verbatim: string;
  readonly M_static: number | null;
  readonly M_eff: number | null;
  /** null = not-yet-scored — render "E: not yet scored", NEVER "0"/"no evidence" (design §9 SF-4). */
  readonly E: number | null;
  readonly tier: AnchorTier;
  readonly basis: string | null;
  readonly is_granted_sc: boolean;
  readonly mechanism_class: string | null;
  readonly requires: string | null;
  /** Present only after a 4.130 psych collapse. */
  readonly mechanism_member?: string;
  /** Present (true) only on a 3.310(b) aggravation-only re-characterized pair (FRN engine 5d04b62). */
  readonly aggravation_only?: boolean;
  /** Present (true) only alongside aggravation_only — direct causation is reliably denied (best_anchor only). */
  readonly causation_denied?: boolean;
  /**
   * Over-call guard provenance (FRN 3d09819): true only when the mechanism row was physician-curated.
   * 94.5% of the table is false. When false, the card must NOT headline "Strong/Moderate" — it shows
   * a CANDIDATE + a "not physician-reviewed" badge. Absent on direct-axis anchors (evidenced facts).
   */
  readonly physician_reviewed?: boolean;
}

/**
 * The resolver's SSOT band→action policy (stamped by the EMR route adapter). The card consumes this
 * rather than re-deriving — `action:'escalate'` + `route:'physician'` is what an unreviewed anchor
 * returns regardless of band, and is the signal to refuse a green headline.
 */
export interface ViabilityRecommendedAction {
  readonly action: 'auto_run' | 'proceed_with_guidance' | 'escalate';
  readonly route: 'aegis' | 'physician' | null;
  readonly band: ViabilityBand | null;
  readonly reason: string;
}

export interface ViabilityAlternative {
  readonly upstream_canonical: string;
  readonly M_eff: number | null;
  readonly tier: AnchorTier;
  readonly is_granted_sc: boolean;
  /** Present (true) only on a 3.310(b) aggravation-only re-characterized pair (FRN engine 5d04b62). */
  readonly aggravation_only?: boolean;
}

/**
 * BRIDGE-ANCHOR pathway (2026-06-16) — a provisional two-hop SUGGESTION (exposure → PACT-presumptive
 * intermediate dx → claimed secondary), never a viability band. Present only when the engine fires a
 * fully fact-gated bridge (G1–G4) with BRIDGE_ANCHOR_ENABLED on. `suggestion` is FINAL RN-facing copy
 * authored by the FRN engine — render it VERBATIM (no re-templating, no BVA %/odds per CLAUDE.md #17).
 */
export interface BridgePathway {
  readonly bridge_provisional: boolean;
  readonly physician_review_required: boolean;
  readonly exposure: string;
  readonly intermediate_dx: string;
  readonly intermediate_presumptive_basis: string;
  readonly claimed: string;
  readonly pair_tier: string | null;
  readonly pair_M: number | null;
  readonly suggestion: string;
  readonly provenance?: { readonly pact_map_hash: string | null; readonly pair_table_hash: string | null };
}

export interface CaseViability {
  // v1 (secondary-only) or v2 (direct-axis fold). The card reads the common fields either way; v2-only
  // keys (incl. bridge_pathways) are optional, so a v1 object still satisfies this type.
  readonly version: 1 | 2;
  readonly claimed_canonical: string | null;
  readonly viability: ViabilityBand;
  readonly best_anchor: ViabilityBestAnchor | null;
  readonly alternatives: readonly ViabilityAlternative[];
  readonly why: string;
  readonly missing_fact: string | null;
  readonly presumptive_redirect: { readonly path: string; readonly note: string; readonly advisory: boolean } | null;
  readonly graveyard_redirect: { readonly dead_anchor: string; readonly redirect_to: string; readonly rationale: string; readonly redirect_blocked: boolean } | null;
  readonly excluded_traps: ReadonlyArray<{ readonly upstream_canonical: string; readonly reason: string }>;
  readonly confidence: 'high' | 'low';
  readonly mode: 'info_light' | 'chart_refined';
  readonly table_version: string | null;
  readonly table_content_hash: string | null;
  /** BRIDGE-ANCHOR (v2 only): provisional two-hop suggestions; present only when a bridge fires. */
  readonly bridge_pathways?: readonly BridgePathway[];
  readonly derivedAt?: string;
  /** SSOT band→action policy (resolver.recommendedAction), route-adapter-stamped. Absent on fail-open. */
  readonly recommended_action?: ViabilityRecommendedAction;
}

/**
 * AI route-picker card (Ryan 2026-06-19) — the SAME brain the drafter uses, surfaced on the card so
 * the RN sees the ANTICIPATED drafter pick instead of the static M-tier engine. Present only when
 * AI_ROUTE_PICKER_ENABLED is on (else null → the card renders the static `data`). Plain language;
 * no M-tier/E jargon, no plausible-default chart junk.
 */
/** The route-picker plan's viability band — the ONE brain the Overview chip projects (Ryan 2026-06-22). */
export type RoutePickerViability = 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';

export interface AiViabilityCard {
  readonly source: 'ai_route_picker';
  readonly viability: RoutePickerViability;
  readonly lead: { readonly upstream: string; readonly claimed: string; readonly framing: string; readonly cfr_basis: string; readonly mechanism: string; readonly confidence: string; readonly rationale: string; readonly counterargument: string };
  readonly convergent: ReadonlyArray<{ readonly upstream: string; readonly note: string }>;
  readonly alternatives: ReadonlyArray<{ readonly upstream: string; readonly framing: string; readonly why_not: string }>;
  readonly missing: ReadonlyArray<{ readonly fact: string; readonly why: string }>;
  readonly nuance: string;
  readonly overall: string;
}

/**
 * The discriminated RELIABILITY state of the route-picker plan (Ryan 2026-06-21, Zimmelman). The FE uses
 * this to show an HONEST surface — a spinner while 'computing', a retry button on 'error', the grounded
 * plan when 'ready' — instead of a misleading "Not supportable" resting verdict on a missing/failed plan.
 *   - 'ready'     → a plan matching the current inputs (carries the card)
 *   - 'computing' → a compute is in flight; the FE polls until it resolves
 *   - 'error'     → the last compute FAILED (carries an RN-safe message); the FE shows "retry", not a verdict
 *   - 'none'      → no plan/none in flight (the GET fired an off-request recompute; the FE may poll/compute)
 *   - 'off'       → the AI_ROUTE_PICKER_ENABLED flag is off (the card uses the static engine)
 */
export type AiViabilityState =
  | { readonly status: 'off' }
  | { readonly status: 'none' }
  | { readonly status: 'computing' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ready'; readonly card: AiViabilityCard };

export interface CaseViabilityResponse {
  readonly data: CaseViability | null;
  readonly aiViability?: AiViabilityCard | null;
  readonly aiViabilityState?: AiViabilityState;
  readonly chartFullyRead?: boolean | null;
}

export function getCaseViability(caseId: string): Promise<CaseViabilityResponse> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/viability-card`);
}

/**
 * On-demand SYNCHRONOUS compute (the spinner path + the retry button). Runs the picker call inside the
 * request (~25s) and returns the resulting state — the grounded plan or an honest error. Use this when the
 * read state is 'none' (first view) or 'error' (retry) so the FIRST view grounds after a spinner rather than
 * showing a misleading no-go.
 */
export function computeCaseViability(caseId: string): Promise<{ aiViabilityState: AiViabilityState }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/viability-card/compute`, {});
}

/**
 * AI-synthesized SOAP-note Overview (Ryan 2026-06-20) — the model writes a smooth Subjective / Objective /
 * Assessment / Plan note from the context the Overview assembled. null = fail-open (the card falls back to
 * the deterministic verdict line). The FE POSTs the context (like the sanity-impression).
 */
/** An objective hard-data MEASUREMENT for the SOAP Objective (#63): AHI/RDI, CPAP usage/adherence, BP,
 *  A1c, audiometric thresholds, PHQ-9/PCL-5, etc. Grounded (the value appears in the chart). `display` is
 *  the FE-ready one-liner (e.g. "AHI 28.4 events/hr (diagnostic, 4/2024)"). */
export interface SoapMeasurement {
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly qualifier: string | null;
  readonly date: string | null;
  readonly display: string;
}

export interface SoapNote {
  readonly subjective: string;
  readonly objective: string;
  readonly assessment: string;
  readonly plan: string;
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly action: 'draft' | 'get_records' | 'clarify' | 'physician_review' | 'reject';
  /** CHIP DISAMBIGUATOR (Ryan 2026-07-14): the route-picker band the note was grounded on. 'marginal' and
   *  'needs_physician_review' both persist action 'physician_review', but the chip renders marginal AMBER
   *  ("Draftable — thin case") and needs_physician_review GREEN ("Ready to draft — doctor confirms theory at
   *  signing"). Absent on older stored notes / ungrounded notes → the chip uses the green treatment (same
   *  band family). Display-only. */
  readonly viabilityBand?: RoutePickerViability;
  /** Deterministic grounding guard: a clinical value in the note not found in the source facts (verify). */
  readonly caveat?: string | null;
  /** Condition-relevant objective hard data pulled from the chart (#63). Absent/empty → no measurements line. */
  readonly measurements?: readonly SoapMeasurement[];
  /** True when this note is the deterministic EXPLANATORY fallback (the model truncated/failed/returned
   *  nothing on this open) rather than a full model-written summary. The card shows a subtle hint; the note
   *  still renders (never blank) and its decision/action still match the verdict (Zimmelman 2026-06-22). */
  readonly fallback?: boolean;
}

export interface SoapContextInput {
  readonly claimedCondition: string;
  readonly veteranStatement?: string | null;
  readonly theory?: string | null;
  readonly mechanism?: string | null;
  readonly scConditions?: readonly string[];
  readonly activeProblems?: readonly string[];
  readonly keyFacts?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly medications?: ReadonlyArray<{ readonly drugName: string; readonly indication: string | null }>;
  readonly coverageNote?: string | null;
  readonly engineVerdict?: string | null;
  readonly engineNextAction?: string | null;
}

/** The route-picker plan's framing carried on the SOAP response so the FE headline can match the grounded
 *  Assessment (H1). Present (with grounded:true) only when the SOAP note is grounded on the route-picker plan
 *  (the SAME brain the drafter pleads); null when ungrounded (flag off / no plan / stale / wrong-condition). */
export interface SoapRoutePickerFraming {
  readonly framing: string;
  readonly cfr_basis: string;
  readonly mechanism: string;
  readonly rationale: string;
  readonly counterargument: string;
  readonly confidence: string;
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  readonly planHash: string;
}

/** Server response for the SOAP overview. `data` is the note (stored or fresh); `fingerprint` identifies
 *  the inputs the note was written from; `stale` = a stored note exists but the inputs changed since (new
 *  info — the card shows a subtle hint, never auto-spends); `cached` = served from the DB cache ($0).
 *  `grounded` = the note's Assessment renders the route-picker plan (so the FE prefers its framing for the
 *  headline); `routePickerFraming` = that plan's framing (null when ungrounded). (H1) */
export interface SoapNoteResult {
  readonly data: SoapNote | null;
  readonly fingerprint?: string;
  readonly stale?: boolean;
  readonly cached?: boolean;
  readonly grounded?: boolean;
  readonly routePickerFraming?: SoapRoutePickerFraming | null;
  /** pollOnly responses only (Dr. Kasky 2026-06-29 auto-refresh): true = the async precompute hasn't landed the
   *  final note yet (keep polling); false/absent = a real note is in `data`. Never set on a normal open. */
  readonly generating?: boolean;
}

/** Fetch the SOAP overview. On open this SERVES THE STORED note for $0; pass { forceRegenerate: true }
 *  (the "Regenerate with new info" button) to force a fresh model call.
 *
 *  pollOnly (Dr. Kasky 2026-06-29 auto-refresh): a $0 STATUS CHECK used by the card's auto-refresh poll while
 *  the served note is a provisional fallback brief. It serves the persisted real note the instant the async
 *  precompute lands it, otherwise returns `{ data: null, generating: true }` WITHOUT running the model — so the
 *  ~15s poll never re-bills Sonnet during the warming window. Never combine with forceRegenerate. */
export function getSoapNote(caseId: string, ctx: SoapContextInput, opts?: { forceRegenerate?: boolean; pollOnly?: boolean }): Promise<SoapNoteResult> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/soap-overview`, { ...ctx, forceRegenerate: opts?.forceRegenerate === true, pollOnly: opts?.pollOnly === true });
}
