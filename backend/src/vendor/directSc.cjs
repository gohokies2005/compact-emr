// app/services/directSc.js
//
// DIRECT service-connection resolver — the direct-axis sibling of
// anchorMechanism.resolveAnchorEligibility (which is secondary-only). Reads the
// physician-authored direct table (references/sc_direct_pairs.json), keyed on
// in-service EVENT (eventCanon enum) -> claimed condition, and returns the
// eligibility/tier for a (event, claimed) pair.
//
// SELF-CONTAINED on purpose (direct-SC build, 2026-06-14): this module does NOT yet
// mutate anchorMechanism.assessClaimViability or framingGate — those are live,
// load-bearing, and feed the public viability tool. The unification (fold direct
// candidates into assessClaimViability with an axis-aware ranker + caseViability v2)
// is the careful next chunk, sequenced AFTER the secondary gate is live in prod
// (architect: do not flip both axes at once). Until then this is the tested engine.
//
// Pure/deterministic: no network, no LLM, never throws. Cloudflare-vendorable.

'use strict';
const fs = require('fs');
const path = require('path');

let conditionCanon = null;
try { conditionCanon = require('./conditionCanon.cjs'); } catch (_) { conditionCanon = null; } // VENDORED REWRITE 1/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend
const eventCanon = require('./eventCanon.cjs'); // VENDORED REWRITE 2/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend

const TABLE_PATH = path.join(__dirname, 'sc_direct_pairs.json'); // VENDORED REWRITE 3/3 (scripts/vendor-anchor-table.mjs): table sits beside the resolver

let _cache = null;
// per-table row-count floor (NOT the secondary 500 guard — this table is lean by design)
const MIN_ROWS = 8;

// Shared index builder — the SINGLE place that turns a raw {rows, content_hash} object into
// the cache shape. BOTH the fs-load path (_loadTable) and the inject seam (setDirectTable) route
// through this so a Cloudflare-Worker / EMR vendor (which injects the table, never touches fs)
// produces a BYTE-IDENTICAL cache to a Node fs-load. Mirrors anchorMechanism.setArtifact discipline.
function _indexTable(raw) {
  const rows = Array.isArray(raw && raw.rows) ? raw.rows : [];
  const isStub = rows.length < MIN_ROWS;
  // Index by the RAW claimed label (the table labels ARE conditionCanon OUTPUT labels;
  // re-canonicalizing them mis-keys the non-idempotent ones e.g. "Skin (...)"->"Psoriasis").
  // Lookups canonicalize the QUERY and match against the raw label.
  const byEventClaimed = new Map();
  for (const r of rows) {
    byEventClaimed.set(r.event_canonical + '>' + String(r.claimed_canonical).trim(), r);
  }
  return { rows, byEventClaimed, content_hash: (raw && raw.content_hash) || null, isStub };
}

function _loadTable() {
  if (_cache) return _cache;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')); }
  catch (_) { raw = { rows: [], content_hash: null }; }
  _cache = _indexTable(raw);
  return _cache;
}

// Inject seam for fs-less environments (Cloudflare Worker, EMR vendor bundle). Populates the cache
// directly from a pre-parsed table object via the SAME _indexTable path as fs-load — guarantees the
// vendored copy resolves identically to the canonical Node copy. Call once at bundle init.
function setDirectTable(data) {
  _cache = _indexTable(data || { rows: [], content_hash: null });
  return _cache;
}

function _canonClaimed(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (conditionCanon && typeof conditionCanon.canonicalizeCondition === 'function') {
    try { return conditionCanon.canonicalizeCondition(t) || t; } catch (_) { return t; }
  }
  return t;
}

const _M0 = { eligible: false, eligibility: 'excluded', tier: 'excluded', m_static: 0 };
function _plausibleDefault() { return { eligible: true, eligibility: 'plausible', tier: 'plausible', m_static: 2, default: true }; }
function _abstainNoRow() { return { eligible: false, eligibility: 'abstain', tier: 'abstain', m_static: 0, reason: 'no_row_exposure_abstain' }; }

// TOXIC/EXPOSURE events (Ryan 2026-06-15, Pichette): a toxic exposure does NOT support an arbitrary
// claimed condition under 3.303 "by default" — that's a presumptive/FILING matter (the veteran must
// file to get it conceded), not a manufactured nexus. So for these events an UNKNOWN (no curated row)
// pair ABSTAINS instead of falling to the long-tail plausible default. The plausible default stays for
// INJURY/ACTIVITY events (acute injury, repetitive load, blast/TBI, acoustic noise, criterion-A
// trauma, MST, chronic operational stress, COLD INJURY) where an undocumented direct nexus is medically
// reasonable. (Presumptive events — burn-pit/AO/Gulf-War/Lejeune/radiation/1yr — are filtered upstream
// in assessDirectViability and route to the condition-keyed presumptive logic, never here.)
const _ABSTAIN_ON_UNKNOWN = new Set([
  'chemical_solvent_fuel_tera', 'asbestos',
  // presumptive set (already filtered before lookup; listed for intent/defense-in-depth)
  'burn_pit_airborne', 'herbicide_agent_orange', 'gulf_war_environmental',
  'camp_lejeune_water', 'ionizing_radiation', 'chronic_disease_1yr',
]);

// resolveDirectEligibility(eventCanonical, claimedText) — table lookup for ONE pair.
// Returns {eligibility, tier, m_static, basis, requires, mechanism, presumptive, physician_reviewed, row}.
// Unknown pair -> plausible default (long tail always drafts), per the spec.
function resolveDirectEligibility(eventCanonical, claimedText) {
  const tbl = _loadTable();
  if (tbl.isStub) return { ...(_plausibleDefault()), stub: true };
  if (!eventCanon.isValidEvent(eventCanonical)) return { ..._plausibleDefault(), reason: 'unknown_event' };
  // Try canon(query) (resolves lay/synonym phrasing to the canonical output label),
  // then the raw query (covers already-canonical labels conditionCanon won't re-map).
  let row = null;
  const canonQ = _canonClaimed(claimedText);
  for (const k of [canonQ, String(claimedText || '').trim()]) {
    if (!k) continue;
    row = tbl.byEventClaimed.get(eventCanonical + '>' + k);
    if (row) break;
  }
  // Unknown pair: toxic/exposure events ABSTAIN (file-the-claim, not a manufactured nexus); all
  // other (injury/activity) events keep the long-tail plausible default.
  if (!row) return _ABSTAIN_ON_UNKNOWN.has(eventCanonical) ? _abstainNoRow() : { ..._plausibleDefault(), reason: 'no_row' };
  return {
    eligible: row.eligibility !== 'excluded',
    eligibility: row.eligibility,
    tier: row.tier || row.eligibility,
    m_static: typeof row.m_static === 'number' ? row.m_static : 0,
    basis: row.basis || '3.303',
    requires: row.requires || null,
    mechanism: row.mechanism || null,
    presumptive: row.presumptive === true,
    physician_reviewed: row.physician_reviewed === true,
    row,
  };
}

// assessDirectViability(claimedText, eventsInput) — resolve the veteran's in-service
// events from a chart va_concessions object OR free text, look up each (event,claimed)
// pair, and return the BEST direct anchor (highest tier). Presumptive events are
// flagged for the existing _PRESUMPTIVE redirect, never drafted here.
// Returns { band, best, candidates[], presumptive_events[], events_detected[] }.
// Body-region keyword catalog (for acute-injury structure-matching precision).
const _REGION_RE = {
  // claimable structural regions (incl. anatomical synonyms so "ACL tear" -> knee, "rotator cuff" -> shoulder)
  knee: /\b(knee|acl|mcl|meniscus|patella)/i, shoulder: /\b(shoulder|rotator cuff|labrum)/i,
  hip: /\bhip\b/i, ankle: /\bankle/i,
  back: /\b(back|lumbar|spine|spinal|disc|thoracic)\b/i, neck: /\b(neck|cervical)\b/i,
  foot: /\b(foot|feet|plantar|heel)\b/i, wrist: /\bwrist/i,
  // non-claimable regions: present ONLY so an injury to one of these creates a region
  // MISMATCH and correctly drops a structure-specific claim (e.g. groin injury != knee claim)
  groin: /\b(groin|scrotal|testic|inguinal)/i, hand: /\b(hand|finger|thumb)\b/i,
  elbow: /\belbow/i, head: /\b(head|skull|face|jaw)\b/i,
};
// Claimed canonical -> required injured region (null = region-agnostic, e.g. generalized OA).
function _regionOfClaimed(canon) {
  const c = String(canon || '').toLowerCase();
  if (/knee/.test(c)) return 'knee';
  if (/shoulder/.test(c)) return 'shoulder';
  if (/\bhip\b/.test(c)) return 'hip';
  if (/ankle/.test(c)) return 'ankle';
  if (/lumbar|back|degenerative disc/.test(c)) return 'back';
  if (/cervical|neck/.test(c)) return 'neck';
  if (/plantar|foot/.test(c)) return 'foot';
  return null;
}
// Return ALL body regions mentioned (not just the first) so a multi-region injury
// narrative ("hurt my knee and my back") doesn't wrong-DROP a legit back claim.
function _detectRegions(text) {
  const t = String(text || '');
  return Object.keys(_REGION_RE).filter(region => _REGION_RE[region].test(t));
}
function _eventText(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    // Pre-resolved events (producer-side eventCanon/classifier): the evidence spans ARE the
    // event text the region-precision gate inspects.
    if (Array.isArray(input.in_service_events)) {
      return input.in_service_events.map(e => (e && (e.evidence_span || e.evidence)) || '').join(' ; ');
    }
    const vc = input.va_concessions || input;
    const ev = vc.in_service_event_conceded || vc.in_service_event;
    if (typeof ev === 'string') return ev;
    if (Array.isArray(ev)) return ev.map(e => typeof e === 'string' ? e : ((e && (e.scope_verbatim || e.event)) || '')).join(' ; ');
  }
  return '';
}

// Resolve the `detected` event array. Accepts EITHER a pre-resolved
// {in_service_events:[{event_canonical, evidence_span}]} object (the producer already ran
// eventCanon / the LLM classifier — fold those in via chartFactsPresent.in_service_events) OR
// a raw chart va_concessions object / free-text string (then run eventCanon here). Pre-resolved
// events are still validated against EVENT_ENUM (drop unknowns) and de-duped by type.
function _resolveDetected(eventsInput) {
  if (eventsInput && typeof eventsInput === 'object' && Array.isArray(eventsInput.in_service_events)) {
    const out = [];
    const seen = new Set();
    for (const e of eventsInput.in_service_events) {
      const evt = e && e.event_canonical;
      if (!evt || !eventCanon.isValidEvent(evt) || seen.has(evt)) continue;
      seen.add(evt);
      out.push({ event_canonical: evt, evidence: (e.evidence_span || e.evidence || ''), source: e.source || 'pre_resolved' });
    }
    return out;
  }
  return eventCanon.resolveEventCanon(eventsInput);
}

function assessDirectViability(claimedText, eventsInput) {
  const detected = _resolveDetected(eventsInput);
  const presumptive_events = detected.filter(d => eventCanon.isPresumptiveEvent(d.event_canonical));
  const textBlob = _eventText(eventsInput);
  const claimedRegion = _regionOfClaimed(_canonClaimed(claimedText));
  const candidates = [];
  for (const d of detected) {
    if (eventCanon.isPresumptiveEvent(d.event_canonical)) continue; // -> redirect, not a drafting anchor
    // PRECISION GATE: an acute-injury anchor for a structure-specific claim only counts
    // when the injured region in the event text matches the claimed structure (else a
    // groin sick-call would falsely "bless" a back claim). Region-agnostic claims
    // (e.g. generalized OA, claimedRegion=null) are not gated.
    if (d.event_canonical === 'acute_in_service_injury' && claimedRegion) {
      if (!_detectRegions(textBlob).includes(claimedRegion)) continue;
    }
    const r = resolveDirectEligibility(d.event_canonical, claimedText);
    if (r.eligibility === 'excluded' || r.eligibility === 'abstain') continue; // exposure-no-row abstains (Pichette)
    candidates.push({ event_canonical: d.event_canonical, evidence: d.evidence, ...r });
  }
  // rank: blessed > conditional > plausible, then by m_static
  const rank = { blessed: 3, conditional: 2, chain: 2, plausible: 1, excluded: 0 };
  candidates.sort((a, b) => (rank[b.eligibility] - rank[a.eligibility]) || (b.m_static - a.m_static));
  const best = candidates[0] || null;
  let band = 'abstain';
  if (best) {
    band = best.eligibility === 'blessed' ? 'strong'
      : best.eligibility === 'conditional' ? 'moderate'
      : 'plausible';
  } else if (presumptive_events.length) {
    band = 'presumptive_redirect';
  }
  return { band, best, candidates, presumptive_events, events_detected: detected };
}

function tableContentHash() { return _loadTable().content_hash; }
function _resetCacheForTest() { _cache = null; }

module.exports = {
  resolveDirectEligibility,
  assessDirectViability,
  tableContentHash,
  setDirectTable,
  _resetCacheForTest,
};
