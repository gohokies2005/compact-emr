// CaseViabilityCard data client (build plan §4.2, mirrors strategy-preview.ts). The 14-key
// caseViability v1 shape + optional route-stamped derivedAt — the contract is
// backend/src/config/caseViability.v1.schema.json (sha-pinned cross-repo).
//
// data: null ⇒ the surface is OFF (EMR_CASE_VIABILITY_ENABLED dark flag) or the read failed open —
// the card renders nothing. The vet-facing-leak guard is STRUCTURAL in the resolver (design §9
// SF-3: no BVA %, win/grant rate, IMO rate, or pair-atlas string can appear in why /
// excluded_traps.reason / missing_fact) — the card needs no scrubber of its own; the e2e asserts
// no BVA % renders as a belt-and-suspenders check.

import { apiGet } from './client';

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
export interface AiViabilityCard {
  readonly source: 'ai_route_picker';
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  readonly lead: { readonly upstream: string; readonly claimed: string; readonly framing: string; readonly cfr_basis: string; readonly mechanism: string; readonly confidence: string; readonly rationale: string; readonly counterargument: string };
  readonly convergent: ReadonlyArray<{ readonly upstream: string; readonly note: string }>;
  readonly alternatives: ReadonlyArray<{ readonly upstream: string; readonly framing: string; readonly why_not: string }>;
  readonly missing: ReadonlyArray<{ readonly fact: string; readonly why: string }>;
  readonly nuance: string;
  readonly overall: string;
}

export function getCaseViability(caseId: string): Promise<{ data: CaseViability | null; aiViability?: AiViabilityCard | null; chartFullyRead?: boolean | null }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/viability-card`);
}

/**
 * Consolidated calm SOAP-note Overview (Ryan 2026-06-19) — one narrative + a traffic light, grounded
 * on the AI picker plan. null when AI_ROUTE_PICKER_ENABLED is off / fail-open → the Overview shows the
 * dense panels as before.
 */
export interface SoapOverview {
  readonly light: 'green' | 'amber' | 'red';
  readonly headline: string;
  readonly soap: string;
  readonly next_action: string;
  readonly generated_at: string;
}

export function getSoapOverview(caseId: string): Promise<{ data: SoapOverview | null }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/soap-overview`);
}
