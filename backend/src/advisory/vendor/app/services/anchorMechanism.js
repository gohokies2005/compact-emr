// app/services/anchorMechanism.js
//
// SHARED RESOLVER for the upstream-anchor mechanism-eligibility table
// (references/anchor_mechanism_pairs.json), per
// docs/ANCHOR_SELECTION_DECISION_2026-06-10.md.
//
// M1 STATUS: built + unit-tested, NO CONSUMERS WIRED. The framingGate ranker
// (rankAnchorCandidates) and EMR bestGrantedScPair will call this in M3, behind
// the ANCHOR_MECHANISM_GATE flag. Until then this module ships DARK.
//
// resolveAnchorEligibility(upstreamText, claimedText) — given free-text condition
// labels (chart-verbatim is fine), canonicalize via framingGate.canonicalizeCondition
// (the SAME function the generator used, so keys line up), look up the
// direction-locked row, and return the eligibility verdict. A pair absent from
// the table defaults to `plausible` (eligible, mechanism_unconfirmed,
// physician_review_anchor) — the long tail always drafts; it never blocks and
// never silently invents (the cold-exposure-class backup from the decision doc).
//
// This module makes NO causal claim and does NOT decide the anchor. It returns
// the eligibility partition the L3 ranker consumes. ABSTAIN/park is the caller's
// job when zero eligible anchors exist.

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ARTIFACT_PATH = path.join(PROJECT_ROOT, 'references', 'anchor_mechanism_pairs.json');

// Canonicalize via the PURE conditionCanon module (NOT framingGate) so this
// module's require-graph stays free of better-sqlite3 / llm-client / the DB —
// the Ask-Aegis Lambda vendors anchorMechanism + conditionCanon + the table
// only. conditionCanon re-exports the SAME canonicalizeCondition / isCanonicalLabel
// the generator used, so table keys still line up. (Task f keystone, 2026-06-10.)
const conditionCanon = require('./conditionCanon');

// ── artifact load + cache (version-gated) ────────────────────────────────────
let _cache = null;       // { version, content_hash, byKey, byClaimed, preference_rank }

function _canon(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Accept an already-canonical label verbatim (mirrors the generator's
  // _resolveAuthoredLabel). Several valid labels — "Diabetes type 2", "Lumbar /
  // back", "Cervical / neck", "Diabetic retinopathy", etc. — are NOT outputs of
  // their own regex, so a naive canonicalizeCondition() returns null for them and
  // a caller passing a canonical label (not raw chart text) would wrongly miss the
  // table row. isCanonicalLabel closes that gap. Raw chart free-text still falls
  // through to alias canonicalization.
  if (conditionCanon.isCanonicalLabel(str)) return str;
  return conditionCanon.canonicalizeCondition(str) || null;
}

// Index key uses (upstream, claimed) only — basis is NOT part of the lookup key
// because a caller asks "is this pairing eligible?" not "under which CFR prong?".
// When the table carries separate 3.310(a)/(b) rows for a pair, the STRONGER
// (more-permissive) eligibility wins so the caller is never wrongly blocked by a
// basis it did not ask about. Eligibility strength order below.
const _ELIGIBILITY_STRENGTH = { blessed: 5, conditional: 4, chain: 3, plausible: 2, excluded: 1 };

// Index a table DATA OBJECT into the cache (the pure step — NO fs). Shared by the
// Node fs-load and the inject path so the two can NEVER drift (the index logic
// lives in exactly one place).
function _indexRows(data) {
  const byKey = new Map();      // "up>cl" -> chosen row (strongest across bases)
  const byClaimed = new Map();  // claimed_canonical -> [rows]
  for (const row of (data.rows || [])) {
    const k = `${row.upstream_canonical}>${row.claimed_canonical}`;
    const prev = byKey.get(k);
    if (!prev || (_ELIGIBILITY_STRENGTH[row.eligibility] || 0) > (_ELIGIBILITY_STRENGTH[prev.eligibility] || 0)) {
      byKey.set(k, row);
    }
    if (!byClaimed.has(row.claimed_canonical)) byClaimed.set(row.claimed_canonical, []);
    byClaimed.get(row.claimed_canonical).push(row);
  }
  _cache = {
    version: data.version || null,
    content_hash: data.content_hash || null,
    row_count: typeof data.row_count === 'number' ? data.row_count : (data.rows || []).length,
    byKey,
    byClaimed,
    preference_rank: data.preference_rank || {},
  };
  return _cache;
}

function _loadArtifact() {
  const raw = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  return _indexRows(JSON.parse(raw));
}

// Inject a pre-loaded table object directly, bypassing fs — for the Cloudflare
// Worker vendor (no filesystem) and for tests. The SAME band/resolver logic then
// runs against the injected table, so the Worker output is byte-identical to the
// Node fs-loaded output for the same table (the 3-copy parity guarantee).
function setArtifact(data) { return _indexRows(data); }

function _artifact() {
  if (!_cache) _loadArtifact();
  return _cache;
}

// Test/hot-reload hook — drop the cache so a regenerated artifact is re-read.
function _clearCache() { _cache = null; }

// ── public: resolveAnchorEligibility ─────────────────────────────────────────
//
// Returns:
//   {
//     upstream_canonical, claimed_canonical,
//     eligibility: blessed|conditional|chain|plausible|excluded,
//     in_table: boolean,                 // false => plausible default
//     requires: string|null,             // chart fact gate for conditional/chain
//     mechanism_class: string|null,
//     mechanism_unconfirmed: boolean,    // true for plausible default
//     physician_review_anchor: boolean,  // true for plausible default + chain
//     routing_overlap: string[],
//     citation: string|null,
//     physician_reviewed: boolean,
//     note: string,
//     table_version: string|null,
//     source: 'table'|'plausible_default'
//   }
function resolveAnchorEligibility(upstreamText, claimedText) {
  const art = _artifact();
  const upC = _canon(upstreamText);
  const clC = _canon(claimedText);

  // Can't canonicalize one side -> plausible default (eligible, unconfirmed).
  if (!upC || !clC) {
    return _plausibleDefault(upC || (upstreamText || null), clC || (claimedText || null), art,
      'one or both conditions did not canonicalize against the FRN condition map');
  }

  let row = art.byKey.get(`${upC}>${clC}`);

  // §b1 INHERIT-FROM (2026-06-11): no OWN row for this (upstream,claimed) pair, but
  // the upstream shares a mechanism with a donor upstream (PTSD) that DOES carry
  // table rows. Derive the eligibility from the donor's row demoted one tier, with
  // the inherited_from provenance — WITHOUT aliasing the label (so PTSD-specific
  // studies are never mis-cited on the non-PTSD dx).
  if (!row) {
    const inh = _INHERIT_FROM[upC];
    if (inh) {
      const donorRow = art.byKey.get(`${inh.from}>${clC}`);
      if (donorRow) {
        const donorM = typeof donorRow.m_static === 'number' ? donorRow.m_static : null;
        const derivedTier = _demoteTier(donorRow.eligibility, inh.tierShift);
        const derivedM = donorM != null ? Math.max(1, donorM + inh.mShift) : null;
        // Propagate the donor pair's aggravation-only status (2026-06-11, Aegis-window
        // catch): PTSD→HTN is _AGGRAVATION_ONLY because the VA reliably denies psych→HTN
        // DIRECT causation — that applies to ANY psych dx, so the inherited (non-PTSD-trauma)
        // pair must inherit 3.310(b) aggravation framing too, not the donor row's raw 3.310(a).
        // The main-path _AGGRAVATION_ONLY override is skipped by this early return, so apply it here.
        const donorAgg = isAggravationOnly(clC, inh.from);
        return {
          upstream_canonical: upC,
          claimed_canonical: clC,
          eligibility: derivedTier,
          in_table: false,
          M_static: derivedM,
          E: typeof donorRow.e === 'number' ? donorRow.e : null,
          tier: derivedTier,
          basis: donorAgg ? '3.310b' : (donorRow.basis != null ? donorRow.basis : null),
          aggravation_only: donorAgg || undefined,
          causation_denied: donorAgg || undefined,
          requires: inh.requires,
          mechanism_class: donorRow.mechanism_class != null ? donorRow.mechanism_class : null,
          // Derived rows are never "blessed-confirmed" — always defer to physician.
          mechanism_unconfirmed: derivedTier === 'plausible',
          physician_review_anchor: true,
          routing_overlap: Array.isArray(donorRow.routing_overlap) ? donorRow.routing_overlap : [],
          // Do NOT carry the donor's PMID citation onto the non-PTSD dx (would
          // mis-cite a PTSD-specific study). The drafter must source its own.
          citation: null,
          physician_reviewed: false,
          inherited_from: inh.from,
          note: `Derived (inherited) from ${inh.from} via shared ${inh.provenance.replace(/_/g, ' ')}; demoted one tier (${donorRow.eligibility}→${derivedTier}). Do NOT cite ${inh.from}-specific studies — source mechanism literature for the non-${inh.from} dx. Physician confirms the shared mechanism.`,
          table_version: art.version,
          source: 'inherited',
        };
      }
    }
    return _plausibleDefault(upC, clC, art,
      'pair absent from anchor_mechanism_pairs.json — plausible default (long tail always drafts; physician confirms; promote to a permanent row once validated)');
  }

  const isChain = row.eligibility === 'chain';
  const isConditional = row.eligibility === 'conditional';
  // §3.3 causation-denied override: re-characterize a high-denial pair to
  // 3.310(b) aggravation-only (basis the table can't carry — PTSD→HTN has only a
  // 3.310a row). Applied HERE so every consumer that resolves eligibility
  // (assessClaimViability, framingGate.rankAnchorCandidates/drafter) sees the
  // aggravation framing consistently.
  const aggOnly = Object.prototype.hasOwnProperty.call(_AGGRAVATION_ONLY, `${clC}|${upC}`);
  return {
    upstream_canonical: upC,
    claimed_canonical: clC,
    eligibility: row.eligibility,
    in_table: true,
    // ── rubric fields surfaced for assessClaimViability (additive; existing
    //    callers ignore them) ──
    M_static: typeof row.m_static === 'number' ? row.m_static : null,
    E: typeof row.e === 'number' ? row.e : null,
    tier: row.tier != null ? row.tier : row.eligibility,
    basis: aggOnly ? '3.310b' : (row.basis != null ? row.basis : null),
    aggravation_only: aggOnly || undefined,
    causation_denied: aggOnly || undefined,
    requires: row.requires != null ? row.requires : null,
    mechanism_class: row.mechanism_class != null ? row.mechanism_class : null,
    // Only `plausible` rows are mechanism_unconfirmed; blessed/conditional/chain
    // have a curated/template basis. excluded is a hard no (also not "unconfirmed").
    mechanism_unconfirmed: row.eligibility === 'plausible',
    // Chain + conditional defer to a chart fact -> flag for physician confirmation
    // of the bridging fact. plausible also flags. blessed does not.
    physician_review_anchor: row.eligibility === 'plausible' || isChain || isConditional,
    routing_overlap: Array.isArray(row.routing_overlap) ? row.routing_overlap : [],
    citation: row.citation != null ? row.citation : null,
    physician_reviewed: row.physician_reviewed === true,
    note: row.note || '',
    table_version: art.version,
    source: 'table',
  };
}

function _plausibleDefault(upC, clC, art, reason) {
  return {
    upstream_canonical: upC,
    claimed_canonical: clC,
    eligibility: 'plausible',
    in_table: false,
    M_static: 2,            // rubric §1.2 plausible floor (provisional)
    E: null,
    tier: 'plausible',
    basis: null,
    requires: null,
    mechanism_class: null,
    mechanism_unconfirmed: true,
    physician_review_anchor: true,
    routing_overlap: [],
    citation: null,
    physician_reviewed: false,
    note: reason,
    table_version: art.version,
    source: 'plausible_default',
  };
}

// ── public: preferenceRankFor(claimedText) ───────────────────────────────────
// Returns the curated upstream preference order (canonical labels) for a claimed
// condition, or [] when the claimed condition is unranked (runtime ladder applies).
function preferenceRankFor(claimedText) {
  const art = _artifact();
  const clC = _canon(claimedText);
  if (!clC) return [];
  const entry = art.preference_rank[clC];
  if (!entry || !Array.isArray(entry.order)) return [];
  return entry.order.slice();
}

// ── public: eligibleUpstreamsFor(claimedText) ────────────────────────────────
// All non-excluded upstream canonical labels the table carries for a claimed
// condition (table rows only; does NOT add plausible-default long-tail). Useful
// for the RN-facing "rejected anchors" display in M3+.
function eligibleUpstreamsFor(claimedText) {
  const art = _artifact();
  const clC = _canon(claimedText);
  if (!clC) return [];
  const rows = art.byClaimed.get(clC) || [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.eligibility === 'excluded') continue;
    if (seen.has(r.upstream_canonical)) continue;
    seen.add(r.upstream_canonical);
    out.push({ upstream_canonical: r.upstream_canonical, eligibility: r.eligibility });
  }
  return out;
}

function tableVersion() { return _artifact().version; }
function tableContentHash() { return _artifact().content_hash; }

// ═══════════════════════════════════════════════════════════════════════════
// assessClaimViability — the VIABILITY band computation (caseViability v1)
// per docs/ANCHOR_VIABILITY_INTEGRATION_DESIGN_2026-06-10.md §1.
//
// PURE · PHI-FREE · DETERMINISTIC · NO LLM. The single home of band logic;
// the drafter, the EMR producer, Ask Aegis, and the public tool all call THIS
// (directly in-repo or via a byte-vendored copy). No surface re-implements it.
//
//   assessClaimViability(claimedText, grantedScConditions[], chartFactsPresent?)
//     → caseViability v1 object (see design §1.1).
// ═══════════════════════════════════════════════════════════════════════════

// 4.130 General-Formula psych conditions that COLLAPSE to ONE anchor (§5.1).
// The collapsed entity inherits the STRONGEST applicable member's M (never min/
// mean) — so PTSD→OSA M4 is not lost when MDD co-exists.
// 2026-06-11: 'Bipolar disorder' and 'Adjustment disorder' were DEAD members —
// neither is a conditionCanon canonical label (isCanonicalLabel===false), so they
// could never match a resolved upstream and silently did nothing. 'Adjustment
// disorder' is now an ALIAS of the new canonical 'Trauma/stressor disorder
// (non-PTSD)', so that label replaces it (and lets a vet with both PTSD and the
// non-PTSD trauma dx collapse to the stronger member, PTSD). 'Bipolar disorder'
// has NO canonical label in conditionCanon, so it is removed rather than left dead
// (every _PSYCH_4130 member must be a real canonical label).
const _PSYCH_4130 = new Set([
  'PTSD', 'MDD / Depression', 'Anxiety / GAD', 'Trauma/stressor disorder (non-PTSD)',
]);

// §3.0 presumptive pre-emption — keyed on the DOWNSTREAM claimed condition.
// service_flag = the chartFactsPresent.service_profile key that turns the
// ADVISORY (info-light) into a HARD redirect (chart-refined, profile known).
// SEED set — the full presumptive map (PACT/AO/Camp Lejeune/radiation cancers)
// migrates to a table `presumptive_path` field in v2.2.
const _PRESUMPTIVE = {
  'IBS': { path: 'GW_3317', service_flag: 'gulf_war_theater', note: 'Gulf War chronic multi-symptom illness presumptive (38 CFR 3.317). File presumptive; secondary held as fallback.' },
  'Fibromyalgia': { path: 'GW_3317', service_flag: 'gulf_war_theater', note: 'Gulf War presumptive (38 CFR 3.317). File presumptive; secondary held as fallback.' },
  'Chronic fatigue syndrome': { path: 'GW_3317', service_flag: 'gulf_war_theater', note: 'Gulf War presumptive (38 CFR 3.317). File presumptive; secondary held as fallback.' },
};

// §3.2 graveyard / redirect — claimed|upstream pairings where the anchor is
// DEAD: the secondary is held as fallback only and the case parks (abstain)
// when no better-granting redirect target is service-connected.
//
// EMPTIED 2026-06-11 (Ryan ratified "OSA-first WITH the PTSD-only guard").
// 'Hypertension|PTSD' was previously here and was WRONG: it made PTSD→HTN a dead
// anchor, so a veteran with HTN + service-connected PTSD but NO OSA got abstain
// (auto-kill) — the exact failure the PCP panel warned against. "OSA-first" is
// the right intent but it is a RANKING preference (OSA leads PTSD when both are
// SC), NOT a graveyard: PTSD→HTN stays a VIABLE second-line anchor on its own.
// That is now expressed via preference_rank (OSA-first) + the conditional
// PTSD→HTN row staying eligible (the guard). The graveyard MECHANISM is kept for
// genuinely dead anchors; the map is just empty today.
const _GRAVEYARD = {};

// §3.3 causation-denied / aggravation-only — claimed|upstream pairings where the
// VA reliably DENIES the direct CAUSATION theory, but the AGGRAVATION theory
// (38 CFR 3.310(b)) remains defensible. Ryan 2026-06-11: "if denial is high,
// don't offer it as connection, keep only as aggravating factor as a secondary
// argument." This RE-CHARACTERIZES the pair — basis → 3.310(b), flagged
// aggravation_only + causation_denied, demoted below causation-capable anchors
// in the ranker (a causation theory leads when one is service-connected) — but
// the pair stays VIABLE (distinct from a graveyard, which was dead). The §VII
// opinion for such a pair is "aggravated by", NOT "caused by", and drops the
// 3.310(a) causation prong. SEED set; rater-curated; migrates to a table
// `causation_denied` field in v2.2. Key = "claimed|upstream".
const _AGGRAVATION_ONLY = {
  'Hypertension|PTSD': { rationale: 'The VA reliably denies hypertension as directly CAUSED by PTSD. Argue 3.310(b) aggravation of pre-existing/essential hypertension as a secondary theory; lead with a causation anchor (e.g. OSA) when one is service-connected.' },
  // Ryan 2026-06-11: PTSD aggravates/triggers but does not CAUSE these de novo
  // (asthma = airway hyperreactivity, usually atopic/early-onset; psoriasis =
  // immune-mediated/genetic). Stress is a well-documented FLARE/aggravator for
  // both, so 3.310(b) aggravation is the defensible theory and direct causation
  // invites denial. (These two carry both basis rows in the table; this drops
  // the causation prong intentionally rather than by row-order accident.)
  'Asthma|PTSD': { rationale: 'PTSD/chronic stress aggravates and triggers asthma (sympathetic/HPA-driven bronchial hyperreactivity, worse control) but does not cause it de novo. Argue 3.310(b) aggravation; direct causation invites denial.' },
  'Psoriasis|PTSD': { rationale: 'PTSD/chronic stress is a recognized psoriasis flare trigger and aggravator, but psoriasis is immune-mediated/genetic and not caused de novo by PTSD. Argue 3.310(b) aggravation; direct causation invites denial.' },
};
function isAggravationOnly(claimedText, upstreamText) {
  const clC = _canon(claimedText);
  const upC = _canon(upstreamText);
  if (!clC || !upC) return false;
  return Object.prototype.hasOwnProperty.call(_AGGRAVATION_ONLY, `${clC}|${upC}`);
}

// §b1 INHERIT-FROM transform (2026-06-11) — a derived-eligibility mechanism, NOT a
// table change and NOT a canonical alias. Some upstream conditions share a
// mechanism with a stronger, table-rich upstream (PTSD) but must NOT be aliased to
// it: aliasing would mis-cite PTSD-SPECIFIC studies on a non-PTSD dx. Instead, when
// the upstream is an _INHERIT_FROM key AND the (upstream,claimed) pair has NO own
// row, we look up the `from` (PTSD) row for that claimed condition and return a
// DERIVED eligibility = PTSD's row demoted one tier (via _ELIGIBILITY_STRENGTH) with
// m_static reduced by `mShift` (floored at 1), a forced physician_review_anchor, and
// an `inherited_from` provenance marker. If PTSD itself has no row for the claimed
// condition, we fall through to the existing plausible default (never invent).
//
//   key = canonical upstream label
//   from      = the donor upstream whose row is demoted (a canonical label)
//   tierShift = tiers to demote (negative; -1 = one step weaker)
//   mShift    = m_static delta (negative; -1)
//   requires  = the chart-fact gate to attach to the derived row
//   provenance= the provenance tag
const _INHERIT_FROM = {
  'Trauma/stressor disorder (non-PTSD)': {
    from: 'PTSD',
    tierShift: -1,
    mShift: -1,
    requires: 'shared stress-response mechanism (hyperarousal / HPA-axis / sleep fragmentation); physician confirms',
    provenance: 'inherited_from_PTSD',
  },
};

// Order of the eligibility tiers for the inherit demotion (strongest → weakest).
// Demote by `tierShift` steps; clamp at the ends.
const _TIER_ORDER = ['blessed', 'conditional', 'chain', 'plausible', 'excluded'];
function _demoteTier(tier, shift) {
  const i = _TIER_ORDER.indexOf(tier);
  if (i < 0) return tier;
  const j = Math.min(_TIER_ORDER.length - 1, Math.max(0, i - shift)); // shift is negative ⇒ i+1
  return _TIER_ORDER[j];
}

// Umbrella claimed labels that REQUIRE phenotype resolution before ranking
// (§3.5) — ranking the umbrella averages distinct phenotypes to a wrong M.
const _UMBRELLA_RE = /\b(sleep[\s-]?wake disorder|sleep disorder(?:\s+nos)?|unspecified headache|headache disorder|arthritis nos|anemia nos|voiding dysfunction)\b/i;

// CI guard (§6 risk 1): wiring to a <500-row stub silently produces weak/
// plausible for everything. assessClaimViability refuses on a stub table.
const _MIN_TABLE_ROWS = 500;

function _band(tier, mEff, isGranted, mode, factConfirmed) {
  if (!isGranted) return 'weak';
  if (tier === 'excluded') return 'weak';
  if (tier === 'plausible') return 'weak';            // long-tail default
  if (tier === 'conditional' || tier === 'chain') {
    // Conservatism (§1.4): info-light NEVER returns strong for a contingent tier.
    if (mode === 'info_light') return 'conditional';
    if (!factConfirmed) return 'conditional';         // chart-refined, fact absent → floored
    return mEff >= 4 ? 'strong' : (mEff === 3 ? 'moderate' : 'conditional');
  }
  // blessed
  if (mEff >= 4) return 'strong';
  if (mEff === 3) return 'moderate';
  return 'weak';
}

function _excludedTrapsFor(art, clC) {
  const rows = art.byClaimed.get(clC) || [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.eligibility !== 'excluded') continue;
    if (seen.has(r.upstream_canonical)) continue;
    seen.add(r.upstream_canonical);
    out.push({
      upstream_canonical: r.upstream_canonical,
      reason: (r.note && r.note.length) ? r.note.split('.')[0] : 'no credible mechanism; excluded',
    });
  }
  return out;
}

function _whyLine(band, best, claimedC, presumptive, graveyard) {
  if (graveyard) return `Redirect: the VA reliably denies this anchoring; argue ${graveyard.redirect_to} instead. ${graveyard.rationale}`;
  if (presumptive && presumptive.hard) return `Redirect: a presumptive path may apply (${presumptive.note}).`;
  if (!best) return `No service-connected condition currently anchors ${claimedC}. Consider whether another condition is service-connected, or a presumptive path applies.`;
  const up = best.upstream_canonical;
  // §3.3 aggravation-only: the VA reliably denies direct causation, so frame as
  // aggravation (3.310(b)) — a secondary argument, never "caused by".
  if (best.aggravation_only) {
    return `Aggravation only: argue that service-connected ${up} AGGRAVATED ${claimedC} under 38 CFR 3.310(b) (a secondary argument); do NOT argue direct causation — the VA reliably denies it. Lead with a causation anchor if one is service-connected.`;
  }
  switch (band) {
    case 'strong': return `Strong: service-connected ${up} is a dominant recognized cause of ${claimedC}.`;
    case 'moderate': return `Moderate: service-connected ${up} is a recognized cause of ${claimedC}; a solid path${best.requires ? ', stronger once the supporting record is confirmed' : ''}.`;
    case 'conditional': return `Conditional: ${up} can anchor ${claimedC}, but the connection depends on a record we still need to confirm.`;
    case 'weak': return `Weak: no strong service-connected anchor for ${claimedC} yet.`;
    default: return `${claimedC}: needs a closer look at the records.`;
  }
}

function _viabilityShell(claimedC, mode, art) {
  return {
    version: 1,
    claimed_canonical: claimedC,
    viability: 'abstain',
    best_anchor: null,
    alternatives: [],
    why: '',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: claimedC ? _excludedTrapsFor(art, claimedC) : [],
    confidence: 'low',
    mode,
    table_version: art ? art.version : null,
    table_content_hash: art ? art.content_hash : null,
  };
}

function assessClaimViability(claimedText, grantedScConditions, chartFactsPresent) {
  const mode = chartFactsPresent ? 'chart_refined' : 'info_light';
  const granted = Array.isArray(grantedScConditions) ? grantedScConditions.filter(Boolean) : [];

  // Fail-open: table unreadable/absent → abstain, never crash (§5.3).
  let art;
  try { art = _artifact(); }
  catch (e) {
    const shell = _viabilityShell(null, mode, null);
    shell.why = 'Viability data is unavailable; needs a closer look at the records.';
    return shell;
  }

  // CI guard (§6 risk 1): refuse on a stub table.
  if (!art.row_count || art.row_count < _MIN_TABLE_ROWS) {
    const shell = _viabilityShell(null, mode, art);
    shell.why = 'Viability data is not yet complete enough to answer; needs a closer look at the records.';
    return shell;
  }

  // §3.5 umbrella phenotype split — abstain for the specific dx.
  if (claimedText && _UMBRELLA_RE.test(String(claimedText))) {
    const shell = _viabilityShell(null, mode, art);
    shell.missing_fact = 'a specific diagnosis (the umbrella term covers distinct conditions that anchor differently)';
    shell.why = 'We need the specific diagnosis before we can assess the connection.';
    return shell;
  }

  const clC = _canon(claimedText);
  if (!clC) {
    const shell = _viabilityShell(null, mode, art);
    shell.missing_fact = 'a recognized diagnosis for the claimed condition';
    shell.why = 'We need a closer look at the records to identify the claimed condition.';
    return shell;
  }

  const shell = _viabilityShell(clC, mode, art);

  // §3.0 presumptive pre-emption (keyed on claimed). info-light = advisory;
  // chart-refined with a known matching service profile = HARD redirect.
  const presRule = _PRESUMPTIVE[clC];
  let presumptiveHard = false;
  if (presRule) {
    const profile = (chartFactsPresent && chartFactsPresent.service_profile) || null;
    presumptiveHard = !!(profile && profile[presRule.service_flag] === true);
    shell.presumptive_redirect = { path: presRule.path, note: presRule.note, advisory: !presumptiveHard };
    if (presumptiveHard) {
      shell.viability = 'redirect';
      shell.confidence = 'high';
      shell.why = _whyLine('redirect', null, clC, { hard: true, note: presRule.note }, null);
      return shell;   // hard pre-empt: secondary held as fallback, not ranked
    }
  }

  // Resolve every granted SC as a candidate upstream for this claimed condition.
  const resolved = [];
  for (const g of granted) {
    const r = resolveAnchorEligibility(g, clC);
    if (r.eligibility === 'excluded') continue;        // M0 never ranks
    const mStatic = typeof r.M_static === 'number' ? r.M_static : (r.eligibility === 'plausible' ? 2 : 0);
    // M_eff: info-light = ceiling; chart-refined = floored when a required fact is absent.
    let factConfirmed = true;
    let mEff = mStatic;
    if (r.requires && (r.eligibility === 'conditional' || r.eligibility === 'chain')) {
      if (mode === 'chart_refined') {
        const facts = (chartFactsPresent && Array.isArray(chartFactsPresent.documented_facts)) ? chartFactsPresent.documented_facts : [];
        factConfirmed = _requiredFactPresent(r.requires, r.mechanism_class, facts);
        if (!factConfirmed) mEff = Math.min(mStatic, 1);
      } else {
        factConfirmed = false;   // info-light: unconfirmed (drives the conditional band)
      }
    }
    resolved.push({
      upstream_canonical: r.upstream_canonical,
      upstream_verbatim: String(g),
      M_static: mStatic,
      M_eff: mEff,
      E: typeof r.E === 'number' ? r.E : null,   // null = not-yet-scored (NOT 0/"no evidence")
      tier: r.tier || r.eligibility,
      basis: r.basis || null,
      is_granted_sc: true,
      mechanism_class: r.mechanism_class || null,
      requires: r.requires || null,
      factConfirmed,
      in_table: r.in_table,
      physician_reviewed: r.physician_reviewed === true,
      aggravation_only: r.aggravation_only === true,
      inherited_from: r.inherited_from || null,
    });
  }

  // §5.1 collapse co-class 4.130 psych anchors to the STRONGEST applicable member.
  // Tiebreak mirrors the main ranker incl. causation-first (so a causation-capable
  // psych member is kept over an equal-M aggravation-only one — architect QA 2026-06-11).
  const psych = resolved.filter(a => _PSYCH_4130.has(a.upstream_canonical));
  if (psych.length > 1) {
    psych.sort((a, b) => (b.M_eff - a.M_eff) || ((b.E || 0) - (a.E || 0)) || ((a.aggravation_only ? 1 : 0) - (b.aggravation_only ? 1 : 0)) || a.upstream_canonical.localeCompare(b.upstream_canonical));
    const keep = psych[0];
    keep.mechanism_member = keep.upstream_canonical;   // bind drafter prose to this member
    const drop = new Set(psych.slice(1).map(a => a.upstream_canonical));
    for (let i = resolved.length - 1; i >= 0; i--) {
      if (drop.has(resolved[i].upstream_canonical)) resolved.splice(i, 1);
    }
  }

  if (!resolved.length) {
    shell.viability = 'weak';
    shell.confidence = 'low';
    shell.why = _whyLine('weak', null, clC, null, null);
    return shell;
  }

  // Rank: M_eff desc, then E desc, then tier-strength desc, then the curated
  // preference_rank order (panel-ratified anchor ordering for this claimed
  // condition — e.g. OSA-first for Hypertension), then alpha (total order).
  // preference_rank is a TIEBREAK among equally-strong anchors, never an
  // override of M_eff/E/tier: a higher-M anchor still wins on merit. An anchor
  // absent from the list sorts after every ranked one (index = Infinity).
  const _prefOrder = preferenceRankFor(clC);
  const _prefIdx = (u) => { const i = _prefOrder.indexOf(u); return i < 0 ? Infinity : i; };
  resolved.sort((a, b) =>
    (b.M_eff - a.M_eff)
    || ((b.E || 0) - (a.E || 0))
    || ((_ELIGIBILITY_STRENGTH[b.tier] || 0) - (_ELIGIBILITY_STRENGTH[a.tier] || 0))
    // §3.3 causation-first: an aggravation-only anchor is a SECONDARY argument —
    // at equal merit a causation-capable anchor leads it (TIEBREAK, not an
    // override; a higher-M aggravation-only pair still wins on M above).
    || ((a.aggravation_only ? 1 : 0) - (b.aggravation_only ? 1 : 0))
    || (_prefIdx(a.upstream_canonical) - _prefIdx(b.upstream_canonical))
    || a.upstream_canonical.localeCompare(b.upstream_canonical));

  const best = resolved[0];

  // §3.2 graveyard / redirect on the chosen anchor.
  const gKey = `${clC}|${best.upstream_canonical}`;
  if (_GRAVEYARD[gKey]) {
    const gv = _GRAVEYARD[gKey];
    const targetGranted = granted.some(g => _canon(g) === gv.redirect_to);
    shell.graveyard_redirect = { dead_anchor: best.upstream_canonical, redirect_to: gv.redirect_to, rationale: gv.rationale, redirect_blocked: !targetGranted };
    shell.confidence = 'high';
    if (targetGranted) {
      // re-rank against the redirect target as the surviving anchor
      const rt = resolved.find(a => a.upstream_canonical === gv.redirect_to);
      if (rt) { shell.viability = 'redirect'; shell.best_anchor = _publicAnchor(rt); shell.why = _whyLine('redirect', rt, clC, null, gv); return shell; }
    }
    shell.viability = 'abstain';   // dead anchor + no granted redirect target → park for RN
    shell.why = _whyLine('redirect', null, clC, null, gv);
    return shell;
  }

  const band = _band(best.tier, best.M_eff, best.is_granted_sc, mode, best.factConfirmed);
  shell.viability = band;
  shell.best_anchor = _publicAnchor(best);
  if (best.mechanism_member) shell.best_anchor.mechanism_member = best.mechanism_member;
  shell.alternatives = resolved.slice(1).map(a => ({
    upstream_canonical: a.upstream_canonical, M_eff: a.M_eff, tier: a.tier, is_granted_sc: a.is_granted_sc,
    aggravation_only: a.aggravation_only === true ? true : undefined,
  }));
  // missing_fact: the pair-keyed record that would RAISE the band.
  if ((band === 'conditional') && best.requires) shell.missing_fact = best.requires;
  // confidence: low on an assumed/unreviewed/plausible anchor or info-light contingency.
  shell.confidence = (best.physician_reviewed && best.tier === 'blessed' && (mode === 'chart_refined' || band === 'strong' || band === 'moderate'))
    ? 'high'
    : ((band === 'strong' && mode === 'info_light' && best.tier === 'blessed') ? 'high' : 'low');
  shell.why = _whyLine(band, best, clC, shell.presumptive_redirect, null);
  return shell;
}

function _publicAnchor(a) {
  return {
    upstream_canonical: a.upstream_canonical,
    upstream_verbatim: a.upstream_verbatim,
    M_static: a.M_static,
    M_eff: a.M_eff,
    E: a.E,
    tier: a.tier,
    basis: a.basis,
    aggravation_only: a.aggravation_only === true ? true : undefined,
    causation_denied: a.aggravation_only === true ? true : undefined,
    is_granted_sc: a.is_granted_sc,
    mechanism_class: a.mechanism_class,
    requires: a.requires,
    inherited_from: a.inherited_from || undefined,
  };
}

// Best-effort check that a row's required fact is present in the normalized
// chart fact tags. Conservative: a required fact with no recognizable tag match
// is treated as ABSENT (floors M_eff) so we never over-promise on a missing
// record. Tag vocabulary grows as chartFactsPresent normalization matures.
function _requiredFactPresent(requiresText, mechanismClass, documentedFacts) {
  if (!requiresText) return true;
  const facts = (documentedFacts || []).map(s => String(s).toLowerCase());
  const req = String(requiresText).toLowerCase();
  // Pair-keyed fact tags. A required fact is PRESENT only when the chart carries
  // the exact normalized tag (or a fact tag the SPECIFIC pattern matches) — the
  // patterns are matched against the FACT TAGS, never against arbitrary chart
  // prose. (The prior version tested a broad /document|confirm/ against free
  // notes, so any note containing "document" over-promised a conditional pair to
  // strong — BLOCKER-1.) Tags grow as chartFactsPresent normalization matures.
  const TAG_HINTS = [
    ['gait', /\bgait\b|varus|antalgic|thrust/],
    ['ahi', /\bahi\b|sleep study|polysomn/],
    ['bmi_trajectory', /\bbmi\b|weight trajector|obes/],
    ['spine_level', /spine[_ ]?level|dermatom|concordan/],
    ['atopic_phenotype', /atopic[_ ]?(?:phenotype|march)/],
    ['mst_stressor', /\bmst\b|personal[_ ]?assault|3\.304/],
    ['tbi_severity', /tbi[_ ]?severity|penetrat|moderate.severe/],
    ['h_pylori', /pylori/],
  ];
  for (const [tag, re] of TAG_HINTS) {
    if (re.test(req)) return facts.includes(tag) || facts.some(f => re.test(f));
  }
  // "documented diagnosis"-class requirement: confirmed ONLY by the EXACT
  // normalized tag, never by a substring of free chart prose (conservative).
  if (/\bdocument|\bconfirm/.test(req)) return facts.includes('documented_diagnosis');
  // Unknown required-fact shape ⇒ treat as ABSENT (conservative — never
  // over-promise on a record we can't positively recognize).
  return false;
}

// §3.2 companion for consumer-side suggestion surfaces (the website blank-state
// "common anchors" list, LLM grounding "sound" lists): the upstreams the graveyard
// map forbids as anchors for this claimed condition. preferenceRankFor /
// eligibleUpstreamsFor are structurally BLIND to the graveyard (it is a code seed,
// not a table eligibility value), so any surface that suggests anchors from those
// functions MUST subtract this set — otherwise it recommends a known-losing theory
// (architect QA C1, 2026-06-11: HTN blank-state suggested PTSD, the exact pairing
// _GRAVEYARD exists to suppress). Pure; no table read (graveyard is code-seeded).
function graveyardUpstreamsFor(claimedText) {
  const clC = _canon(claimedText);
  if (!clC) return [];
  const out = [];
  for (const k of Object.keys(_GRAVEYARD)) {
    const i = k.indexOf('|');
    if (i > 0 && k.slice(0, i) === clC) out.push(k.slice(i + 1));
  }
  return out;
}

// §3.3 — the AGGRAVATION-ONLY analog of graveyardUpstreamsFor. The public
// vet-facing tool must SUBTRACT these from its "common anchors / connection"
// suggestions: Ryan 2026-06-11 "if denial is high, don't OFFER it as a
// connection" — a causation-denied pair (PTSD→HTN) is an internal drafter
// aggravation argument, never a connection we suggest to a veteran. NOTE: with
// _GRAVEYARD now empty, graveyardUpstreamsFor returns [] — consumers that relied
// on it to suppress PTSD→HTN MUST switch to (or also subtract) this set. Pure.
function aggravationOnlyUpstreamsFor(claimedText) {
  const clC = _canon(claimedText);
  if (!clC) return [];
  const out = [];
  for (const k of Object.keys(_AGGRAVATION_ONLY)) {
    const i = k.indexOf('|');
    if (i > 0 && k.slice(0, i) === clC) out.push(k.slice(i + 1));
  }
  return out;
}

module.exports = {
  resolveAnchorEligibility,
  assessClaimViability,
  preferenceRankFor,
  eligibleUpstreamsFor,
  isAggravationOnly,
  aggravationOnlyUpstreamsFor,
  graveyardUpstreamsFor,
  tableVersion,
  tableContentHash,
  setArtifact,        // inject a table object (Worker vendor / tests) — bypasses fs
  _clearCache,
  _canon,
  _UMBRELLA_RE,       // umbrella/phenotype-unresolved claim labels (read by pipelineLinter.lintClaimedConditionSpecific)
};
