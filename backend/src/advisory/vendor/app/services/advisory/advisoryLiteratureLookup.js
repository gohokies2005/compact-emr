'use strict';

/**
 * advisoryLiteratureLookup — live PubMed/NCBI fallback for the advisory tool's COVERAGE GATE.
 *
 * When a viability question hits a condition with NO curated library coverage, instead of falling
 * back to the model's general knowledge, we pull REAL, VERIFIABLE literature from PubMed via the
 * drafter's battle-tested `citationFallback.retrieveGroundedAnchors`. Anti-hallucination is structural:
 *   - every PMID is RETURNED BY NCBI esearch, never model-generated
 *   - the killer quote is a VERBATIM SUBSTRING of the real efetch abstract
 *   - retracted papers + off-topic papers are rejected
 * Cost: NCBI E-utilities is FREE; only a cent or two of tokens to read the abstracts.
 *
 * Relevance on a truly off-library condition is NOT guaranteed (the on-topic gate is loose), so every
 * chunk is flagged `verify_relevance:true` and the answer presents them as CANDIDATE papers + the seed
 * for a physician library build — never as a settled grounded answer.
 *
 * RUNTIME NOTE: this does HTTPS to eutils.ncbi.nlm.nih.gov, so the EMR Lambda needs internet egress.
 */

const { retrieveGroundedAnchors } = require('../citationFallback');

/** Map citationFallback anchors → retrieve() chunk shape. Pure (testable offline). */
function anchorsToChunks(anchors) {
  return (anchors || []).map((a) => ({
    text: `${a.full_citation || a.title}${a.killer_finding ? ' — ' + a.killer_finding : ''}`,
    source: 'pubmed_live',
    citation: 'PMID ' + a.pmid,
    metadata: {
      pmid: a.pmid, title: a.title, journal: a.journal, year: a.year,
      killer_finding: a.killer_finding || null,
      verify_relevance: true, // live pull, NOT curated — confirm it's on-topic before relying
      live: true,
    },
    letter_citable: true, // real published PMID; verify_relevance still required before letter use
  }));
}

/**
 * Pull real PubMed literature for an uncovered condition.
 * @param {string} condition
 * @param {object} [opts] - { retriever } injectable for tests
 * @returns {Promise<{status, source, condition, chunks, notes, errors?}>}
 */
async function livePubmedLookup(condition, opts = {}) {
  const retriever = opts.retriever || retrieveGroundedAnchors;
  try {
    const r = await retriever(condition, {});
    const chunks = anchorsToChunks(r && r.anchors);
    return {
      status: chunks.length ? 'ok' : 'empty',
      source: 'pubmed_live',
      condition,
      chunks,
      notes: chunks.length
        ? [`Pulled ${chunks.length} real PubMed paper(s) for "${condition}" — VERIFY RELEVANCE; not yet curated into our library. These are the seed for a physician library build.`]
        : [`No on-topic PubMed papers found for "${condition}".`],
    };
  } catch (e) {
    return { status: 'degraded', source: 'pubmed_live', condition, chunks: [], errors: [`pubmed lookup failed: ${e.message}`], notes: [] };
  }
}

module.exports = { livePubmedLookup, anchorsToChunks };
