import { describe, it, expect } from 'vitest';
import {
  extractSectionHeaders,
  mapOffsetToLetterLocation,
  parseParityReason,
  humanizeParityReason,
} from '../lib/letterLocation';

// A small canonical-shaped letter with Roman-numeral section headers + blank-line-separated paragraphs.
const LETTER = [
  'May 30, 2026',
  '',
  'Re: Independent Medical Opinion',
  '',
  'VI. Medical Reasoning and Rationale',
  '',
  'First paragraph of the reasoning section.', // para 1 of VI
  '',
  'Second paragraph — driven fixed narrowing. The VA/DoD records support this.', // para 2 of VI
  '',
  'VII. Opinion',
  '',
  'It is my independent medical opinion that the condition is at least as likely as not.', // para 1 of VII
].join('\n');

describe('extractSectionHeaders', () => {
  it('finds the Roman-numeral headers in document order with offsets', () => {
    const headers = extractSectionHeaders(LETTER);
    expect(headers.map((h) => h.label)).toEqual(['Section VI', 'Section VII']);
    // The offsets must point at the start of the header line in the txt.
    expect(LETTER.slice(headers[0]!.charStart, headers[0]!.charStart + 2)).toBe('VI');
    expect(LETTER.slice(headers[1]!.charStart, headers[1]!.charStart + 3)).toBe('VII');
  });

  it('recognizes bare ALL-CAPS headers (OPINION / DISCUSSION)', () => {
    const headers = extractSectionHeaders('OPINION\n\nThe opinion text.\n\nDISCUSSION\n\nMore.');
    expect(headers.map((h) => h.label)).toEqual(['the Opinion section', 'the Discussion section']);
  });

  it('returns [] for empty / non-string input (fail-open)', () => {
    expect(extractSectionHeaders('')).toEqual([]);
    expect(extractSectionHeaders(undefined as unknown as string)).toEqual([]);
  });
});

describe('mapOffsetToLetterLocation', () => {
  it('maps an offset in VII paragraph 1 → "Section VII, paragraph 1"', () => {
    const offset = LETTER.indexOf('It is my independent');
    const loc = mapOffsetToLetterLocation(LETTER, offset);
    expect(loc.section?.label).toBe('Section VII');
    expect(loc.paragraphIndex).toBe(1);
    expect(loc.human).toBe('Section VII, paragraph 1');
  });

  it('maps an offset in VI paragraph 2 → "Section VI, paragraph 2"', () => {
    const offset = LETTER.indexOf('driven fixed narrowing');
    const loc = mapOffsetToLetterLocation(LETTER, offset);
    expect(loc.section?.label).toBe('Section VI');
    expect(loc.paragraphIndex).toBe(2);
    expect(loc.human).toBe('Section VI, paragraph 2');
  });

  it('an offset before any header → "near the top of the letter" (fail-open, section null)', () => {
    const loc = mapOffsetToLetterLocation(LETTER, 3);
    expect(loc.section).toBeNull();
    expect(loc.human).toBe('near the top of the letter');
  });

  it('clamps NaN / out-of-range offsets without throwing', () => {
    expect(() => mapOffsetToLetterLocation(LETTER, NaN)).not.toThrow();
    expect(() => mapOffsetToLetterLocation(LETTER, 9_999_999)).not.toThrow();
    // A huge offset lands in the last section.
    expect(mapOffsetToLetterLocation(LETTER, 9_999_999).section?.label).toBe('Section VII');
  });
});

describe('parseParityReason', () => {
  it('extracts the offset + snippet from the real reason string', () => {
    const p = parseParityReason(
      "render_parity_mismatch: PDF text diverges from v3.txt at offset 11037 — txt:'-driven fixed narrowing. the va/dod...'",
    );
    expect(p?.offset).toBe(11037);
    expect(p?.snippet).toBe('-driven fixed narrowing. the va/dod...');
  });

  it('returns null for a non-parity reason', () => {
    expect(parseParityReason('A citation could not be verified')).toBeNull();
    expect(parseParityReason(null)).toBeNull();
    expect(parseParityReason('parity but no number here')).toBeNull();
  });
});

describe('humanizeParityReason', () => {
  it('maps the parity reason offset → a human Section/paragraph sentence when txt is available', () => {
    const offset = LETTER.indexOf('driven fixed narrowing');
    const raw = `render_parity_mismatch: PDF text diverges from v3.txt at offset ${offset} — txt:'driven fixed narrowing'`;
    const h = humanizeParityReason(raw, LETTER, raw);
    expect(h.mapped).toBe(true);
    expect(h.text).toBe('A small formatting difference in Section VI, paragraph 2 (a line-wrap). The letter content is unchanged.');
    expect(h.rawSnippet).toBe('driven fixed narrowing');
  });

  it('FAIL-OPEN: returns the provided fallback verbatim when the reason is not a parity reason', () => {
    const fallback = 'A citation could not be verified — confirm it is real or remove it.';
    const h = humanizeParityReason(fallback, LETTER, fallback);
    expect(h.mapped).toBe(false);
    expect(h.text).toBe(fallback);
  });

  it('FAIL-OPEN: parity reason but NO txt → generic formatting sentence (never the raw code string as lead)', () => {
    const raw = 'render_parity_mismatch: PDF text diverges from v3.txt at offset 11037 — txt:\'x\'';
    const h = humanizeParityReason(raw, null, raw);
    expect(h.mapped).toBe(false);
    expect(h.text).toMatch(/small formatting difference/i);
    expect(h.text).not.toMatch(/offset|diverge|v3\.txt/i);
  });
});
