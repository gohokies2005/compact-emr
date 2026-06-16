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
const ARTIFACT_PATH = path.join(__dirname, 'anchor_mechanism_pairs.json'); // VENDORED REWRITE 1/3 (scripts/vendor-anchor-table.mjs): table sits beside the resolver

// Canonicalize via the PURE conditionCanon module (NOT framingGate) so this
// module's require-graph stays free of better-sqlite3 / llm-client / the DB —
// the Ask-Aegis Lambda vendors anchorMechanism + conditionCanon + the table
// only. conditionCanon re-exports the SAME canonicalizeCondition / isCanonicalLabel
// the generator used, so table keys still line up. (Task f keystone, 2026-06-10.)
const conditionCanon = require('./conditionCanon.cjs'); // VENDORED REWRITE 2/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend

// ── DIRECT-SC axis fold (gated; dark by default) ─────────────────────────────
// When DIRECT_SC_AXIS_ENABLED==='true', assessClaimViability ALSO folds the direct
// axis (directSc, keyed on eventCanon in-service events passed via
// chartFactsPresent.in_service_events) into the SAME ranked list, and emits the
// caseViability v2 shape (axis + two-table provenance + best_anchor.anchor_axis).
// When unset/false, the function is byte-identical to the v1 secondary-only engine
// — zero direct require, zero v2 fields. Read at call-time so tests/flips toggle it.
// Enablement: Node (drafter/EMR Lambda) reads process.env; the Cloudflare Worker has NO process.env,
// so it calls setDirectAxisEnabled(env.<flag>==='true') per request — the override wins when set.
// process access is guarded so the vendored worker copy never ReferenceErrors on `process`.
let _directAxisOverride = null;
function setDirectAxisEnabled(on) { _directAxisOverride = (on === null || on === undefined) ? null : !!on; }
function _directAxisOn() {
  if (_directAxisOverride !== null) return _directAxisOverride;
  return (typeof process !== 'undefined' && process.env && process.env.DIRECT_SC_AXIS_ENABLED === 'true');
}
let _directSc = null;
function _direct() {
  if (_directSc) return _directSc;
  try { _directSc = require('./directSc.cjs'); } catch (_) { _directSc = null; } // VENDORED REWRITE 3/4 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend
  return _directSc;
}
function _directTableHash() { const d = _direct(); try { return d ? d.tableContentHash() : null; } catch (_) { return null; } }
// Humanize an eventCanon canonical token into a readable upstream label for prose/UI.
const _EVENT_LABELS = {
  mos_acoustic_noise: 'in-service hazardous noise exposure',
  blast_tbi: 'in-service blast / head injury',
  repetitive_msk_load: 'in-service repetitive musculoskeletal load',
  acute_in_service_injury: 'documented in-service injury',
  criterion_a_trauma: 'in-service traumatic stressor',
  mst: 'military sexual trauma',
  chronic_operational_stress: 'chronic in-service operational stress',
  chemical_solvent_fuel_tera: 'in-service chemical / solvent / fuel exposure',
  burn_pit_airborne: 'burn-pit / airborne-hazard exposure',
  herbicide_agent_orange: 'herbicide (Agent Orange) exposure',
  gulf_war_environmental: 'Gulf War environmental exposure',
  camp_lejeune_water: 'Camp Lejeune water exposure',
  ionizing_radiation: 'ionizing-radiation exposure',
  cold_injury: 'in-service cold injury',
  asbestos: 'in-service asbestos exposure',
  chronic_disease_1yr: 'chronic disease manifest within one year of separation',
};
function _eventLabel(evt) { return _EVENT_LABELS[evt] || String(evt || '').replace(/_/g, ' '); }

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
  // ── 2026-06-12: VA-VERIFIED presumptives (sourced from official va.gov pages, NOT memory).
  // Keyed on OUR canonical claimed labels. Info-light = ADVISORY flag only (does NOT change the band);
  // a HARD redirect fires only when the chart's service_profile confirms the matching exposure. ──
  // Agent Orange (herbicide) — va.gov/.../agent-orange
  'Diabetes type 2': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive (herbicide exposure). If herbicide-exposed, file the presumptive direct path first; secondary anchor work is the fallback.' },
  'Hypertension': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive (2022 expansion). If herbicide-exposed, file presumptive; secondary = fallback.' },
  'Ischemic heart disease': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive. If herbicide-exposed, file presumptive; secondary = fallback.' },
  'Hypothyroidism': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive. If herbicide-exposed, file presumptive; secondary = fallback.' },
  'Peripheral neuropathy': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive (early-onset). If herbicide-exposed, check presumptive; secondary = fallback.' },
  'Parkinson disease': { path: 'AGENT_ORANGE_OR_CAMP_LEJEUNE', service_flag: 'herbicide_or_lejeune', note: 'Presumptive under BOTH Agent Orange (herbicide) AND Camp Lejeune water. If either exposure applies, file presumptive direct; secondary = fallback.' },
  'Prostate cancer': { path: 'AGENT_ORANGE', service_flag: 'herbicide_exposure', note: 'Agent Orange presumptive (also PACT reproductive cancer). If exposed, file presumptive.' },
  'Lung cancer': { path: 'AGENT_ORANGE_OR_PACT', service_flag: 'herbicide_or_burnpit', note: 'Presumptive under Agent Orange (respiratory cancer) AND PACT burn pits. If exposed, file presumptive.' },
  'Lymphoma': { path: 'MULTIPLE', service_flag: 'toxic_exposure', note: 'Presumptive under Agent Orange (NHL/Hodgkin), Camp Lejeune (NHL), and PACT burn pits (lymphoma, any type). If any exposure, file presumptive.' },
  // Camp Lejeune water (1953-1987) — va.gov/.../camp-lejeune-water-contamination
  'Bladder cancer': { path: 'AGENT_ORANGE_OR_CAMP_LEJEUNE', service_flag: 'herbicide_or_lejeune', note: 'Presumptive under Agent Orange AND Camp Lejeune. If exposed, file presumptive.' },
  'Kidney cancer': { path: 'CAMP_LEJEUNE_OR_PACT', service_flag: 'lejeune_or_burnpit', note: 'Presumptive under Camp Lejeune water AND PACT burn pits. If exposed, file presumptive.' },
  'Hepatocellular carcinoma': { path: 'CAMP_LEJEUNE', service_flag: 'camp_lejeune_water', note: 'Camp Lejeune presumptive (liver cancer). If stationed Camp Lejeune Aug 1953-Dec 1987, file presumptive.' },
  'Myelodysplastic syndrome': { path: 'CAMP_LEJEUNE', service_flag: 'camp_lejeune_water', note: 'Camp Lejeune presumptive (aplastic anemia / MDS). If Camp Lejeune exposure, file presumptive.' },
  // PACT Act burn pits / airborne hazards — va.gov PACT hub
  'Asthma': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act burn-pit presumptive (asthma diagnosed after service). If burn-pit/airborne-hazard exposed, file presumptive; secondary = fallback.' },
  'COPD': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act burn-pit presumptive (COPD / emphysema / chronic bronchitis). If exposed, file presumptive.' },
  'Chronic rhinosinusitis': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act presumptive (chronic sinusitis / rhinitis). If burn-pit exposed, file presumptive.' },
  'Interstitial lung disease': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act presumptive (ILD / pulmonary fibrosis). If exposed, file presumptive.' },
  'Sarcoidosis': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act burn-pit presumptive (also a known anchor). If burn-pit exposed, file presumptive.' },
  'Melanoma': { path: 'PACT_BURN_PIT', service_flag: 'burn_pit_exposure', note: 'PACT Act burn-pit presumptive (melanoma). If exposed, file presumptive.' },
  // Gulf War (38 CFR 3.317) — va.gov Gulf War page (IBS/Fibromyalgia/CFS above)
  'Tuberculosis': { path: 'GW_INFECTIOUS', service_flag: 'gulf_war_theater', note: 'Gulf War presumptive infectious disease (M. tuberculosis). If SW-Asia/Afghanistan service, file presumptive.' },
};

// §3.6 INTERMEDIATE-ONLY claimed conditions (Doximity QA 2026-06-12). Obesity is NOT a
// standalone directly-service-connectable disability (VAOPGCPREC 1-2017). It functions as an
// INTERMEDIATE step in a chain (SC condition -> obesity -> secondary), NEVER a standalone claim.
// Flagged advisory on the claimed side so a consumer never presents obesity-as-an-endpoint as a
// clean claim; obesity-as-an-ANCHOR (the intermediate link) is unaffected.
const _INTERMEDIATE_ONLY = {
  'Obesity': { note: 'Obesity is NOT a standalone service-connectable disability (VAOPGCPREC 1-2017). It is only an INTERMEDIATE step in a chain (service-connected condition -> obesity -> the actual claimed condition). Do not frame obesity itself as the claim; use it as the link.' },
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
  // Ryan 2026-06-12: PTSD associates with RLS via sleep disruption / CNS arousal,
  // but the mechanism is not strong enough for de novo causation — frame as
  // 3.310(b) aggravation, not direct cause.
  'Restless legs syndrome|PTSD': { rationale: 'PTSD-related sleep disruption / CNS arousal aggravates restless legs syndrome, but does not cause it de novo. Argue 3.310(b) aggravation; direct causation invites denial.' },
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

// ════════════════════════════════════════════════════════════════════════════
// SSOT RANKING + INTRINSIC-STRENGTH LABEL — the ONE brain every surface uses.
// Before 2026-06-12 the anchor comparator and the strength label were
// re-implemented in FOUR places that silently drifted: assessClaimViability's
// resolved.sort, the RN reference-manual generator (whose sort had DROPPED the
// E / aggravation-only / preference keys, and which read aggravation from
// `special_flag` while everyone else uses isAggravationOnly), and the quickref
// generator's hand-mirrored engineCmp. These exports are the single source;
// the parity test (anchor-surface-parity.test.js) fails CI if a surface diverges.
// ════════════════════════════════════════════════════════════════════════════

// The one M_eff normalization (info-light): numeric m_static as-is, else
// plausible→2, else 0. Matches the historical assessClaimViability line ~581 and
// both generators' mEff/mEffInfoLight.
function mEffInfoLight(mStatic, eligibility) {
  return typeof mStatic === 'number' ? mStatic : (eligibility === 'plausible' ? 2 : 0);
}

// The SINGLE anchor comparator, over a normalized shape
//   { M_eff, tier, aggravation_only, upstream_canonical }.
// prefOrder = preferenceRankFor(claimed) (panel-ratified tiebreak; [] if none).
// Order: M_eff desc → eligibility-strength desc → causation-first (aggravation-only
// sorts after) → preference_rank → alpha (total order). (The E axis was REMOVED
// 2026-06-12 — it was a dead biostat factor; M_eff + tier + preference_rank carry
// the ranking.)
function _anchorComparator(prefOrder) {
  const pref = Array.isArray(prefOrder) ? prefOrder : [];
  const prefIdx = (u) => { const i = pref.indexOf(u); return i < 0 ? Infinity : i; };
  return (a, b) =>
    (b.M_eff - a.M_eff)
    || ((_ELIGIBILITY_STRENGTH[b.tier] || 0) - (_ELIGIBILITY_STRENGTH[a.tier] || 0))
    // Axis tiebreak (direct-SC fold): at EQUAL (M_eff, eligibility-strength), a DIRECT
    // anchor (in-service event, 3.303 — no intermediate SC to defend) outranks a SECONDARY
    // one. No-op for secondary-only ranking (anchor_axis undefined on both → 0), so the RN
    // manual/quickref generators (secondary rows only) are unaffected — parity preserved.
    || ((a.anchor_axis === 'direct' ? 0 : 1) - (b.anchor_axis === 'direct' ? 0 : 1))
    || ((a.aggravation_only ? 1 : 0) - (b.aggravation_only ? 1 : 0))
    || (prefIdx(a.upstream_canonical) - prefIdx(b.upstream_canonical))
    || a.upstream_canonical.localeCompare(b.upstream_canonical);
}

// Normalize a RAW table row to the comparator shape (info-light, case-free).
// aggravation_only comes from isAggravationOnly() — the ONE canonical source —
// so the docs agree with the engine + each other (kills the special_flag drift).
function _rowToComparable(row) {
  return {
    M_eff: mEffInfoLight(row.m_static, row.eligibility),
    tier: row.eligibility,
    aggravation_only: isAggravationOnly(row.claimed_canonical, row.upstream_canonical),
    upstream_canonical: row.upstream_canonical,
    _row: row,
  };
}

// rankAnchorRowsForClaimed(claimed, rowsForClaimed) -> the raw rows for `claimed`,
// excluded removed, ordered by the ONE comparator. The RN manual + quickref call
// THIS instead of their own .sort(). `rowsForClaimed` = rows already filtered to
// this claimed condition (the generators group by claimed first).
function rankAnchorRowsForClaimed(claimed, rowsForClaimed) {
  const cmp = _anchorComparator(preferenceRankFor(claimed));
  return (rowsForClaimed || [])
    .filter((r) => r.eligibility !== 'excluded')
    .map(_rowToComparable).sort(cmp).map((c) => c._row);
}

// Intrinsic strength TOKEN + LABEL for one row (case-free; the reference-doc
// "how strong is this pair", NOT _band which is the case-contextual viability
// band given granted+confirmed). The RN manual's "Strong/Solid/Weaker/Indirect
// pathway" prose is sourced from HERE — one place decides it for every surface.
const _STRENGTH_LABEL = {
  strong: 'Strong — a dominant, well-recognized cause',
  solid: 'Solid — a well-established contributing cause',
  weaker: 'Weaker — a recognized but secondary pathway',
  chain: 'Indirect pathway (works through an intermediate condition)',
  limited: 'Limited',
};
function strengthLabelForRow(row) {
  const elig = row.eligibility || row.tier;
  const m = mEffInfoLight(row.m_static != null ? row.m_static : row.M_static, elig);
  let token;
  if (elig === 'chain') token = 'chain';
  else if (elig === 'blessed' || m === 4) token = 'strong';
  else if (m === 3) token = 'solid';
  else if (elig === 'plausible' || m === 2) token = 'weaker';
  else token = 'limited';
  return { token, label: _STRENGTH_LABEL[token], mEff: m };
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
  const v2 = _directAxisOn();
  const shell = {
    version: v2 ? 2 : 1,
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
  if (v2) {
    // v2: axis discriminator (defaults 'none'; set when a best anchor is chosen) + two-table
    // provenance. The flat table_content_hash above is RETAINED as the deprecated secondary mirror.
    shell.axis = 'none';
    shell.tables = {
      secondary: { version: art ? art.version : null, content_hash: art ? art.content_hash : null },
      direct: { version: null, content_hash: _directTableHash() },
    };
  }
  return shell;
}

// ── PRESUMPTIVE BRIDGE-ANCHOR pathway (gated; dark by default) ────────────────
// A TWO-HOP suggestion: exposure → a PRESUMPTIVE intermediate dx (PACT-presumptive,
// not-yet-SC) → the claimed condition argued SECONDARY to that intermediate. Motivating
// case: burn-pit/TERA → chronic sinusitis/rhinitis/asthma (38 CFR 3.320) → OSA secondary.
// The one-hop ranker above cannot see this (it anchors only on GRANTED SCs). This branch
// is ADDITIVE ONLY: it attaches an optional `bridge_pathways[]` sidecar and NEVER mutates
// viability/best_anchor/alternatives. Byte-identical when the flag is off or no bridge fires
// (the key is only ever ADDED). Mirrors the _directAxisOn flag discipline for the Worker.
//
// Gated on ALL of (the load-bearing guardrail):
//   G1 — a conceded EXPOSURE fact in chartFactsPresent.in_service_events (the same channel
//        the EMR already emits); each event's eventCanon canonical is the exposure key.
//   G2 — the intermediate dx is PRESENT in chartFactsPresent.dx_constellation AND is NOT
//        already a granted SC (a granted intermediate is a normal one-hop anchor).
//   G3 — the (intermediate → claimed) secondary pair is CURATED: resolveAnchorEligibility
//        returns in_table===true && eligibility not 'plausible'/'excluded'. This AUTO-encodes
//        the VA-rater ADD/SKIP (sinusitis/rhinitis/asthma→OSA in-table ⇒ fire; COPD/
//        bronchitis→OSA plausible-default ⇒ no bridge), with NO separate allowlist.
//   G4 — output is a provisional, physician_review_required SUGGESTION, never a band.
let _bridgeOverride = null;
function setBridgeEnabled(on) { _bridgeOverride = (on === null || on === undefined) ? null : !!on; }
function _bridgeOn() {
  if (_bridgeOverride !== null) return _bridgeOverride;
  return (typeof process !== 'undefined' && process.env && process.env.BRIDGE_ANCHOR_ENABLED === 'true');
}
let _pactPresumptive = null;
function _pact() {
  if (_pactPresumptive) return _pactPresumptive;
  try { _pactPresumptive = require('./pactPresumptive.cjs'); } catch (_) { _pactPresumptive = null; } // VENDORED REWRITE 4/4 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend
  return _pactPresumptive;
}
function _pactMapHash() { const p = _pact(); try { return p ? p.tableContentHash() : null; } catch (_) { return null; } }

// Interim RN-facing suggestion copy (anthropic-ai-sme polishes in step 5). Bakes the
// VA-rater's HARD caveats: the presumption buys ONLY hop 1 (the intermediate); hop 2 needs
// an independent positive nexus opinion; both conditions need a confirmed CURRENT diagnosis;
// these chains frequently remand before granting (so "supportable" ≠ "first-pass grant").
function _bridgeSuggestion(intermediate, claimed, basisCfr) {
  return `The engine flagged a two-hop pathway worth a look, not a directly viable claim. The veteran has a conceded burn-pit / airborne-hazard exposure and a current ${intermediate} diagnosis, which may be presumptively service-connectable under ${basisCfr}. Exposure does NOT support ${claimed} directly; the lead is to first establish ${intermediate} as service-connected, then claim ${claimed} as secondary to it. Three things make or break this chain: (1) the presumption only reaches the first hop and does nothing to connect ${intermediate} to ${claimed}; (2) that second hop needs an independent positive nexus opinion and is not automatic; and (3) BOTH ${intermediate} and ${claimed} need a confirmed current diagnosis on the chart (missing one is a common avoidable denial). Physician review required before relying on this.`;
}

// assessBridgePathways(clC, chartFactsPresent, granted, art, bestUpstreamCanon) → bridge[].
// Pure, never throws. Returns [] unless a FULLY fact-gated bridge fires (G1–G4 all pass).
function assessBridgePathways(clC, chartFactsPresent, granted, art, bestUpstreamCanon) {
  if (!_bridgeOn() || !chartFactsPresent) return [];
  const events = Array.isArray(chartFactsPresent.in_service_events) ? chartFactsPresent.in_service_events : [];
  const dxList = Array.isArray(chartFactsPresent.dx_constellation) ? chartFactsPresent.dx_constellation : [];
  if (!events.length || !dxList.length) return [];   // G1/G2 transport absent → stays dark
  const pact = _pact();
  if (!pact) return [];

  // G1 — exposure FACTS: each in-service event's canonical is a candidate exposure key;
  // only those the PACT map recognizes (v1: burn_pit_airborne) will match downstream.
  const exposureEvidence = {};
  for (const e of events) {
    const ek = e && e.event_canonical;
    if (!ek || Object.prototype.hasOwnProperty.call(exposureEvidence, ek)) continue;
    exposureEvidence[ek] = (e.evidence_span || e.evidence || '');
  }
  const exposureKeys = Object.keys(exposureEvidence);
  if (!exposureKeys.length) return [];

  const grantedCanon = new Set(granted.map(g => _canon(g)).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const dx of dxList) {
    const dxCanon = _canon(dx);
    if (!dxCanon || dxCanon === clC) continue;             // the claimed condition is not its own intermediate
    // G2 — present (it is, it's in the constellation) AND not already a granted SC
    // (a granted intermediate is a normal one-hop anchor; computed vs the RAW granted set).
    if (grantedCanon.has(dxCanon)) continue;
    // architect guard — never suggest claiming X secondary to the very anchor it already has.
    if (bestUpstreamCanon && dxCanon === bestUpstreamCanon) continue;
    for (const ek of exposureKeys) {
      // G1 — is this present dx a PACT presumptive under this exposure?
      const pres = pact.isPresumptiveFor(dxCanon, ek);
      if (!pres) continue;
      // G3 — is the (intermediate → claimed) secondary pair CURATED (not plausible-default)?
      let pair = null;
      try { pair = resolveAnchorEligibility(pres.condition_canonical, clC); } catch (_) { pair = null; }
      // tier WHITELIST (not just a plausible/excluded blocklist) — guarantees the emitted
      // pair_tier is always one of the schema enum {blessed,conditional,chain}, so a future
      // table tier (e.g. 'low') can never leak a schema-invalid bridge. Defense-in-depth.
      const pairTier = pair && (pair.tier || pair.eligibility);
      if (!pair || pair.in_table !== true || !['blessed', 'conditional', 'chain'].includes(pairTier)) continue;
      const dedup = pres.condition_canonical + '>' + ek;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      // G4 — a provisional SUGGESTION, never a band.
      out.push({
        bridge_provisional: true,
        physician_review_required: true,
        exposure: ek,
        exposure_evidence: exposureEvidence[ek] || undefined,
        intermediate_dx: pres.condition_canonical,
        intermediate_presumptive_basis: pres.basis_cfr,
        claimed: clC,
        pair_tier: pair.tier || pair.eligibility,
        pair_M: typeof pair.M_static === 'number' ? pair.M_static : null,
        suggestion: _bridgeSuggestion(pres.condition_canonical, clC, pres.basis_cfr),
        provenance: { pact_map_hash: _pactMapHash(), pair_table_hash: art ? art.content_hash : null },
      });
    }
  }
  const RANK = { blessed: 3, chain: 2, conditional: 2, low: 1 };
  out.sort((a, b) => (RANK[b.pair_tier] || 0) - (RANK[a.pair_tier] || 0) || (b.pair_M || 0) - (a.pair_M || 0) || a.intermediate_dx.localeCompare(b.intermediate_dx));
  return out;
}

// Attach bridge_pathways additively, ONLY when the primary path is not already strong/
// moderate (a strong direct claim doesn't need a bridge suggestion). Byte-identical when
// the flag is off or no bridge fires — `bridge_pathways` is the only key ever added.
function _maybeAttachBridge(shell, clC, chartFactsPresent, granted, art, band, bestUpstreamCanon) {
  if (!_bridgeOn()) return shell;
  // Bridge rides ONLY on the v2 (direct-axis) shape — a bridge_pathways key on a v1-shaped
  // object would validate against NEITHER schema (v1 forbids the key; v2.1 requires tables).
  // Mirrors every other shape-gated write in this function (if (shell.tables !== undefined)).
  if (shell.tables === undefined) return shell;
  const v = shell.viability;
  if (!(band === 'weak' || band === 'conditional' || v === 'weak' || v === 'abstain')) return shell;
  const bridges = assessBridgePathways(clC, chartFactsPresent, granted, art, bestUpstreamCanon);
  if (bridges.length) shell.bridge_pathways = bridges;
  return shell;
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
      if (shell.tables !== undefined) shell.axis = 'presumptive_redirect';
      shell.why = _whyLine('redirect', null, clC, { hard: true, note: presRule.note }, null);
      return shell;   // hard pre-empt: secondary held as fallback, not ranked
    }
  }

  // §3.6 intermediate-only advisory (obesity): flag that the claimed condition is not a
  // standalone direct claim — does not change the band, just warns the consumer.
  if (_INTERMEDIATE_ONLY[clC]) shell.intermediate_only = _INTERMEDIATE_ONLY[clC];

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

  // Collapse DUPLICATE granted anchors (same canonical upstream) to one. A veteran
  // cannot anchor twice on the same SC condition, and a duplicate poisons the §5.1
  // psych collapse below — which keys its drop-set on upstream_canonical, so a
  // duplicated psych anchor (e.g. PTSD listed in both primary_sc and other_sc) puts
  // the kept anchor's own label in the drop-set and splices out EVERY copy → empty
  // resolved → "weak/none" for the #1 pair PTSD→OSA (live bug, real-case data 2026-06-11).
  {
    const _seenUp = new Set();
    for (let i = 0; i < resolved.length; i++) {
      if (_seenUp.has(resolved[i].upstream_canonical)) { resolved.splice(i, 1); i--; continue; }
      _seenUp.add(resolved[i].upstream_canonical);
    }
  }

  // §5.1 collapse co-class 4.130 psych anchors to the STRONGEST applicable member.
  // Tiebreak mirrors the main ranker incl. causation-first (so a causation-capable
  // psych member is kept over an equal-M aggravation-only one — architect QA 2026-06-11).
  const psych = resolved.filter(a => _PSYCH_4130.has(a.upstream_canonical));
  if (psych.length > 1) {
    psych.sort(_anchorComparator(preferenceRankFor(clC)));   // SSOT: same comparator as the main rank (so the keep-decision matches the rank-decision)
    const keep = psych[0];
    keep.mechanism_member = keep.upstream_canonical;   // bind drafter prose to this member
    const drop = new Set(psych.slice(1).map(a => a.upstream_canonical));
    for (let i = resolved.length - 1; i >= 0; i--) {
      if (drop.has(resolved[i].upstream_canonical)) resolved.splice(i, 1);
    }
  }

  // ── DIRECT axis fold (gated; dark by default) ──────────────────────────────
  // Fold direct in-service-event anchors into the SAME ranked list so ONE comparator
  // picks the cross-axis winner (Tier-1 direct suppresses Tier-2 secondary via the axis
  // tiebreak). Events arrive pre-resolved (producer ran eventCanon / the LLM classifier)
  // through chartFactsPresent.in_service_events. Presumptive in-service EVENTS are NOT a drafting
  // anchor AND do NOT trigger a presumptive redirect here (that's the condition-keyed _PRESUMPTIVE
  // map's job, §3.0). Entirely skipped when the flag is off.
  if (_directAxisOn()) {
    for (const a of resolved) a.anchor_axis = 'secondary';   // tag existing secondary candidates for v2
    const events = (chartFactsPresent && Array.isArray(chartFactsPresent.in_service_events)) ? chartFactsPresent.in_service_events : [];
    if (events.length) {
      const d = _direct();
      if (d) {
        const dres = d.assessDirectViability(clC, { in_service_events: events });
        for (const dc of (dres.candidates || [])) {
          if (!dc || dc.eligibility === 'excluded') continue;
          const mEff = typeof dc.m_static === 'number' ? dc.m_static : 0;
          resolved.push({
            upstream_canonical: _eventLabel(dc.event_canonical),
            upstream_verbatim: dc.evidence || '',
            M_static: mEff,
            M_eff: mEff,
            tier: dc.tier || dc.eligibility,
            basis: dc.basis || '3.303',
            is_granted_sc: false,                 // an in-service event is not a granted SC condition
            mechanism_class: null,
            requires: dc.requires || null,
            factConfirmed: true,                  // the event itself is the evidenced anchor
            anchor_axis: 'direct',
            event_canonical: dc.event_canonical,
            evidence_span: dc.evidence || '',
            physician_reviewed: dc.physician_reviewed === true,
            aggravation_only: false,
          });
        }
      }
    }
  }

  if (!resolved.length) {
    // No secondary AND no direct anchor → honest weak. A presumptive in-service EVENT (burn-pit, AO,
    // …) does NOT make the CLAIMED condition presumptive (Ryan/Pichette 2026-06-15): "presumptive" is
    // decided ONLY by the condition-keyed _PRESUMPTIVE map (consulted earlier at the §3.0 pre-emption),
    // never by the exposure class. OSA is not a burn-pit presumptive, so this must say weak, not
    // "file the presumptive."
    shell.viability = 'weak';
    shell.confidence = 'low';
    shell.why = _whyLine('weak', null, clC, null, null);
    // No one-hop anchor → the bridge branch may surface a presumptive two-hop pathway
    // (e.g. burn-pit veteran, OSA claimed, no granted SC, but a sinusitis dx present).
    return _maybeAttachBridge(shell, clC, chartFactsPresent, granted, art, 'weak', null);
  }

  // Rank: M_eff desc, then E desc, then tier-strength desc, then the curated
  // preference_rank order (panel-ratified anchor ordering for this claimed
  // condition — e.g. OSA-first for Hypertension), then alpha (total order).
  // preference_rank is a TIEBREAK among equally-strong anchors, never an
  // override of M_eff/E/tier: a higher-M anchor still wins on merit. An anchor
  // absent from the list sorts after every ranked one (index = Infinity).
  // Rank with the ONE shared comparator (_anchorComparator) — the SAME function
  // the RN manual + quickref call via rankAnchorRowsForClaimed, so the docs can
  // never disagree with the engine on order. M_eff → eligibility-strength →
  // causation-first (aggravation-only sorts after) → preference_rank → alpha.
  resolved.sort(_anchorComparator(preferenceRankFor(clC)));

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
      if (rt) { shell.viability = 'redirect'; if (shell.tables !== undefined) shell.axis = rt.anchor_axis || 'secondary'; shell.best_anchor = _publicAnchor(rt); shell.why = _whyLine('redirect', rt, clC, null, gv); return shell; }
    }
    shell.viability = 'abstain';   // dead anchor + no granted redirect target → park for RN
    shell.why = _whyLine('redirect', null, clC, null, gv);
    return shell;
  }

  // A DIRECT anchor is a valid anchoring FACT (the evidenced in-service event), not a granted SC
  // condition — pass isGranted=true so _band derives the band from the direct tier/M (else the
  // !isGranted guard would force 'weak'). The is_granted_sc:false provenance flag is preserved on
  // the output. Secondary path: anchor_axis undefined → unchanged.
  const _bandIsGranted = best.anchor_axis === 'direct' ? true : best.is_granted_sc;
  const band = _band(best.tier, best.M_eff, _bandIsGranted, mode, best.factConfirmed);
  shell.viability = band;
  if (shell.tables !== undefined) shell.axis = best.anchor_axis || 'secondary';
  shell.best_anchor = _publicAnchor(best);
  if (best.mechanism_member) shell.best_anchor.mechanism_member = best.mechanism_member;
  shell.alternatives = resolved.slice(1).map(a => {
    const alt = {
      upstream_canonical: a.upstream_canonical, M_eff: a.M_eff, tier: a.tier, is_granted_sc: a.is_granted_sc,
      aggravation_only: a.aggravation_only === true ? true : undefined,
    };
    if (a.anchor_axis) { alt.anchor_axis = a.anchor_axis; if (a.event_canonical) alt.event_canonical = a.event_canonical; }
    return alt;
  });
  // missing_fact: the pair-keyed record that would RAISE the band.
  if ((band === 'conditional') && best.requires) shell.missing_fact = best.requires;
  // confidence: low on an assumed/unreviewed/plausible anchor or info-light contingency.
  shell.confidence = (best.physician_reviewed && best.tier === 'blessed' && (mode === 'chart_refined' || band === 'strong' || band === 'moderate'))
    ? 'high'
    : ((band === 'strong' && mode === 'info_light' && best.tier === 'blessed') ? 'high' : 'low');
  // Direct anchors get a 3.303 direct-connection why; secondary keeps the shared _whyLine.
  if (best.anchor_axis === 'direct') {
    const cap = band.charAt(0).toUpperCase() + band.slice(1);
    shell.why = `${cap}: a documented ${best.upstream_canonical} directly supports service connection for ${clC} under ${best.basis || '3.303'}.`;
  } else {
    shell.why = _whyLine(band, best, clC, shell.presumptive_redirect, null);
  }
  // A weak/conditional one-hop anchor does not suppress a presumptive two-hop suggestion;
  // a strong/moderate one does (gated inside _maybeAttachBridge). Deduped vs the chosen anchor.
  return _maybeAttachBridge(shell, clC, chartFactsPresent, granted, art, band, best.upstream_canonical);
}

function _publicAnchor(a) {
  const out = {
    upstream_canonical: a.upstream_canonical,
    upstream_verbatim: a.upstream_verbatim,
    M_static: a.M_static,
    M_eff: a.M_eff,
    tier: a.tier,
    basis: a.basis,
    aggravation_only: a.aggravation_only === true ? true : undefined,
    causation_denied: a.aggravation_only === true ? true : undefined,
    is_granted_sc: a.is_granted_sc,
    mechanism_class: a.mechanism_class,
    requires: a.requires,
    inherited_from: a.inherited_from || undefined,
  };
  // v2 direct-axis discriminator + fields — set ONLY when the fold tagged the anchor (flag on).
  // The flag-off path never sets anchor_axis, so v1 output is byte-identical.
  if (a.anchor_axis) {
    out.anchor_axis = a.anchor_axis;
    if (a.event_canonical) out.event_canonical = a.event_canonical;
    if (a.evidence_span) out.evidence_span = a.evidence_span;
    if (a.anchor_axis === 'direct' && a.presumptive === true) out.presumptive = true;
  }
  return out;
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

// ── public: recommendedAction(viabilityResult) ───────────────────────────────
// SSOT band→action policy (2026-06-11). The RN viability card AND Ask Aegis both
// consume THIS — neither re-derives the mapping — so "auto-run vs escalate" is
// consistent everywhere. Pure/deterministic. Returns {action, route, band, reason}.
//   strong               -> auto_run                  (dominant pathway; RN proceeds)
//   moderate             -> proceed_with_guidance      (well-established; proceed w/ framing)
//   conditional          -> proceed_with_guidance      (solid once the named record is present)
//   weak | abstain       -> escalate route 'aegis'     (off the validated table — Aegis grounded
//                                                        reasoning, then physician confirm)
//   redirect             -> escalate route 'physician' (presumptive pre-emption — physician path)
//   (unknown band)       -> escalate route 'physician' (fail safe to a human)
function recommendedAction(viabilityResult) {
  const band = viabilityResult && viabilityResult.viability;
  switch (band) {
    case 'strong':
      return { action: 'auto_run', route: null, band, reason: 'Dominant recognized pathway — proceed.' };
    case 'moderate':
      return { action: 'proceed_with_guidance', route: null, band, reason: 'Well-established pathway — proceed with the documented framing.' };
    case 'conditional':
      return {
        action: 'proceed_with_guidance', route: null, band,
        reason: (viabilityResult && viabilityResult.missing_fact)
          ? `Solid pathway once the record shows: ${viabilityResult.missing_fact}.`
          : 'Solid pathway — confirm the required record, then proceed.',
      };
    case 'redirect':
      return { action: 'escalate', route: 'physician', band, reason: 'Presumptive pre-emption — physician decides the path.' };
    case 'weak':
    case 'abstain':
      return { action: 'escalate', route: 'aegis', band, reason: 'Off the validated table — grounded reasoning, then physician confirm.' };
    default:
      return { action: 'escalate', route: 'physician', band: band || null, reason: 'Unrecognized viability state — escalate.' };
  }
}

// public: presumptiveFor(claimedText) — returns the VA-verified presumptive rule for a claimed
// condition (or null). Lets intake + the quick-ref + the RN card flag "this may be a direct
// presumptive grant — check that path first; our secondary letter is the fallback." Pure.
function presumptiveFor(claimedText) {
  const clC = _canon(claimedText);
  if (!clC || !_PRESUMPTIVE[clC]) return null;
  return Object.assign({ claimed: clC }, _PRESUMPTIVE[clC]);
}

// public: intermediateOnlyFor(claimedText) — non-null when the claimed condition is not a
// standalone direct claim (obesity, VAOPGCPREC 1-2017). For intake/quick-ref/RN-card guidance.
function intermediateOnlyFor(claimedText) {
  const clC = _canon(claimedText);
  return (clC && _INTERMEDIATE_ONLY[clC]) ? Object.assign({ claimed: clC }, _INTERMEDIATE_ONLY[clC]) : null;
}

module.exports = {
  resolveAnchorEligibility,
  assessClaimViability,
  recommendedAction,
  presumptiveFor,
  intermediateOnlyFor,
  preferenceRankFor,
  eligibleUpstreamsFor,
  // SSOT ranking + label (the ONE brain the RN manual + quickref must call) —
  rankAnchorRowsForClaimed,
  strengthLabelForRow,
  mEffInfoLight,
  isAggravationOnly,
  aggravationOnlyUpstreamsFor,
  graveyardUpstreamsFor,
  tableVersion,
  tableContentHash,
  setArtifact,        // inject a table object (Worker vendor / tests) — bypasses fs
  setDirectAxisEnabled, // enable the direct-SC fold without process.env (Cloudflare Worker / tests)
  setBridgeEnabled,     // enable the presumptive bridge-anchor pathway without process.env (Worker / tests)
  assessBridgePathways, // exported for the guard tests + vendor selfVerify
  _clearCache,
  _canon,
  _UMBRELLA_RE,       // umbrella/phenotype-unresolved claim labels (read by pipelineLinter.lintClaimedConditionSpecific)
};
