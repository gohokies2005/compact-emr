// NEGATIVE PAIRING PRE-CHECK (2026-07-22) — deterministic, $0, fail-open.
//
// Ask-Aegis consumption of the curated "NOT SUPPORTABLE secondary theories" table (FRN
// negative_pairings.md -> negative_pairings.json -> negativePairings.generated.ts). When a viability
// question's (claimed, upstream) pairing matches a curated negative entry IN THE AUTHORED DIRECTION, we
// inject a confident "not supportable + reason + VA counterargument + deciding PMIDs" block into the
// advisory prompt context so the model answers decisively instead of retrieving thin comorbidity cites.
//
// DESIGN CHOICE (deterministic lookup, NOT chunk-into-ref_chunk): see the module doc in
// runAdvisoryAnswer / the design report. A semantic chunk could rank below the cosine floor and silently
// NOT surface — the whole point is a guaranteed, deterministic verdict. This also needs no re-index and
// parallels the shipped viability_facts / planBlock seams. RECOMMENDATION-ONLY: it never blocks an answer.
//
// PORTABILITY: this is the EMR port of FRN's app/services/negativePairingLookup.js. The EMR has no vendored
// routingResolver, so matching here uses the precomputed VARIANT strings (the `/`-variants + parenthetical
// aliases baked into the generated const). The (claimed, upstream) fed in comes from the persisted route-
// picker plan lead, which already carries canonical condition names — so string-variant matching suffices.

import { NEGATIVE_PAIRINGS } from './negativePairings.generated.js';

export interface NegativePairing {
  upstream: string;
  claimed: string;
  verdict: string; // 'not_supportable'
  caution: boolean;
  reason: string;
  counterargument: string;
  pmids: readonly string[];
  upstream_variants: readonly string[];
  claimed_variants: readonly string[];
  upstream_topics: readonly string[];
  claimed_topics: readonly string[];
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

/**
 * Return the curated negative record IFF (claimed, upstream) matches an entry in the SAME direction it was
 * authored (upstream -> claimed). The reverse (viable) direction returns null. Never throws (fail-open).
 */
export function lookupNegativePairing(
  claimed: string | null | undefined,
  upstream: string | null | undefined,
): NegativePairing | null {
  try {
    const nClaimed = normalize(claimed);
    const nUpstream = normalize(upstream);
    if (!nClaimed || !nUpstream) return null;
    for (const rec of NEGATIVE_PAIRINGS) {
      if (variantMatch(nUpstream, rec.upstream_variants) && variantMatch(nClaimed, rec.claimed_variants)) {
        return rec;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Look up EVERY curated negative record among a set of candidate upstreams for one claimed condition
 * (the plan's lead + alternatives + excluded upstreams). Deduped by upstream->claimed. Fail-open to [].
 */
export function lookupNegativePairings(
  claimed: string | null | undefined,
  upstreams: readonly (string | null | undefined)[],
): NegativePairing[] {
  const out: NegativePairing[] = [];
  const seen = new Set<string>();
  for (const up of upstreams ?? []) {
    const rec = lookupNegativePairing(claimed, up);
    if (rec) {
      const key = `${rec.upstream}->${rec.claimed}`;
      if (!seen.has(key)) { seen.add(key); out.push(rec); }
    }
  }
  return out;
}

/**
 * Format matched negative record(s) as a deterministic, self-describing advisory block for the LLM context.
 * RECOMMENDATION-ONLY. The reason/counterargument/PMIDs are INTERNAL strategy — the block tells the model to
 * explain them to the RN/physician but never to quote them in a letter. Returns null when nothing matched.
 */
export function formatNegativePairingBlock(recs: readonly NegativePairing[]): string | null {
  if (!recs || recs.length === 0) return null;
  const L: string[] = [];
  L.push('=== CURATED NEGATIVE PAIRING PRE-CHECK (deterministic, physician-curated — AUTHORITATIVE for viability) ===');
  L.push(
    'The following claimed<->upstream secondary pairing(s) for THIS case match our curated "NOT SUPPORTABLE ' +
      'as a secondary nexus" list. This is a MECHANISM verdict from the medical literature (no BVA / win-rate ' +
      'figure). When asked whether the pairing works, answer confidently that it is NOT supportable as a ' +
      'secondary and give the reason + the VA\'s strongest counterargument in plain RN/physician language. Do ' +
      'NOT lean on thin comorbidity citations to argue FOR it. This is guidance for the human, NEVER a hard ' +
      'block — if they choose to proceed, state the mechanistic problem plainly. The reason/counterargument/' +
      'PMIDs below are INTERNAL strategy: never quote them to the veteran or in a letter.',
  );
  recs.forEach((r, i) => {
    L.push('');
    L.push(`${i + 1}) Claimed "${r.claimed}" secondary to "${r.upstream}" — NOT SUPPORTABLE${r.caution ? ' (weak / caution — do not let a letter cite the intuitive mechanism)' : ''}.`);
    if (r.reason) L.push(`   Reason (mechanism): ${r.reason}`);
    if (r.counterargument) L.push(`   VA counterargument: ${r.counterargument}`);
    if (r.pmids && r.pmids.length) L.push(`   Deciding literature (PMIDs — INTERNAL, do not quote in a letter): ${r.pmids.join(', ')}`);
  });
  L.push('=== END NEGATIVE PAIRING PRE-CHECK ===');
  return L.join('\n');
}
