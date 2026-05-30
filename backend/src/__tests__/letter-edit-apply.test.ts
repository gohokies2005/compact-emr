import { describe, it, expect } from 'vitest';
import { applyStructuredEdit } from '../services/letter-edit-apply.js';

const NIEVES = 'See Nieves-Rodriguez v. Peake, 22 Vet. App. 295 (2008).';
const SAMPLE = [
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
  'I have no treatment relationship with this veteran.',
  '',
  `An in-person exam is not required. ${NIEVES}`,
  '',
  '**VII.**',
  '',
  'The veteran has lumbosacral strain. The strain is documented. An alternative etiology is degenerative change.',
].join('\n');

describe('applyStructuredEdit', () => {
  it('exact replace applies', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newText).toContain('lumbosacral strain (DC 5237)');
  });

  it('insert_after applies', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'insert_after', anchor_text: 'The strain is documented.', new_text: 'It is chronic.' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newText).toContain('The strain is documented. It is chronic.');
  });

  it('anchor not found → error', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: 'NOT IN THE TEXT AT ALL', new_text: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/anchor_text not found/);
  });

  it('REFUSES an edit that deletes a locked block (Nieves dropped from new_text)', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: `An in-person exam is not required. ${NIEVES}`, new_text: 'An in-person exam is not required.' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/locked block/);
  });

  it('ALLOWS an edit whose anchor includes a locked block but new_text preserves it verbatim', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: `An in-person exam is not required. ${NIEVES}`, new_text: `A record review suffices. ${NIEVES}` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newText).toContain(NIEVES);
  });

  it('REFUSES new_text with a bracketed placeholder token', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: 'degenerative change', new_text: 'degenerative change [VERIFY PMID: Smith 2020]' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/scaffolding token/);
  });

  it('auto-cleans em dashes in new_text', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: 'The strain is documented.', new_text: 'The strain is chronic — and well documented.' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newText).not.toContain('—');
      expect(r.newText).toContain('chronic, and well documented');
    }
  });

  it('header-rename fallback: "**VII.**" → "**VII. Opinion**" when only the bare header exists', () => {
    const r = applyStructuredEdit(SAMPLE, { operation: 'replace', anchor_text: '**VII.**\n\n(hallucinated continuation the LLM appended)', new_text: '**VII. Opinion**\n\n(hallucinated continuation)' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newText).toContain('**VII. Opinion**');
      expect(r.anchor_fallback).toMatch(/header_rename/);
    }
  });
});
