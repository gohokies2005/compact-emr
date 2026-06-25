// Map a raw character offset in a nexus-letter .txt artifact to a HUMAN location — which lettered/
// numbered SECTION header precedes it and the paragraph index within that section (Dr. Kasky
// 2026-06-25: a render-parity halt reads "PDF text diverges from v3.txt at offset 11037" — a raw
// char offset means nothing to an RN; "say where it is. Section ___, paragraph ___"). PURE +
// fail-open: every function returns a usable fallback rather than throwing, so a halt card never
// crashes on a malformed reason or an unfetchable txt.

// The canonical FRN letter section headers are a Roman numeral, a period, then a title on its own
// line — e.g. "VII. Opinion", "VI. Medical Reasoning and Rationale". A handful of letters use bare
// ALL-CAPS headers ("OPINION", "DISCUSSION", "RATIONALE") instead; we recognize both. A header line
// is short (a heading, not prose), so we also length-bound the match to avoid catching a sentence
// that merely starts with a Roman-numeral-looking token.
const ROMAN_HEADER = /^\s*((?:VIII|VII|VI|IV|IX|V|III|II|I|X))\.\s+(.{1,60})$/;
const CAPS_HEADER = /^\s*(OPINION|DISCUSSION|RATIONALE|REFERENCES|METHODOLOGY|QUALIFICATIONS)\b.{0,40}$/i;
// A Roman-numeral line is only a SECTION header if its title is one of the canonical FRN section
// titles. This prevents a prose list item ("I. The veteran reports…", "II. ...") inside §VI/§VIII
// from being mis-read as a section header and producing a CONFIDENTLY-WRONG location (a Roman-numeral
// list label is common in body prose; a real header always carries one of these titles). On no match
// the line is treated as body text, and an unmappable offset fails open to the raw offset string.
const SECTION_TITLE = /(qualification|methodolog|records|history|diagnosis|reasoning|rationale|opinion|reference)/i;

export interface LetterSectionHeader {
  readonly raw: string;        // the header line, trimmed (e.g. "VII. Opinion")
  readonly label: string;      // a display label (e.g. "Section VII", or the caps header title-cased)
  readonly charStart: number;  // char offset where this header line begins in the txt
}

export interface LetterLocation {
  // A human sentence, e.g. "Section VII, paragraph 2" — the LEAD text on the halt card.
  readonly human: string;
  readonly section: LetterSectionHeader | null; // null when no header precedes the offset
  readonly paragraphIndex: number | null;       // 1-based paragraph within the section (null if unknown)
}

/** Extract the section headers from a letter .txt, in document order, each with its char offset. */
export function extractSectionHeaders(txt: string): readonly LetterSectionHeader[] {
  const headers: LetterSectionHeader[] = [];
  if (typeof txt !== 'string' || txt.length === 0) return headers;
  let cursor = 0;
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    // A Roman line only counts as a header when its title is a canonical section title (else it's a
    // prose list item like "I. The veteran...", which must NOT become a phantom "Section I").
    const romanRaw = trimmed.match(ROMAN_HEADER);
    const roman = romanRaw && SECTION_TITLE.test(romanRaw[2] ?? '') ? romanRaw : null;
    const caps = roman ? null : trimmed.match(CAPS_HEADER);
    if (roman) {
      headers.push({ raw: trimmed, label: `Section ${roman[1]}`, charStart: cursor });
    } else if (caps) {
      const word = caps[1]!;
      const titled = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      headers.push({ raw: trimmed, label: `the ${titled} section`, charStart: cursor });
    }
    cursor += line.length + 1; // +1 for the stripped '\n'
  }
  return headers;
}

/**
 * Map a char offset to the nearest preceding section header + the paragraph index within that
 * section. Paragraphs are blank-line-separated blocks AFTER the header line. Fail-open: an
 * out-of-range / NaN offset, or a letter with no headers, returns a best-effort partial result
 * (section may be null) — never throws.
 */
export function mapOffsetToLetterLocation(txt: string, offset: number): LetterLocation {
  const headers = extractSectionHeaders(txt);
  const clamped =
    typeof offset === 'number' && Number.isFinite(offset)
      ? Math.max(0, Math.min(offset, typeof txt === 'string' ? txt.length : 0))
      : 0;

  // The last header at or before the offset is the section the offset falls in.
  let section: LetterSectionHeader | null = null;
  for (const h of headers) {
    if (h.charStart <= clamped) section = h;
    else break;
  }

  if (!section) {
    return { human: 'near the top of the letter', section: null, paragraphIndex: null };
  }

  // Paragraph index within the section: count blank-line-separated blocks between the END of the
  // header line and the offset. The header line itself is paragraph 0; the first body block is 1.
  const sectionBodyStart = section.charStart + section.raw.length;
  const between = txt.slice(Math.min(sectionBodyStart, txt.length), clamped);
  // Paragraphs are blank-line-separated blocks AFTER the header line. Each run of 2+ newlines
  // (allowing intervening whitespace) is the separator that BEGINS a new body paragraph: the first
  // body paragraph starts after the first blank line, so the 1-based paragraph index = the number of
  // blank-line separators between the header and the offset. Floored at 1 when any body text precedes
  // the offset (an offset that sits on the header line itself maps to paragraph 1).
  // CRLF-safe: a \r\n\r\n paragraph break must count too (a bare /\n[ \t]*\n/ misses it because the
  // \r breaks the [ \t]* run), else a CRLF letter mis-counts the paragraph index.
  const breaks = between.match(/\r?\n[ \t]*\r?\n/g);
  const separatorCount = breaks?.length ?? 0;
  const paragraphIndex = between.trim().length > 0 ? Math.max(1, separatorCount) : 1;

  const human =
    paragraphIndex >= 1
      ? `${section.label}, paragraph ${paragraphIndex}`
      : section.label;
  return { human, section, paragraphIndex };
}

// A raw render-parity reason looks like:
//   "render_parity_mismatch: PDF text diverges from v3.txt at offset 11037 — txt:'-driven fixed…'"
// Pull the offset out (and the short snippet, kept for a tooltip). Returns null if this isn't a
// parity/offset reason at all (then the caller leaves the reason untouched).
export interface ParsedParityReason {
  readonly offset: number;
  readonly snippet: string | null; // the txt:'…' snippet, for a secondary tooltip
}

export function parseParityReason(reason: string | null | undefined): ParsedParityReason | null {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  // Must look like a render/parity divergence reason carrying a numeric offset.
  if (!/(diverge|parity|render)/i.test(reason)) return null;
  const m = reason.match(/offset\s+(\d+)/i);
  if (!m) return null;
  const offset = Number(m[1]);
  if (!Number.isFinite(offset)) return null;
  const snip = reason.match(/txt:\s*['"]([^'"]*)['"]/i);
  return { offset, snippet: snip ? snip[1]!.trim() || null : null };
}

/**
 * Given a raw halt reason and the letter txt, produce a HUMAN-led reason for the card. If the
 * reason is a parity/offset reason AND the offset maps into a section, returns e.g.
 *   "A small formatting difference in Section VII, paragraph 2 (a line-wrap). The letter content is unchanged."
 * Fail-open: if the reason isn't a parity reason, or the txt is missing/unmappable, returns the
 * provided fallback (today's offset string) so the card never loses information or crashes.
 */
export interface HumanizedParityReason {
  readonly text: string;        // the LEAD human reason
  readonly rawSnippet: string | null; // the raw txt snippet, for a secondary/tooltip line (null if none)
  readonly mapped: boolean;     // true when we successfully produced a section/paragraph location
}

export function humanizeParityReason(
  rawReason: string | null | undefined,
  txt: string | null | undefined,
  fallback: string,
): HumanizedParityReason {
  const parsed = parseParityReason(rawReason);
  if (!parsed) {
    return { text: fallback, rawSnippet: null, mapped: false };
  }
  // We have an offset. If we also have the txt, map it to a section/paragraph.
  if (typeof txt === 'string' && txt.trim().length > 0) {
    const loc = mapOffsetToLetterLocation(txt, parsed.offset);
    if (loc.section) {
      return {
        text: `A small formatting difference in ${loc.human} (a line-wrap). The letter content is unchanged.`,
        rawSnippet: parsed.snippet,
        mapped: true,
      };
    }
  }
  // Offset known but no txt / no header before it: still better than a raw code string — say it's a
  // formatting difference and keep the raw offset available as the snippet.
  return {
    text: 'A small formatting difference in the PDF (a line-wrap). The letter content is unchanged.',
    rawSnippet: parsed.snippet ?? `offset ${parsed.offset}`,
    mapped: false,
  };
}
