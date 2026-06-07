'use strict';

/**
 * bvaPairLookup — Tier-1 BVA stats source for the RN advisory AI tool.
 *
 * Serves the PRE-COMPUTED pair atlas (`references/bva_secondary_pairs.json`) for
 * secondary/aggravation grant/win rates + IMO uplift. We serve the atlas (not a
 * live recompute) because it is already curated, PHI-free, trusted by the drafter,
 * and — critically — already DECIDED-ONLY: its generator (build-pair-level-atlas-v2.py
 * line 214) filters `outcome IN ('partial','granted','denied')`, so remands/other are
 * excluded before counting. That matches Ryan's locked grant% definition (2026-06-06):
 *
 *   grant_pct = granted / (granted + partial + denied)            [full grant, decided-only]
 *   win_pct   = (granted + partial) / (granted + partial + denied) [favorable, decided-only]
 *   remanded + other are EXCLUDED entirely; remand rate is NOT reported.
 *
 * Honesty rules carried from the atlas consumer_contract:
 *  - tier gates reliability: high (n>=50) reliable, moderate (n>=15) suggestive,
 *    low (n>=5) anecdotal — low-tier results carry an explicit small-sample caveat.
 *  - imo_* percentages are null when imo_n is 0; callers must guard on imo_n >= 5
 *    before quoting the IMO uplift.
 *
 * These numbers are INTERNAL STRATEGY ONLY (CLAUDE.md #17) — never quoted in letter
 * prose. The advisory tool labels them letter_citable:false upstream.
 */

const fs = require('fs');
const path = require('path');
const { resolveCondition } = require('./bvaConditionMatch');

// Canonical atlas path; overridable via env for shadow-testing the isolated-atlas rebuild
// before it's swapped to canonical.
const ATLAS_PATH = process.env.FRN_BVA_ATLAS_PATH
  || path.join(__dirname, '..', '..', '..', 'references', 'bva_secondary_pairs.json');

/** Resolve a phrase to its canonical atlas key; fall back to the raw value if the
 *  resolver finds nothing (so an exact key still works even outside the map). */
function toKey(phrase) {
  return resolveCondition(phrase) || phrase;
}

// The four mental-health primaries the atlas keeps separate. The rollup combines
// them for the "is there any psychiatric anchor for this condition" question (Ryan
// 2026-06-06: "lump MDD/GAD and similar there").
const PSYCH_PRIMARIES = [
  'PTSD',
  'MDD / Depression',
  'Anxiety / GAD',
  'Acquired psychiatric (unspecified)',
];

const IMO_MIN_N = 5; // below this, do not quote the IMO uplift percentage

// Standing safety caveat on EVERY pair result (the isolated-atlas auditors were emphatic):
// a BVA grant% is selection-biased and is a RELATIVE ranking signal, never a win probability.
const RELATIVE_SIGNAL_CAVEAT =
  'BVA grant% is a RELATIVE ranking signal, NOT a probability of winning. Mechanism/medical-literature ' +
  'soundness must gate framing FIRST; the BVA number only breaks ties among already-sound anchors. ' +
  'For supplemental/post-denial claims, Board grant% says nothing about RO success. Internal strategy only.';

let _atlas = null;

/** Lazy-load + cache the atlas JSON. Throws if missing/corrupt (fail loud). */
function loadAtlas() {
  if (_atlas) return _atlas;
  const raw = fs.readFileSync(ATLAS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !parsed.pairs) {
    throw new Error('bvaPairLookup: atlas missing top-level "pairs" key');
  }
  _atlas = parsed;
  return _atlas;
}

// Clean methodology label (NOT the verbose generator changelog in _metadata.notes). Prefer a
// dedicated _metadata.basis field if the atlas ever adds one, so it self-updates without leaking notes.
const BASIS_LABEL = 'BVA decided cases (remands excluded), single-issue per-line attribution; relative ranking signal, not a win probability';
function atlasBasis() {
  const m = loadAtlas()._metadata || {};
  return m.basis || BASIS_LABEL;
}

/** Reset the cache (tests). */
function _reset() { _atlas = null; }

/** Build the small-sample / IMO / methodology caveats for a result. `p` is the raw pair
 *  object (so we can read the isolated-atlas additive fields when present). */
function buildCaveats(tier, imoN, p = {}) {
  const caveats = [RELATIVE_SIGNAL_CAVEAT];
  if (tier === 'novel') {
    caveats.push('Novel / very-thin pair: anecdotal only — do not rely on the rate.');
  } else if (tier === 'low') {
    caveats.push('Small sample (low tier): anecdotal direction only, not a reliable rate.');
  } else if (tier === 'moderate') {
    caveats.push('Moderate sample: suggestive, not definitive.');
  }
  if (imoN < IMO_MIN_N) {
    caveats.push(`IMO uplift not quotable (only ${imoN} decided cases had a private IMO).`);
  }
  // Isolated-atlas additive-field caveats (present only after the rebuild swap).
  if (p.wins_without_us === true) {
    caveats.push('wins_without_us: this pair grants even WITHOUT an IMO (near-presumptive) — do NOT read the high rate as a strong-letter signal.');
  }
  if (p.directionality != null && p.directionality_reliable === false) {
    caveats.push('Direction not reliable (thin reverse sample): do not infer that this direction beats the reverse.');
  }
  return caveats;
}

/**
 * Exact directional pair lookup: how does `claimed` fare when argued secondary to /
 * aggravated by `upstream`?
 * @returns {object} { found, upstream, claimed, basis, n, tier, win_pct, grant_pct,
 *   imo_n, imo_win_pct, imo_grant_pct, imo_quotable, n_secondary, n_aggravation, caveats }
 *   or { found:false, upstream, claimed, reason } when the pair isn't in the atlas.
 */
function pairLookup(upstream, claimed) {
  const atlas = loadAtlas();
  upstream = toKey(upstream);
  claimed = toKey(claimed);
  const byUpstream = atlas.pairs[upstream];
  if (!byUpstream || !byUpstream[claimed]) {
    return {
      found: false,
      upstream,
      claimed,
      reason: `No BVA pair data for ${upstream} -> ${claimed} (below n=5 threshold or not extracted). Verify before relying on it.`,
    };
  }
  const p = byUpstream[claimed];
  const imoQuotable = p.imo_n >= IMO_MIN_N && p.imo_grant_pct != null;
  // Prefer the small-N-shrunk rate for DISPLAY (isolated-atlas rule: "level is shrunk_grant_pct").
  const displayGrant = p.shrunk_grant_pct != null ? p.shrunk_grant_pct : p.grant_pct;
  return {
    found: true,
    upstream,
    claimed,
    basis: atlasBasis(),
    relative_signal_only: true, // never a win probability — see caveats
    n: p.n,
    tier: p.tier,
    win_pct: p.win_pct,
    grant_pct: p.grant_pct,
    display_grant_pct: displayGrant,   // use THIS for display (shrunk when small-N)
    imo_n: p.imo_n,
    imo_win_pct: imoQuotable ? p.imo_win_pct : null,
    imo_grant_pct: imoQuotable ? p.imo_grant_pct : null,
    imo_quotable: imoQuotable,
    n_secondary: p.n_secondary,
    n_aggravation: p.n_aggravation,
    // Isolated-atlas additive fields (undefined on the pre-swap atlas — handled gracefully):
    shrunk_grant_pct: p.shrunk_grant_pct,
    directionality: p.directionality,
    directionality_reliable: p.directionality_reliable,
    reverse_n: p.reverse_n,
    reverse_grant_pct: p.reverse_grant_pct,
    non_directional: p.non_directional,
    wins_without_us: p.wins_without_us,
    n_single_issue: p.n_single_issue,
    caveats: buildCaveats(p.tier, p.imo_n, p),
    letter_citable: false, // CLAUDE.md #17 — internal strategy only
  };
}

function tierFor(n) {
  if (n >= 50) return 'high';
  if (n >= 15) return 'moderate';
  return 'low';
}

/**
 * Mental-health rollup: combine the 4 psych primaries (PTSD + MDD/Depression +
 * Anxiety/GAD + Acquired psychiatric) for a single claimed condition, recomputing
 * the decided-only rates over the pooled denominator. Valid because every pair in
 * the atlas uses the SAME decided-only base (granted+partial+denied), so counts add.
 * @returns {object} pooled result + `components` (the contributing pairs) + caveats.
 */
function psychRollup(claimed) {
  const atlas = loadAtlas();
  claimed = toKey(claimed);
  let n = 0, wins = 0, grants = 0, imoN = 0, imoWins = 0, imoGrants = 0;
  let nSecondary = 0, nAggravation = 0;
  const components = [];

  for (const primary of PSYCH_PRIMARIES) {
    const p = atlas.pairs[primary] && atlas.pairs[primary][claimed];
    if (!p) continue;
    // Reconstruct integer counts from stored pct * n (atlas stores rates, not raw
    // counts). Round to nearest int — exact because pct was computed from these ns.
    const pGrants = Math.round((p.grant_pct / 100) * p.n);
    const pWins = Math.round((p.win_pct / 100) * p.n);
    n += p.n; wins += pWins; grants += pGrants;
    nSecondary += p.n_secondary || 0;
    nAggravation += p.n_aggravation || 0;
    if (p.imo_n) {
      imoN += p.imo_n;
      if (p.imo_win_pct != null) imoWins += Math.round((p.imo_win_pct / 100) * p.imo_n);
      if (p.imo_grant_pct != null) imoGrants += Math.round((p.imo_grant_pct / 100) * p.imo_n);
    }
    components.push({ upstream: primary, n: p.n, grant_pct: p.grant_pct, win_pct: p.win_pct, imo_n: p.imo_n });
  }

  if (n === 0) {
    return {
      found: false,
      claimed,
      reason: `No BVA pair data for any psychiatric primary -> ${claimed}. Verify before relying on it.`,
    };
  }

  const tier = tierFor(n);
  const imoQuotable = imoN >= IMO_MIN_N;
  const grantPct = Math.round((100 * grants / n) * 10) / 10;
  return {
    found: true,
    upstream: 'Any psychiatric (PTSD/MDD/GAD/acquired)',
    claimed,
    basis: atlasBasis(),
    relative_signal_only: true,
    n,
    tier,
    win_pct: Math.round((100 * wins / n) * 10) / 10,
    grant_pct: grantPct,
    display_grant_pct: grantPct, // pooled rate; per-pair shrink not aggregated
    imo_n: imoN,
    imo_win_pct: imoQuotable ? Math.round((100 * imoWins / imoN) * 10) / 10 : null,
    imo_grant_pct: imoQuotable ? Math.round((100 * imoGrants / imoN) * 10) / 10 : null,
    imo_quotable: imoQuotable,
    n_secondary: nSecondary,
    n_aggravation: nAggravation,
    caveats: buildCaveats(tier, imoN),
    components,
    letter_citable: false,
  };
}

module.exports = { pairLookup, psychRollup, loadAtlas, atlasBasis, _reset, PSYCH_PRIMARIES, RELATIVE_SIGNAL_CAVEAT };
