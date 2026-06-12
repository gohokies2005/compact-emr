'use strict';

/**
 * sanitizeAnswer — deterministic plain-text cleaner for Aegis answers.
 *
 * The live probe (2026-06-08) confirmed the model STILL emits markdown asterisks/headers despite the
 * system-prompt rule. Ryan hates that. A prompt rule can't reliably stop it, so the EMR runs every model
 * answer through this before display — a bulletproof strip, not a hope. Removes **bold**, *italic*,
 * markdown #headers, and any stray internal field-name leak. Leaves plain prose + simple dashes intact.
 *
 * Usage (EMR ask-path): const clean = sanitizeAnswer(modelText);  // then render clean
 *
 * Phase 3b (2026-06-11): an OPTIONAL second arg lets the caller pass the retrieval result so the
 * cleaner can mechanically enforce the REASON-mode contract — when the viability engine placed NO
 * band but the corpus/PubMed cleared the bar, the answer is grounded reasoning, NOT a validated
 * pathway, and MUST carry the "physician confirm" hedge + escalate. We don't trust the model to
 * remember; deriveAegisMode() reads the deterministic signal and enforceReasonModeContract() appends
 * the hedge if the model dropped it. Backward-compatible: sanitizeAnswer(text) with no second arg
 * behaves exactly as before (e.g. email_draft, the existing tests).
 */

// On-topic chunk sources that count as "the corpus cleared the bar". retrieve.js only PUSHES a
// semantic chunk when topScore >= RELEVANCE_FLOOR (covered), so the chunk's presence IS the
// semanticRan&&covered signal; pubmed_live chunks come only from a confirmed-no-coverage live pull.
const _GROUND_SOURCES = new Set(['semantic', 'pubmed_live']);

/**
 * deriveAegisMode(retrieval) -> 'defer' | 'reason' | 'abstain' | 'none'
 * Deterministic, from the EXACT fields retrieve() already computes. No model judgment.
 *   defer   = the viability engine placed a band (viability_facts chunk metadata.available===true)
 *             OR bvaPairLookup found the pair (retrieval.stats present) -> explain the engine output.
 *   reason  = NOT defer, but an on-topic semantic chunk OR a live PubMed chunk is present -> grounded
 *             reasoning; must hedge + escalate.
 *   abstain = NOT defer, and no grounded chunk -> the loud plain-language stop (model handles wording).
 *   none    = not a viability-shaped turn (no viability_facts chunk and no stats) -> no contract to add.
 */
function deriveAegisMode(retrieval) {
  if (!retrieval || typeof retrieval !== 'object') return 'none';
  const chunks = Array.isArray(retrieval.chunks) ? retrieval.chunks : [];
  const vf = chunks.find((c) => c && c.source === 'viability_facts');
  const bandPlaced = !!(vf && vf.metadata && vf.metadata.available === true);
  const pairFound = !!retrieval.stats;
  // Only treat this as a viability-grounding turn if the engine ran (a viability_facts chunk exists)
  // or a real pair stat attached — otherwise we have no basis to impose the REASON contract.
  if (!vf && !pairFound) return 'none';
  if (bandPlaced || pairFound) return 'defer';
  const grounded = chunks.some((c) => c && _GROUND_SOURCES.has(c.source));
  return grounded ? 'reason' : 'abstain';
}

// The exact hedge the REASON-mode contract requires the answer to carry (one sentence, plain text,
// no markdown — sanitizeAnswer runs before this so it stays clean). Mirrors the prompt wording.
const REASON_HEDGE = 'Note: this is grounded reasoning from the literature, not a validated or blessed '
  + 'pathway in our system, so please have Dr. Ryan confirm before we tell the veteran anything.';

/** Does the answer already carry the not-a-validated-pathway hedge? (loose match — the model may
 *  phrase it its own way; we only append when it clearly forgot.) */
function _hasReasonHedge(t) {
  const low = t.toLowerCase();
  return (/grounded reasoning|not (a )?validated|not (a )?blessed/.test(low))
    && /(physician|dr\.? ryan|team lead) (confirm|review|sign)|have (dr\.? ryan|a physician)/.test(low);
}

/**
 * enforceReasonModeContract(cleanText, mode) -> text
 * When mode==='reason', GUARANTEE the answer carries the hedge. If the model already worded it, leave
 * it; otherwise append the canonical hedge sentence. (escalate=true is surfaced by the API field, not
 * inline prose — see the answer path.) No-op for every other mode, so DEFER answers never get a false
 * "grounded reasoning, not validated" leak.
 */
function enforceReasonModeContract(cleanText, mode) {
  const t = String(cleanText || '');
  if (mode !== 'reason') return t;
  if (_hasReasonHedge(t)) return t;
  const sep = t.trim() ? (t.trim().endsWith('.') ? ' ' : '. ') : '';
  return (t.trim() + sep + REASON_HEDGE).trim();
}

function sanitizeAnswer(s, retrieval) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '')); // strip code-fence markers, keep content
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');     // markdown headers -> plain
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');        // **bold** -> bold
  t = t.replace(/__(.+?)__/g, '$1');            // __bold__ -> bold
  t = t.replace(/(^|\s)\*(?=\S)([^*\n]+?)\*(?=\s|[.,;:!?)]|$)/g, '$1$2'); // *italic* -> italic
  t = t.replace(/(^|\s)_(?=\S)([^_\n]+?)_(?=\s|[.,;:!?)]|$)/g, '$1$2');   // _italic_ -> italic
  t = t.replace(/\*\*/g, '').replace(/(^|\s)\*(\s)/g, '$1$2'); // any stray ** or lone *
  // never let internal field names / refund text survive into the displayed answer
  t = t.replace(/\b(coverage_gap|letter_citable|relative_signal_only|directionality_reliable)\b/g, '');
  t = t.replace(/[^.\n]*\$50[^.\n]*\brefund[^.\n]*\.?/gi, ''); // drop any sentence mentioning a $50 refund
  t = t.replace(/[^.\n]*\brefund[^.\n]*\$50[^.\n]*\.?/gi, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Phase 3b: if the caller passed the retrieval result and the pipeline was in REASON mode,
  // mechanically guarantee the "grounded reasoning, not a validated pathway — physician confirm"
  // hedge. No-op for defer/abstain/none, so a DEFER answer never gets the off-list hedge leaked in.
  if (retrieval !== undefined) t = enforceReasonModeContract(t, deriveAegisMode(retrieval));
  return t;
}

module.exports = { sanitizeAnswer, deriveAegisMode, enforceReasonModeContract, REASON_HEDGE };
