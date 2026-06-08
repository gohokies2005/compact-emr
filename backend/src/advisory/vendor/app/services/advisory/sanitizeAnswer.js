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
 */
function sanitizeAnswer(s) {
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
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { sanitizeAnswer };
