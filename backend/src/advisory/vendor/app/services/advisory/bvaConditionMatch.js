'use strict';

/**
 * bvaConditionMatch — resolves a free-text condition phrase (from an RN, a routing
 * key, or a chart) to the CANONICAL atlas key used by bva_secondary_pairs.json and
 * bva_condition_atlas.md. This is the §4.0 layer-2 SSOT the architect flagged: without
 * it, "OSA" / "sleep apnea" never find "Obstructive sleep apnea" and SQL/atlas lookups
 * silently return nothing.
 *
 * Grounded in app/config/advisory/bva_condition_map.json, which is ported verbatim from
 * the pair-atlas generator's proven CANONICAL synonym set (the same one that extracted
 * 12,183 real pairs). First-match-wins, specificity-ordered.
 *
 * Coverage honesty: a phrase with no match returns null (caller surfaces "no BVA data
 * for X, verify") — never a loose fallback.
 */

const fs = require('fs');
const path = require('path');
const { canonicalizeCondition, isCanonicalLabel } = require('../conditionCanon');

const MAP_PATH = path.join(__dirname, '..', '..', 'config', 'advisory', 'bva_condition_map.json');

let _map = null;
function loadMap() {
  if (_map) return _map;
  const parsed = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.conditions)) {
    throw new Error('bvaConditionMatch: map missing conditions[]');
  }
  _map = parsed;
  return _map;
}
function _reset() { _map = null; }

/** Escape a string for use in a RegExp. */
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Does `term` occur in `text`? Short acronyms (<=4 chars) require word boundaries to
 * avoid substring false-hits (e.g. "osa" inside another word); longer terms match as
 * substrings (so "sleep apnea" matches "obstructive sleep apnea, severe").
 */
function termHits(text, term) {
  if (term.length <= 4) {
    return new RegExp(`\\b${esc(term)}\\b`, 'i').test(text);
  }
  return text.includes(term);
}

/**
 * Resolve a condition phrase to its canonical atlas key.
 * @param {string} phrase
 * @returns {string|null} canonical key, or null if no match (coverage:none)
 */
function resolveCondition(phrase) {
  if (!phrase || typeof phrase !== 'string') return null;
  const text = phrase.toLowerCase().trim();
  if (!text) return null;

  // Compute the advisory map's own answer (exact-key pass, then specificity-ordered synonym scan).
  const map = loadMap();
  let advisory = null;
  for (const entry of map.conditions) {
    if (entry.canonical.toLowerCase() === text) { advisory = entry.canonical; break; }
  }
  if (advisory === null) {
    for (const entry of map.conditions) {
      for (const syn of entry.synonyms) {
        if (termHits(text, syn.toLowerCase())) { advisory = entry.canonical; break; }
      }
      if (advisory !== null) break;
    }
  }

  // DEFECT 2 fix (2026-06-12): the advisory map above is a coarse, substring-matched subset (the
  // original 43 atlas keys) with NO entry for the distinct phenotypes conditionCanon (the SSOT)
  // split out — Allergic rhinitis, Central sleep apnea, Pulmonary hypertension, Chronic
  // rhinosinusitis, Psoriasis, Trauma/stressor disorder (non-PTSD), etc. So e.g. "central sleep
  // apnea" hit the loose "sleep apnea" synonym and COLLAPSED into "Obstructive sleep apnea",
  // making Aegis look up the WRONG anchor row. When the advisory scan produced a hit but
  // conditionCanon assigns a DIFFERENT distinct label, conditionCanon wins (it is the
  // canonicalization SSOT and the downstream viability engine re-canonicalizes through it anyway).
  // We deliberately do NOT override the advisory map's null: if the advisory BVA atlas has no
  // coverage for a term, returning null preserves the coverage-honesty contract (caller surfaces
  // "no BVA data for X, verify") rather than fabricating a match for a condition conditionCanon
  // happens to know but the BVA atlas does not (e.g. "glaucoma").
  if (advisory !== null) {
    const cc = canonicalizeCondition(phrase);
    if (cc && cc !== advisory && isCanonicalLabel(cc)) return cc;
  }
  return advisory;
}

/** All canonical keys (for tests / coverage checks). */
function canonicalKeys() {
  return loadMap().conditions.map((e) => e.canonical);
}

module.exports = { resolveCondition, canonicalKeys, termHits, loadMap, _reset };
