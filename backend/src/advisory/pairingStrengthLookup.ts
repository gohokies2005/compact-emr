// PAIRING-STRENGTH PRE-CHECK (2026-07-22) — deterministic, $0, fail-open. The POSITIVE counterpart to
// negativePairingLookup.ts.
//
// The mechanism-viability verdict consumption of the curated STRENGTH grades that the ops-window grading pass
// stamped on every library anchor (FRN [STRENGTH:] anchors -> pairing_strength.json ->
// pairingStrength.generated.ts). When the drafter's CHOSEN pairing (claimed downstream, proposed upstream)
// matches a graded anchor IN THE AUTHORED DIRECTION, we feed its grade to the verdict model as an AUTHORITATIVE
// anchor so an established pairing (e.g. PTSD -> OSA) can never be false-borderlined on thin excerpts — while
// the model still judges THIS veteran's case on top of the grade.
//
// DESIGN: this is a GATE/anchor, not a router. It answers only "how strong is this pairing in general?" It
// never picks the drafter's direction and never blocks a draft. RECOMMENDATION-ONLY.
//
// PORTABILITY: EMR port of FRN's app/services/pairingStrengthLookup.js. The EMR has no vendored routingResolver,
// so matching here uses the precomputed VARIANT strings (the `/`-variants + parenthetical + routing aliases
// baked into the generated const). The (claimed, upstream) fed in comes from the persisted route-picker plan
// lead / the veteran-theory extraction, which already carry canonical condition names — so string-variant
// matching suffices.

import { PAIRING_STRENGTHS } from './pairingStrength.generated.js';

export interface PairingStrength {
  upstream: string;
  downstream: string;
  grade_raw: string;
  /** normalized ceiling tier: 'strong'|'moderate-strong'|'moderate'|'weak-moderate'|'weak' */
  grade_tier: string;
  /** 'viable' (strong..moderate) | 'borderline' (weak-moderate..weak) */
  verdict_anchor: string;
  /** = grade_raw; carries the conditional framing so the model picks the arm that fits the veteran */
  framing_note: string;
  /** deciding literature harvested from the anchor body — backup for the verdict / Ask-Aegis / drafter */
  pmids: readonly string[];
  upstream_variants: readonly string[];
  downstream_variants: readonly string[];
  upstream_topics: readonly string[];
  downstream_topics: readonly string[];
}

// Same normalization FRN's routingResolver + matcher use (lowercase, hyphen/underscore -> space, collapse).
function normalize(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Does any stored variant match the normalized query? Substring for >=4 chars; word-boundary for <=3.
function variantMatch(normQuery: string, variants: readonly string[]): boolean {
  if (!normQuery) return false;
  for (const v of variants) {
    const nv = normalize(v);
    if (!nv) continue;
    if (nv.length <= 3) {
      const re = new RegExp(`(^|\\W)${nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`);
      if (re.test(normQuery)) return true;
    } else if (normQuery.includes(nv)) {
      return true;
    }
  }
  return false;
}

const TIER_RANK: Record<string, number> = {
  strong: 5, 'moderate-strong': 4, moderate: 3, 'weak-moderate': 2, weak: 1,
};

/**
 * Return the STRONGEST curated strength record for (claimed, upstream) matched in the SAME direction it was
 * authored (upstream -> downstream). The reverse direction returns null. Never throws (fail-open).
 */
export function lookupPairingStrength(
  claimed: string | null | undefined,
  upstream: string | null | undefined,
): PairingStrength | null {
  try {
    const nClaimed = normalize(claimed);
    const nUpstream = normalize(upstream);
    if (!nClaimed || !nUpstream) return null;
    let best: PairingStrength | null = null;
    for (const rec of PAIRING_STRENGTHS) {
      if (variantMatch(nUpstream, rec.upstream_variants) && variantMatch(nClaimed, rec.downstream_variants)) {
        if (!best || (TIER_RANK[rec.grade_tier] || 0) > (TIER_RANK[best.grade_tier] || 0)) best = rec;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Look up the strength grade for a claimed condition against a set of candidate upstreams (the plan's lead +
 * alternatives). Deduped by upstream->downstream. Fail-open to []. Used by Ask-Aegis.
 */
export function lookupPairingStrengths(
  claimed: string | null | undefined,
  upstreams: readonly (string | null | undefined)[],
): PairingStrength[] {
  const out: PairingStrength[] = [];
  const seen = new Set<string>();
  for (const up of upstreams ?? []) {
    const rec = lookupPairingStrength(claimed, up);
    if (rec) {
      const key = `${rec.upstream}->${rec.downstream}`;
      if (!seen.has(key)) { seen.add(key); out.push(rec); }
    }
  }
  return out;
}

/**
 * Format matched strength grade(s) as a deterministic advisory block for the Ask-Aegis LLM context.
 * RECOMMENDATION-ONLY. The grade is the GENERAL pairing strength — authoritative for how strong the pairing is
 * in the abstract, but NOT a directive: the model still judges how THIS veteran's record fits. PMIDs are
 * INTERNAL backup literature. Returns null when nothing matched.
 */
export function formatPairingStrengthBlock(recs: readonly PairingStrength[]): string | null {
  if (!recs || recs.length === 0) return null;
  const L: string[] = [];
  L.push('=== CURATED PAIRING STRENGTH (deterministic, physician-graded library — AUTHORITATIVE for the GENERAL pairing) ===');
  L.push(
    'The following claimed<-upstream secondary pairing(s) for THIS case carry a physician-curated STRENGTH grade ' +
      'from our medical-literature library (a MECHANISM strength, NOT a BVA / win-rate figure). Use the grade as the ' +
      'authoritative baseline for how strong the pairing is IN GENERAL: an ESTABLISHED pathway is viable on ' +
      'association-level evidence alone, so do NOT talk the human out of a graded pairing by citing thin comorbidity ' +
      'caveats. But the grade is the GENERAL strength, NOT a directive to pick it: judge how well THIS veteran\'s ' +
      'record fits the graded pathway and name any case-specific disqualifier. If a grade is conditional ' +
      '("MODERATE (…) / WEAK (…)"), say which arm fits. PMIDs are backup literature — INTERNAL strategy, never quote ' +
      'them to the veteran or in a letter.',
  );
  recs.forEach((r, i) => {
    L.push('');
    L.push(`${i + 1}) Claimed "${r.downstream}" secondary to "${r.upstream}" — library grade ${r.grade_raw} (baseline: ${r.verdict_anchor}).`);
    if (r.pmids && r.pmids.length) L.push(`   Deciding literature (PMIDs — INTERNAL backup, do not quote in a letter): ${r.pmids.join(', ')}`);
  });
  L.push('=== END PAIRING STRENGTH ===');
  return L.join('\n');
}
