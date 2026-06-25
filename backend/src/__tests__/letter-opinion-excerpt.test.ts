import { describe, expect, it } from 'vitest';
import {
  buildOpinionExcerpt,
  extractOpinionFull,
  extractOpinionSentence,
  extractReferences,
  hasHoldingConclusion,
  holdingConclusionWeakened,
} from '../services/letter-opinion-excerpt.js';

// A representative FRN nexus letter: a BOLDED Section I header (the "anchor gotcha" trap), the
// §VII bolded opinion + supporting paragraphs, and a numbered §VIII reference list.
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
  'The supporting literature demonstrates a strong bidirectional relationship,',
  'with prevalence estimates well above population baseline.',
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
    expect(block).toContain('The final opinion and sources from your full letter, excerpted below:');
    expect(block).toContain('Opinion:');
    expect(block).toContain('References:');
    expect(opinion).not.toBeNull();
    expect(references).toHaveLength(2);
    // It must NOT contain Section I / IV clinical prose.
    expect(block).not.toContain('Physician Qualifications');
  });

  it('degrades to null on a letter that does not match the expected shape', () => {
    const { block, opinion, opinionFull, references } = buildOpinionExcerpt('Just some text with no sections.');
    expect(opinion).toBeNull();
    expect(opinionFull).toBeNull();
    expect(references).toHaveLength(0);
    expect(block).toBeNull();
  });

  // ── E1: full Section VII extraction ────────────────────────────────────────────────────────────
  describe('extractOpinionFull (E1: bold sentence + supporting paragraphs)', () => {
    it('returns the bolded sentence PLUS the following paragraphs, ** stripped', () => {
      const full = extractOpinionFull(LETTER);
      expect(full).not.toBeNull();
      // The bolded opinion sentence is present, with the ** markers stripped.
      expect(full).toContain('more likely than not (greater than 50% probability)');
      expect(full).not.toContain('**');
      // The supporting paragraphs follow.
      expect(full).toContain('This opinion is supported by the mechanism and epidemiology discussed above.');
      expect(full).toContain('strong bidirectional relationship');
    });

    it('stops BEFORE Section VIII (no references leak into the opinion)', () => {
      const full = extractOpinionFull(LETTER);
      expect(full).not.toContain('References');
      expect(full).not.toContain('Gupta MA');
    });

    it('whitespace-normalizes per paragraph, preserving paragraph breaks', () => {
      const full = extractOpinionFull(LETTER)!;
      // The two-line supporting paragraph reflows to one line; paragraphs separated by one blank line.
      expect(full).toContain('strong bidirectional relationship, with prevalence estimates');
      const paragraphs = full.split('\n\n');
      expect(paragraphs.length).toBe(2);
    });

    it('honors the ANCHOR GOTCHA: never returns the Section I header or its prose', () => {
      const full = extractOpinionFull(LETTER);
      expect(full).not.toContain('Physician Qualifications');
      expect(full).not.toContain('board-certified');
      expect(full).not.toMatch(/^VII\.?\s*Opinion/i);
    });

    it('returns null when the letter has no Section VII', () => {
      expect(extractOpinionFull('No sections here at all.')).toBeNull();
      expect(extractOpinionFull('')).toBeNull();
    });

    it('handles a BOLDED §VII header without leaking the header', () => {
      const bolded = LETTER.replace('VII. Opinion', '**VII. Opinion**');
      const full = extractOpinionFull(bolded);
      expect(full).not.toBeNull();
      expect(full).not.toMatch(/VII\.?\s*Opinion/);
      expect(full).toContain('more likely than not');
    });

    it('stops at the signature block when the letter has no §VIII (signer name/NPI never quoted)', () => {
      // Non-canonical letter: §VII is the LAST section, followed directly by the signature block.
      const viiStart = LETTER.search(/VII\.\s*Opinion/);
      const viiiStart = LETTER.search(/VIII\.\s*References/);
      const noViii =
        LETTER.slice(0, viiiStart) +
        '\nRespectfully submitted,\n[SIGNATURE IMAGE]\nRyan J. Kasky, DO\nNPI: 1073018958\n';
      expect(viiStart).toBeGreaterThan(-1);
      const full = extractOpinionFull(noViii);
      expect(full).not.toBeNull();
      expect(full).toContain('more likely than not');
      expect(full).not.toMatch(/Respectfully submitted/i);
      expect(full).not.toContain('NPI');
      expect(full).not.toContain('Kasky');
    });
  });

  it('buildOpinionExcerpt uses the FULL §VII in the Opinion block (E1)', () => {
    const { block, opinionFull } = buildOpinionExcerpt(LETTER);
    expect(opinionFull).not.toBeNull();
    expect(block).toContain('This opinion is supported by the mechanism and epidemiology discussed above.');
    // References remain their OWN block, after the opinion.
    expect(block!.indexOf('References:')).toBeGreaterThan(block!.indexOf('Opinion:'));
  });

  it('the excerpt label (the email\'s own prose) carries no em dash', () => {
    const { block } = buildOpinionExcerpt(LETTER);
    const label = block!.split('\n')[0];
    expect(label).not.toMatch(/[—–]/);
  });

  // ── FIX C regression (Puller, 2026-06-25): the CANONICAL drafter §VII shape ─────────────────────
  // The drafter emits an UNbolded "VII. Opinion" header, a blank line, then a **bolded** opinion
  // sentence. The opinion's CLOSING `**` sits on the line directly above "VIII. References" (one
  // blank line between). Two bugs combined to return null on this shape:
  //   1) SECTION_VIII_RE's greedy `(?:\*\*\s*)?` prefix swallowed the opinion's CLOSING `**` when the
  //      §VII region was bounded before §VIII, leaving an ODD number of `**` markers;
  //   2) the old header strip `replace(/^\s*\*{0,2}/, '')` ate the opinion's OPENING `**`.
  // Either left the bold-pair extractor matching nothing → extractOpinionSentence === null → the
  // §VII holding lock (holdingConclusionWeakened) silently returned false (the lock was DEAD).
  const CANONICAL_DRAFTER_LETTER = [
    'RE: Independent Medical Opinion',
    '',
    'I. Physician Qualifications',
    'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
    '',
    'VII. Opinion',
    '',
    "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**",
    '',
    'VIII. References',
    '1. Smith 2019.',
  ].join('\n');

  describe('canonical drafter §VII shape (unbolded header + bolded opinion) — FIX C', () => {
    it('extractOpinionSentence returns the FULL opinion sentence (was null pre-fix)', () => {
      const op = extractOpinionSentence(CANONICAL_DRAFTER_LETTER);
      expect(op).not.toBeNull();
      expect(op).toContain('more likely than not (greater than 50% probability)');
      expect(op).toContain('38 CFR 3.310(a)');
      // The closing ** was being eaten by the §VIII boundary prefix — the sentence must be COMPLETE.
      expect(op!.endsWith('3.310(a).')).toBe(true);
      expect(op).not.toContain('**');
    });

    it('hasHoldingConclusion is true on the extracted opinion (lock has material to act on)', () => {
      const op = extractOpinionSentence(CANONICAL_DRAFTER_LETTER)!;
      expect(hasHoldingConclusion(op)).toBe(true);
    });

    it('holdingConclusionWeakened ALLOWS a causation->aggravation rewrite that keeps >50%', () => {
      const aggravated = CANONICAL_DRAFTER_LETTER
        .replace('proximately caused by', 'aggravated by')
        .replace('38 CFR 3.310(a)', '38 CFR 3.310(b)');
      // The lock is alive now (was dead → always false pre-fix), and it correctly ALLOWS the rewrite.
      expect(holdingConclusionWeakened(CANONICAL_DRAFTER_LETTER, aggravated)).toBe(false);
    });

    it('holdingConclusionWeakened BLOCKS a downgrade to "at least as likely as not"', () => {
      const downgraded = CANONICAL_DRAFTER_LETTER
        .replace('more likely than not (greater than 50% probability)', 'at least as likely as not');
      expect(holdingConclusionWeakened(CANONICAL_DRAFTER_LETTER, downgraded)).toBe(true);
    });

    it('extractOpinionFull also returns the bolded opinion (not null) on this shape', () => {
      const full = extractOpinionFull(CANONICAL_DRAFTER_LETTER);
      expect(full).not.toBeNull();
      expect(full).toContain('more likely than not (greater than 50% probability)');
      expect(full).not.toContain('**');
      expect(full).not.toContain('Gupta');
      expect(full).not.toContain('References');
    });
  });
});
