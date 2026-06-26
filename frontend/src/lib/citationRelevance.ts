// Citation relevance heuristic (Dr. Kasky 2026-06-25) — a CHEAP, DETERMINISTIC, client-side check.
//
// The Citation Enricher + Guided Revision already guard against FABRICATION (fake PMIDs are
// re-verified server-side). They do NOT guard against RELEVANCE — a physician can add a real but
// off-topic citation. This module is decision-support ONLY: it computes a token-overlap score
// between a citation's subject (its title + killer finding) and the target passage/claim/condition,
// and flags when that overlap looks too thin. It NEVER blocks — the physician always proceeds; the
// caller renders a soft "this may not support this passage — add anyway?" advisory. No LLM call.

// Words that carry no topical signal — stripped before scoring so a shared "the"/"of"/"more" doesn't
// inflate overlap. Kept deliberately small + medico-neutral (no condition terms here).
const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'may', 'might',
  'more', 'most', 'no', 'not', 'of', 'on', 'or', 'our', 'over', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'were', 'which', 'who',
  'will', 'with', 'within', 'without', 'would',
  // High-frequency nexus/medical filler that is topic-neutral in this corpus.
  'patient', 'veteran', 'condition', 'service', 'connected', 'likely', 'risk', 'study', 'studies',
  'finding', 'findings', 'evidence', 'associated', 'association', 'increased', 'due',
]);

/** Tokenize to lowercased alphanumeric word-stems >= 3 chars, stopwords removed. Deterministic. */
export function relevanceTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    // Crude singular fold so "apneas"/"apnea" and "migraines"/"migraine" overlap.
    const stem = raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    // Re-check the stem against stopwords (e.g. "veterans" -> "veteran" is filler too).
    if (STOPWORDS.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

/** Topical overlap between a citation's subject and the target, in [0,1]. We take the BETTER of the
 *  two directional recalls — shared/|cite| and shared/|target| — so neither a terse single-word
 *  target (e.g. the bare condition "tinnitus") nor a short sharply-on-topic title is unfairly
 *  penalized by the other side being longer. A genuinely off-topic pair shares ~nothing either way.
 *  Empty either side → 0. */
export function citationRelevanceScore(citationSubject: string, target: string): number {
  const cite = relevanceTokens(citationSubject);
  const tgt = relevanceTokens(target);
  if (cite.size === 0 || tgt.size === 0) return 0;
  let shared = 0;
  for (const t of cite) if (tgt.has(t)) shared += 1;
  return Math.max(shared / cite.size, shared / tgt.size);
}

// Below this share of the citation's own topical tokens appearing in the target, we surface the
// soft advisory. ~17% — low enough to stay quiet on genuinely-related cites (which usually share the
// condition word + a mechanism term), loud enough to catch a clearly off-topic paste.
export const CITATION_RELEVANCE_THRESHOLD = 0.17;

/** SOFT advisory decision. true ⇒ render "may not support this passage" (never a block). When the
 *  target is empty (no passage/claim/condition to compare against) we DON'T warn — we have nothing to
 *  judge against, and a false alarm is worse than silence. */
export function citationMayBeOffTopic(citationSubject: string, target: string): boolean {
  if (target.trim().length === 0 || citationSubject.trim().length === 0) return false;
  return citationRelevanceScore(citationSubject, target) < CITATION_RELEVANCE_THRESHOLD;
}
