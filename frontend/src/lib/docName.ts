// Document display naming (Ryan 2026-06-18, "asked 3×": kill "Misc/Other"). The backend classifier
// gives recognized VA records a content title (autoTitle, e.g. "VA Rating Decision — GERD denied").
// When it can't recognize a doc, we must STILL never show the literal "Misc"/"Other" or a raw veteran
// filename like "Woodley_GERD_Misc_4.docx" — we clean the filename into a readable label instead.
//
// This is DISPLAY ONLY. It never asserts a document TYPE (that's the classifier's job from content) —
// cleaning a filename is low-stakes labeling, not the SC-provenance-sensitive type/authority decision.

// Standalone tokens that carry no information — dropped from a cleaned filename label.
const NOISE_TOKENS = new Set([
  'misc', 'other', 'scan', 'scanned', 'copy', 'final', 'document', 'doc', 'docs',
  'file', 'files', 'upload', 'uploaded', 'img', 'image', 'pdf', 'new',
]);

/**
 * Turn a raw upload filename into a readable label: drop the extension, split on separators, drop
 * noise tokens (misc/other/scan/…), and re-join. Never returns "Misc"/"Other"; never empty.
 * "Woodley_GERD_Misc_4.docx" → "Woodley GERD 4"; "scan0001.pdf" → "0001" → falls back to "Document".
 */
export function cleanDocFilename(filename: string): string {
  const base = (filename ?? '').replace(/\.[a-z0-9]{1,5}$/i, ''); // strip a trailing extension
  const tokens = base.split(/[\s_\-.]+/).filter(Boolean);
  // Drop noise tokens entirely — never fall back to them (that would re-surface the literal "Misc").
  const kept = tokens.filter((t) => !NOISE_TOKENS.has(t.toLowerCase()));
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  // Empty, or only digits/punctuation (e.g. "Misc_2" → "2") isn't informative — use a neutral word.
  return out.length > 0 && /[a-z]/i.test(out) ? out : 'Document';
}

/**
 * The display name for a document row: the classifier's content title when present, else a cleaned
 * filename. NEVER "Misc"/"Other" and never a raw "_Misc_N" filename.
 */
export function documentDisplayName(doc: { readonly autoTitle?: string | null; readonly filename: string }): string {
  const title = (doc.autoTitle ?? '').trim();
  return title.length > 0 ? title : cleanDocFilename(doc.filename);
}
