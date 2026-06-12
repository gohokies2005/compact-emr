'use strict';

/**
 * sourceQuota.js — per-source-type quota selection over a WIDE candidate set (2026-06-11).
 *
 * THE PROBLEM IT SOLVES: a flat top-8 cosine lets medical-lit chunks (1199 of 1457 in the corpus)
 * crowd out the ONE M21-1 / CFR chunk a "how will the VA weigh X" question needs. This applies a
 * per-type CEILING so VA-authority chunks get a guaranteed slot WHEN they clear the relevance floor,
 * and never get padded in when they don't.
 *
 * SHARED by BOTH retrieval paths so they cannot drift:
 *   - app/services/advisory/retrieve.js   (EMR RDS pgvector path)
 *   - gmail-addon/aws-endpoint/index.js   (standalone Lambda in-memory dot-product path)
 *
 * Bucketing is by citation_type (the ONLY discriminator — every corpus chunk has source:'semantic'):
 *   medical    <- citation_type null | 'lit'                 (peer-reviewed literature; letter-citable)
 *   regulation <- citation_type 'regulation'                 (subdir 38 CFR; letter-citable)
 *   m21        <- citation_type 'm21'                        (VA adjudication manual; NOT letter-citable)
 *   dbq        <- citation_type 'dbq'                        (DBQ field map; NOT letter-citable)
 *   guidance   <- citation_type 'guidance'                   (internal RN playbook/pathways; NOT citable)
 *   other      <- anything unrecognized                      (fail-open bucket; never dropped on a typo)
 *
 * CONTRACT (pure, deterministic, fail-open):
 *   selectByQuota(candidates, { quotas, floor, cap }) -> Array (a SUBSET of candidates, original order
 *   preserved within the final selection by descending score).
 *   - `candidates` MUST be pre-sorted best-first (highest cosine first); we DO NOT re-sort by score we
 *     do not trust to be comparable, we only respect the order given and break out the per-bucket order.
 *   - A quota is a CEILING. A chunk is admitted to fill its bucket quota ONLY if score >= floor.
 *     Below floor => never admitted via quota (no junk padding), even if the bucket is empty.
 *   - After quotas are filled, remaining slots up to `cap` are filled with the next-best STILL-ABOVE-FLOOR
 *     candidates of ANY type (so the common all-medical question still gets a full context).
 *   - If quotas/floor/cap are absent => degrades to "top `cap` above floor, no bucketing" (≈ legacy top-K).
 */

// citation_type -> bucket name. null/'lit' => medical. Unknown types fall to 'other' (never dropped).
// When citation_type is NOT carried on the row — the RDS SELECT deliberately omits the column to avoid a
// schema dependency, and the Lambda rows don't carry it either — derive the type from the chunk id PREFIX
// instead (ids are 'm21:…' 'dbq:…' 'reg:…' 'lit:…' 'playbook:/guidance:/pathmap:/denial:…'). This keeps
// quota bucketing fully functional with zero dependency on a downstream column.
function bucketOf(chunk) {
  let ct = chunk && (chunk.citation_type != null ? chunk.citation_type
    : (chunk.metadata && chunk.metadata.citation_type));
  if (ct == null) {
    const id = (chunk && (chunk.id || (chunk.metadata && chunk.metadata.id))) || '';
    const pfx = String(id).split(':', 1)[0];
    if (pfx === 'm21') ct = 'm21';
    else if (pfx === 'dbq') ct = 'dbq';
    else if (pfx === 'reg') ct = 'regulation';
    else if (pfx === 'lit') ct = 'lit';
    else if (pfx === 'playbook' || pfx === 'guidance' || pfx === 'pathmap' || pfx === 'denial') ct = 'guidance';
  }
  if (ct == null || ct === 'lit') return 'medical';
  if (ct === 'regulation') return 'regulation';
  if (ct === 'm21') return 'm21';
  if (ct === 'dbq') return 'dbq';
  if (ct === 'guidance') return 'guidance';
  return 'other';
}

// Read a comparable score off either the flat row shape (retrieve.semanticSearch raw rows) OR the
// mapped chunk shape (metadata.score). Missing score => treat as -Infinity (only admitted if no floor).
function scoreOf(chunk) {
  if (chunk == null) return -Infinity;
  if (typeof chunk.score === 'number') return chunk.score;
  if (chunk.metadata && typeof chunk.metadata.score === 'number') return chunk.metadata.score;
  return -Infinity;
}

/**
 * @param {Array} candidates  best-first list of candidate chunks (flat rows or mapped chunks)
 * @param {Object} opts
 * @param {Object} [opts.quotas]  { medical, regulation, m21, dbq, guidance, other } ceilings (missing => 0 quota, still cap-eligible)
 * @param {number} [opts.floor]   relevance floor; chunks below are never admitted. Default -Infinity (admit all).
 * @param {number} [opts.cap]     hard cap on returned chunks. Default candidates.length.
 * @returns {Array} selected subset (deduped, score-descending)
 */
function selectByQuota(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const quotas = opts.quotas || null;
  const floor = typeof opts.floor === 'number' ? opts.floor : -Infinity;
  const cap = typeof opts.cap === 'number' ? opts.cap : list.length;
  if (cap <= 0) return [];

  // Stable best-first by score (does not reorder ties — Array.prototype.sort is not guaranteed stable
  // across engines pre-ES2019, but Node 12+ is stable; we also keep input order as the natural tiebreak).
  const ranked = list
    .map((c, i) => ({ c, i, s: scoreOf(c) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i));

  const selected = [];
  const taken = new Set();

  // PASS 1 — fill each bucket up to its quota with above-floor candidates only.
  if (quotas) {
    const used = {};
    for (const { c, i, s } of ranked) {
      if (selected.length >= cap) break;
      if (s < floor) continue;
      const b = bucketOf(c);
      const q = typeof quotas[b] === 'number' ? quotas[b] : 0;
      if (q <= 0) continue;
      if ((used[b] || 0) >= q) continue;
      used[b] = (used[b] || 0) + 1;
      selected.push(c);
      taken.add(i);
    }
  }

  // PASS 2 — fill remaining slots up to cap with next-best above-floor of ANY type.
  for (const { c, i, s } of ranked) {
    if (selected.length >= cap) break;
    if (taken.has(i)) continue;
    if (s < floor) continue;
    selected.push(c);
    taken.add(i);
  }

  return selected;
}

module.exports = { selectByQuota, bucketOf, scoreOf };
