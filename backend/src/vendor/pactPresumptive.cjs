// app/services/pactPresumptive.js
//
// PACT Act PRESUMPTIVE-condition lookup — the "is condition X presumptive under
// exposure Y" leaf for the presumptive BRIDGE-ANCHOR viability pathway. Sibling to
// eventCanon.js (closed-enum leaf) in the dependency topology:
//
//   eventCanon / pactPresumptive  (dumb leaves)
//        ^                ^
//        |                |
//   directSc      anchorMechanism.assessBridgePathways  (orchestration)
//
// This module is a DUMB table: it answers isPresumptiveFor(dxLabel, exposureKey)
// and NOTHING about mechanism or the second hop. The bridge's G3 (does the
// intermediate -> claimed secondary pair survive the tier gate) is decided by
// anchorMechanism.resolveAnchorEligibility, NOT here. Keeping this a pure lookup
// avoids a require cycle (anchorMechanism -> pactPresumptive, never the reverse).
//
// Pure/deterministic: no network, no LLM, never throws. Cloudflare-vendorable via
// the setPactMap inject seam (mirrors directSc.setDirectTable).

'use strict';
const fs = require('fs');
const path = require('path');

let conditionCanon = null;
try { conditionCanon = require('./conditionCanon.cjs'); } catch (_) { conditionCanon = null; } // VENDORED REWRITE 1/2 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend

const TABLE_PATH = path.join(__dirname, 'pact_presumptive_conditions.json'); // VENDORED REWRITE 2/2 (scripts/vendor-anchor-table.mjs): table sits beside the resolver

let _cache = null;
// per-table row-count floor (lean by design; NOT the secondary 500 guard)
const MIN_ROWS = 4;

// Shared index builder — the SINGLE place that turns a raw {rows, content_hash} object
// into the cache shape. BOTH the fs-load path (_loadTable) and the inject seam
// (setPactMap) route through this so a Cloudflare-Worker / EMR vendor (which injects
// the table, never touches fs) produces a BYTE-IDENTICAL cache to a Node fs-load.
// Mirrors directSc._indexTable / anchorMechanism.setArtifact discipline.
function _indexTable(raw) {
  const rows = Array.isArray(raw && raw.rows) ? raw.rows : [];
  const isStub = rows.length < MIN_ROWS;
  // Index by (condition_canonical + '>' + exposure_key). The table labels ARE
  // conditionCanon OUTPUT labels; re-canonicalizing them mis-keys the non-idempotent
  // ones (e.g. "Sinusitis / rhinitis"). Lookups canonicalize the QUERY and match here.
  const byCondExposure = new Map();
  for (const r of rows) {
    const keys = Array.isArray(r.exposure_keys) ? r.exposure_keys : [];
    for (const ek of keys) {
      byCondExposure.set(String(r.condition_canonical).trim() + '>' + ek, r);
    }
  }
  return { rows, byCondExposure, content_hash: (raw && raw.content_hash) || null, isStub };
}

function _loadTable() {
  if (_cache) return _cache;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')); }
  catch (_) { raw = { rows: [], content_hash: null }; }
  _cache = _indexTable(raw);
  return _cache;
}

// Inject seam for fs-less environments (Cloudflare Worker, EMR vendor bundle). Populates
// the cache from a pre-parsed table object via the SAME _indexTable path as fs-load —
// guarantees the vendored copy resolves identically to the canonical Node copy. The
// vendor bundle init calls setArtifact + setDirectTable + setPactMap (one each).
function setPactMap(data) {
  _cache = _indexTable(data || { rows: [], content_hash: null });
  return _cache;
}

function _canon(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (conditionCanon && typeof conditionCanon.canonicalizeCondition === 'function') {
    try { return conditionCanon.canonicalizeCondition(t) || t; } catch (_) { return t; }
  }
  return t;
}

// isPresumptiveFor(dxLabel, exposureKey) -> { condition_canonical, presumptive_class,
// basis_cfr, note } when dxLabel is a PACT-presumptive condition under exposureKey, else
// null. exposureKey aligns with eventCanon EVENT_ENUM (v1: 'burn_pit_airborne').
// Canonicalizes the query (resolves lay/synonym phrasing) then matches the raw label.
function isPresumptiveFor(dxLabel, exposureKey) {
  const tbl = _loadTable();
  if (tbl.isStub || !exposureKey) return null;
  const canonQ = _canon(dxLabel);
  for (const k of [canonQ, String(dxLabel || '').trim()]) {
    if (!k) continue;
    const row = tbl.byCondExposure.get(k + '>' + exposureKey);
    if (row) {
      return {
        condition_canonical: row.condition_canonical,
        presumptive_class: row.presumptive_class || null,
        basis_cfr: row.basis_cfr || '38 CFR 3.320',
        note: row.note || null,
      };
    }
  }
  return null;
}

// presumptiveIntermediates(exposureKey) -> [condition_canonical] — the set of valid
// bridge INTERMEDIATES for an exposure (before the second-hop G3 gate). Helper for
// callers that scan a dx constellation against the map.
function presumptiveIntermediates(exposureKey) {
  const tbl = _loadTable();
  if (tbl.isStub || !exposureKey) return [];
  const out = [];
  for (const r of tbl.rows) {
    const keys = Array.isArray(r.exposure_keys) ? r.exposure_keys : [];
    if (keys.includes(exposureKey)) out.push(r.condition_canonical);
  }
  return out;
}

function tableContentHash() { return _loadTable().content_hash; }
function _resetCacheForTest() { _cache = null; }

module.exports = {
  isPresumptiveFor,
  presumptiveIntermediates,
  tableContentHash,
  setPactMap,
  _resetCacheForTest,
};
