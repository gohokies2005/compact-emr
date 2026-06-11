/**
 * §VII (Opinion) + §VIII (References) excerpt extractor for the delivery email.
 *
 * The delivery email shows the veteran ONLY the final bolded opinion sentence (Section VII) plus
 * the reference list (Section VIII) — never the condition name in the surrounding email prose, and
 * never the full clinical letter (that arrives as the signed PDF after payment). This mirrors the
 * local FRN gmail.js Template-4 invoice excerpt (app/services/gmail.js ~lines 314-323).
 *
 * THE ANCHOR GOTCHA (Peppers 2026-05-18 incident, ported verbatim): a naive regex that matches the
 * first double-asterisk bold pair grabs the FIRST bold block in the letter, which in every FRN nexus
 * letter is the Section I header (the bolded "I. Physician Qualifications") so the invoice showed
 * "My opinion: I. Physician Qualifications". We must anchor PAST the "VII. Opinion" header
 * (consuming any trailing bold marker of a bolded header) and take the first bold pair in what
 * remains.
 *
 * Pure + dependency-free so it unit-tests without S3/Prisma. Never throws: a letter that does not
 * match the expected shape yields { opinion: null, references: [] } and the caller degrades to a
 * generic "your full opinion and sources are in the attached letter" line.
 */

export interface OpinionExcerpt {
  /** The Section VII bolded opinion sentence, whitespace-collapsed. null if not found. */
  readonly opinion: string | null;
  /**
   * The FULL Section VII prose (bold sentence + its supporting paragraphs, ** stripped), or null.
   * Chunk E1 (work-order 5a-bis): Ryan wants the email excerpt to carry the whole opinion section,
   * not just the bolded line. The condition MAY appear inside this quoted letter text — that is
   * acceptable (decision E-1); only the email's OWN framing prose must stay condition-free.
   */
  readonly opinionFull: string | null;
  /** Section VIII reference lines, in order. Empty if not found. */
  readonly references: readonly string[];
  /** A ready-to-embed text block (labeled), or null if NOTHING was extractable. */
  readonly block: string | null;
}

// Section VII header in canonical FRN letters: "VII. Opinion". Tolerate optional roman-numeral
// trailing period, optional "Section " prefix, and a bolded header (** on either side).
const SECTION_VII_RE = /(?:\*\*\s*)?(?:Section\s+)?VII\.\s*Opinion/i;
// Section VIII header: "VIII. References" (also "Section VIII" / bolded).
const SECTION_VIII_RE = /(?:\*\*\s*)?(?:Section\s+)?VIII\.\s*(?:References|Bibliography)/i;

/** Extract the Section VII bolded opinion sentence. Returns null if not found. */
export function extractOpinionSentence(letterText: string): string | null {
  if (typeof letterText !== 'string' || letterText.trim() === '') return null;
  const m7 = SECTION_VII_RE.exec(letterText);
  if (m7 === null) return null;
  // Slice from the start of the VII header, then strip the header itself (including any trailing
  // `**` that closed a bolded header) so the FIRST **...** pair we find is the opinion, not the
  // header. Bound the search to before Section VIII if present (defensive).
  let after = letterText.slice(m7.index);
  const m8inAfter = SECTION_VIII_RE.exec(after);
  if (m8inAfter !== null) after = after.slice(0, m8inAfter.index);
  after = after.replace(SECTION_VII_RE, '').replace(/^\s*\*{0,2}/, '');
  const bold = /\*\*([\s\S]+?)\*\*/.exec(after);
  if (bold === null) return null;
  const opinion = bold[1].replace(/\s+/g, ' ').trim();
  // Guard against a degenerate match (e.g. an empty bold pair). A real opinion sentence is long.
  return opinion.length >= 20 ? opinion : null;
}

/**
 * Extract the FULL Section VII prose: the bolded opinion sentence PLUS the supporting paragraph(s)
 * that follow it, stopping BEFORE the Section VIII header. `**` markers are stripped and each
 * paragraph is whitespace-normalized (paragraph breaks preserved as one blank line). Honors the
 * ANCHOR GOTCHA above: the slice anchors PAST the "VII. Opinion" header so the header itself never
 * leaks into the excerpt. Returns null when no Section VII is found or the section is degenerate.
 */
export function extractOpinionFull(letterText: string): string | null {
  if (typeof letterText !== 'string' || letterText.trim() === '') return null;
  const m7 = SECTION_VII_RE.exec(letterText);
  if (m7 === null) return null;
  // Same anchor-past-the-header slice as extractOpinionSentence (lines above): slice at the VII
  // header, bound at the VIII header, then strip the header + any trailing bold marker it carried.
  let after = letterText.slice(m7.index);
  const m8inAfter = SECTION_VIII_RE.exec(after);
  if (m8inAfter !== null) {
    after = after.slice(0, m8inAfter.index);
  } else {
    // No §VIII (non-canonical letter): bound at the signature/closing block instead, the same
    // stop-guard extractReferences uses — otherwise the signer's name + NPI would be quoted into
    // the veteran's invoice email as "opinion" prose.
    const stop = /\n\s*(?:Respectfully submitted|Sincerely|\[SIGNATURE)/i.exec(after);
    if (stop !== null) after = after.slice(0, stop.index);
  }
  after = after.replace(SECTION_VII_RE, '').replace(/^\s*\*{0,2}/, '');
  // Strip bold markers, then normalize whitespace PER PARAGRAPH (blank-line-separated) so the
  // prose reflows cleanly in a plain-text email while keeping its paragraph structure.
  const paragraphs = after
    .replace(/\*\*/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  const full = paragraphs.join('\n\n');
  // Same degenerate-match guard as the sentence extractor: a real opinion section is long.
  return full.length >= 20 ? full : null;
}

/** Extract the Section VIII reference lines (numbered or bulleted), in order. */
export function extractReferences(letterText: string): readonly string[] {
  if (typeof letterText !== 'string' || letterText.trim() === '') return [];
  const m8 = SECTION_VIII_RE.exec(letterText);
  if (m8 === null) return [];
  let body = letterText.slice(m8.index).replace(SECTION_VIII_RE, '');
  // Stop at a signature/closing block if one follows the references (defensive — references are
  // usually last, but a cover/signature could trail).
  const stop = /\n\s*(?:Respectfully submitted|Sincerely|\[SIGNATURE)/i.exec(body);
  if (stop !== null) body = body.slice(0, stop.index);
  // FRN house style: Section VIII is a NUMBERED list (every entry starts with "<N>. ").
  // Capture each numbered entry; fall back to non-empty lines if unnumbered.
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 0);
  const numbered = lines.filter((l) => /^\d+\.\s+/.test(l));
  const source = numbered.length > 0 ? numbered : lines;
  // Drop a leftover header word ("References") if it slipped through as its own line.
  return source.filter((l) => !/^(references|bibliography)\s*:?\s*$/i.test(l));
}

/**
 * Build the labeled excerpt block for the delivery email. The label is fixed and never names the
 * condition (and carries no em dash — veteran-facing email prose hard rule). The Opinion block is
 * the FULL Section VII (E1); the bolded sentence alone remains available via `opinion`.
 * Returns null only when neither the opinion nor any reference could be extracted.
 */
export function buildOpinionExcerpt(letterText: string): OpinionExcerpt {
  const opinion = extractOpinionSentence(letterText);
  const opinionFull = extractOpinionFull(letterText);
  const references = extractReferences(letterText);
  if (opinion === null && opinionFull === null && references.length === 0) {
    return { opinion: null, opinionFull: null, references: [], block: null };
  }
  const parts: string[] = [
    'The final opinion and sources from your full letter, excerpted below:',
    '',
  ];
  const opinionText = opinionFull ?? opinion;
  if (opinionText !== null) {
    parts.push('Opinion:', `"${opinionText}"`, '');
  }
  if (references.length > 0) {
    parts.push('References:', ...references, '');
  }
  return { opinion, opinionFull, references, block: parts.join('\n').trimEnd() };
}
