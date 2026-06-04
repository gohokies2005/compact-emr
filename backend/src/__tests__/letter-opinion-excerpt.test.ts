import { describe, expect, it } from 'vitest';
import {
  buildOpinionExcerpt,
  extractOpinionSentence,
  extractReferences,
} from '../services/letter-opinion-excerpt.js';

// A representative FRN nexus letter: a BOLDED Section I header (the "anchor gotcha" trap), the
// §VII bolded opinion, and a numbered §VIII reference list.
const LETTER = [
  'RE: Independent Medical Opinion',
  'Veteran: Armand Frank',
  'Condition: Obstructive Sleep Apnea (ICD-10 G47.33)',
  '',
  '**I. Physician Qualifications**',
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine through the ABOFP.',
  '',
  'VII. Opinion',
  'It is my independent medical opinion that **the veteran\'s obstructive sleep apnea is more likely than not (greater than 50% probability) proximately due to his service-connected major depressive disorder.**',
  'This opinion is supported by the mechanism and epidemiology discussed above.',
  '',
  'VIII. References',
  '1. Gupta MA, Simpson FC. Obstructive sleep apnea and psychiatric disorders. J Clin Sleep Med. 2015;11(2):165-175.',
  '2. Ohayon MM. The effects of breathing-related sleep disorders on mood. J Clin Psychiatry. 2003;64(10):1195-1200.',
  '',
  'Respectfully submitted,',
  'Ryan J. Kasky, DO',
].join('\n');

describe('letter-opinion-excerpt', () => {
  it('extracts the §VII opinion (anchored PAST the bolded Section I header)', () => {
    const op = extractOpinionSentence(LETTER);
    expect(op).not.toBeNull();
    expect(op).toContain('more likely than not (greater than 50% probability)');
    // The anchor gotcha: must NOT grab the Section I bold header.
    expect(op).not.toContain('Physician Qualifications');
  });

  it('extracts the numbered §VIII references in order, stopping before the signature', () => {
    const refs = extractReferences(LETTER);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatch(/^1\. Gupta MA/);
    expect(refs[1]).toMatch(/^2\. Ohayon MM/);
    expect(refs.some((r) => /Respectfully submitted|Kasky/.test(r))).toBe(false);
  });

  it('builds a labeled excerpt block (opinion + references), never the full letter', () => {
    const { block, opinion, references } = buildOpinionExcerpt(LETTER);
    expect(block).toContain('The final opinion and sources from your full letter — an excerpt:');
    expect(block).toContain('Opinion:');
    expect(block).toContain('References:');
    expect(opinion).not.toBeNull();
    expect(references).toHaveLength(2);
    // It must NOT contain Section I / IV clinical prose.
    expect(block).not.toContain('Physician Qualifications');
  });

  it('degrades to null on a letter that does not match the expected shape', () => {
    const { block, opinion, references } = buildOpinionExcerpt('Just some text with no sections.');
    expect(opinion).toBeNull();
    expect(references).toHaveLength(0);
    expect(block).toBeNull();
  });
});
