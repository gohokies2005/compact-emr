/**
 * letter-leak-detector.ts — deterministic detector for content that must NEVER appear in a
 * veteran-facing nexus letter. The CLOUD drafter skips the full publish-linter gate, so these
 * leaks (LLM editing/meta commentary + database IDs) shipped straight to physician review and
 * would get a letter tossed as obviously machine-made (Ryan 2026-06-20, 3 live cases in one day):
 *   - Apolito: Section III replaced by "Restructure as a numbered list… canonical format…"
 *   - Zodrow: Section VII carried "If the canonical Section VII template… rewrite as…"
 *   - Girot:  "(PMID 35609941)" inline in the Section VI body.
 *
 * This runs as a HARD gate at the live enforcement point (the EMR letter approve/deliver path)
 * AND as a drafter-pipeline tripwire. Deterministic, no LLM, zero false-positive tolerance on the
 * tokens below — none has a legitimate place in a nexus letter. NEVER auto-patch the section away
 * (the real content was destroyed); a hit means re-draft that section.
 */

export type LeakSeverity = 'block' | 'warn';

export interface LetterLeak {
  readonly code: string;
  readonly match: string;   // the offending snippet (for the RN-facing reason)
  readonly note: string;
  readonly severity: LeakSeverity;
}

// severity: 'block' = NEVER valid in a letter, hard-blocks delivery (LLM editing/meta-commentary).
// 'warn' = surfaced but does NOT block (a stray database ID — annoying, not letter-killing, and PMIDs
// are LEGITIMATE in Section VIII references, so they must NEVER stop a signature; Ryan 2026-06-20).
// The blocking set is deliberately CONSERVATIVE — only the highest-confidence editorial markers — so
// it cannot false-block a real letter. We do NOT flag the legit Section VII "in the alternative"
// dual-prong phrase; only the META/instruction wrappers around it.
const LEAK_RULES: ReadonlyArray<{ code: string; re: RegExp; note: string; severity: LeakSeverity }> = [
  // LLM editing/meta-commentary — the catastrophic class. HARD BLOCK.
  { code: 'meta_canonical', re: /\bcanonical\b/i, note: 'the word "canonical" (internal style term)', severity: 'block' },
  { code: 'meta_locked_template', re: /\blocked template\b|\btemplate includes\b|\bthe (?:section [ivx]+ )?template\b/i, note: 'references an internal "template" (editing meta-commentary)', severity: 'block' },
  { code: 'meta_restructure', re: /\b(?:restructure|rewrite|reformat)\s+(?:as|this|the\s+(?:section|letter|opinion)|it)\b/i, note: 'an editing instruction ("restructure/rewrite as…")', severity: 'block' },
  { code: 'meta_retain_exact', re: /\bretain only the exact\b/i, note: 'an editing instruction ("retain only the exact…")', severity: 'block' },
  { code: 'meta_flagged_section', re: /\b(?:is|are)\s+(?:technically\s+)?flagged in section/i, note: 'meta-commentary about section formatting rules', severity: 'block' },
  { code: 'meta_conditional_instruction', re: /\bif\s+(?:the\s+)?(?:canonical|locked|'?in the alternative'?)\b[^.]*\b(?:rewrite|retain|template|include)/i, note: 'a conditional editing instruction ("if the … template … rewrite …")', severity: 'block' },
  // Database IDs — out of place in the letter body, but LEGITIMATE in Section VIII references, so
  // WARN only — NEVER block a signature over a PMID (Ryan 2026-06-20).
  { code: 'inline_pmid', re: /\bPMID\b\s*:?\s*\d{5,9}/i, note: 'a PMID identifier (fine in the references section; check it is not in the body)', severity: 'warn' },
  { code: 'inline_doi', re: /\bdoi:\s*10\.\d{4,}/i, note: 'a DOI identifier (fine in the references section; check it is not in the body)', severity: 'warn' },
];

/**
 * Scan a letter for leak content. Returns every distinct leak found (deduped by code). Pure.
 * Empty array = clean. A non-empty result MUST block delivery — re-draft the affected section.
 */
export function detectLetterLeaks(letterText: string): LetterLeak[] {
  if (typeof letterText !== 'string' || letterText.length === 0) return [];
  const found: LetterLeak[] = [];
  const seen = new Set<string>();
  for (const rule of LEAK_RULES) {
    const m = rule.re.exec(letterText);
    if (m && !seen.has(rule.code)) {
      seen.add(rule.code);
      const idx = m.index;
      const snippet = letterText.slice(Math.max(0, idx - 30), idx + m[0].length + 40).replace(/\s+/g, ' ').trim();
      found.push({ code: rule.code, match: snippet, note: rule.note, severity: rule.severity });
    }
  }
  return found;
}

/** Only the leaks that must HARD-block delivery (severity 'block'). PMIDs/DOIs (warn) never block. */
export function blockingLeaks(leaks: readonly LetterLeak[]): LetterLeak[] {
  return leaks.filter((l) => l.severity === 'block');
}

/** Convenience: one plain-language line naming what leaked, for the RN/physician block message. */
export function describeLetterLeaks(leaks: readonly LetterLeak[]): string {
  if (leaks.length === 0) return '';
  return `This letter contains content that must never appear in a nexus letter and was blocked from delivery: ${leaks
    .map((l) => `${l.note} ("…${l.match}…")`)
    .join('; ')}. The affected section needs to be re-drafted.`;
}
