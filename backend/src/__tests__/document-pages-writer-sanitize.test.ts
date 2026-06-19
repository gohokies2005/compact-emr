import { describe, it, expect } from 'vitest';
import { stripPgUnsafeChars } from '../services/document-pages-writer.js';

const NUL = String.fromCharCode(0); // 0x00
const VT = String.fromCharCode(0x0b); // vertical tab
const FF = String.fromCharCode(0x0c); // form feed
const ESC = String.fromCharCode(0x1b); // escape

// Regression: a born-digital PDF (Apolito's ~900-page Blue Button, 2026-06-18) carried a NUL byte in
// its native text layer. Postgres `text` columns reject 0x00 (SQLSTATE 22021: "invalid byte sequence
// for encoding UTF8: 0x00"), so the documentPage write rolled back, the /pages callback 500'd, the OCR
// job dead-lettered after 3 retries, and the file sat at 0 pages — freezing the entire case at intake.
describe('stripPgUnsafeChars (NUL/control-char sanitizer for Postgres)', () => {
  it('removes the NUL byte that broke the Postgres write (the proven Apolito failure)', () => {
    const withNul = `Sleep study: AHI 22${NUL} (moderate OSA)`;
    expect(withNul.includes(NUL)).toBe(true); // RED condition: the raw text contains 0x00
    const clean = stripPgUnsafeChars(withNul);
    expect(clean.includes(NUL)).toBe(false);
    expect(clean).toBe('Sleep study: AHI 22 (moderate OSA)');
  });

  it('strips other C0 control chars (vertical tab, form feed, escape) that Postgres also dislikes', () => {
    const messy = `Diagnosis:${VT}Hypertension${FF}${ESC} end`;
    const clean = stripPgUnsafeChars(messy);
    expect(clean).toBe('Diagnosis:Hypertension end');
  });

  it('PRESERVES tab, newline, and carriage return (real record structure)', () => {
    const structured = 'Line one\nLine two\r\n\tIndented value';
    expect(stripPgUnsafeChars(structured)).toBe(structured);
  });

  it('leaves ordinary clinical text untouched (incl. unicode like the µ in 25 µg)', () => {
    const ok = 'Levothyroxine 25 µg daily; BP 130/85 mmHg.';
    expect(stripPgUnsafeChars(ok)).toBe(ok);
  });

  it('handles empty string', () => {
    expect(stripPgUnsafeChars('')).toBe('');
  });
});
