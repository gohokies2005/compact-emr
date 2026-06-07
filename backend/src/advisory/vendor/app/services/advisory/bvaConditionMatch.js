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
  // Already a canonical key? (cheap exact-key pass so callers can pass canonical names.)
  const map = loadMap();
  for (const entry of map.conditions) {
    if (entry.canonical.toLowerCase() === text) return entry.canonical;
  }
  // Synonym scan, specificity order (first match wins — mirrors the generator).
  for (const entry of map.conditions) {
    for (const syn of entry.synonyms) {
      if (termHits(text, syn.toLowerCase())) return entry.canonical;
    }
  }
  return null;
}

/** All canonical keys (for tests / coverage checks). */
function canonicalKeys() {
  return loadMap().conditions.map((e) => e.canonical);
}

module.exports = { resolveCondition, canonicalKeys, termHits, loadMap, _reset };
