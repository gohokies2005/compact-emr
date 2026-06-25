import { describe, expect, it } from 'vitest';
import {
  holdingChanged,
  hasHoldingConclusion,
  holdingConclusionWeakened,
  sectionViiChanged,
} from '../services/letter-opinion-excerpt.js';

// Guided Revision, 2026-06-13 — the §VII holding lock. The drafter assembles Section VII
// deterministically; a guided revision can NEVER change the "at least as likely as not" conclusion
// even if the highlighted passage overlaps §VII. holdingChanged() is the route's hard reject.

const LETTER = [
  '**I. Physician Qualifications**',
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
  '',
  '**VII. Opinion**',
  '**It is my opinion that the veteran\'s obstructive sleep apnea is at least as likely as not (50 percent or greater probability) caused by his service-connected PTSD, under 38 CFR 3.310.**',
  '',
  'The mechanism is well established in the literature.',
  '',
  '**VIII. References**',
  '1. Smith 2019.',
].join('\n');

describe('§VII holding lock — holdingChanged', () => {
  it('returns false when the holding sentence is unchanged (trivial whitespace reflow ignored)', () => {
    const reflowed = LETTER.replace('caused by his service-connected PTSD,', 'caused by his service-connected PTSD,\n');
    expect(holdingChanged(LETTER, reflowed)).toBe(false);
  });

  it('returns false when an edit changes a NON-§VII paragraph only', () => {
    const edited = LETTER.replace('The mechanism is well established in the literature.', 'The physiologic mechanism is well documented.');
    expect(holdingChanged(LETTER, edited)).toBe(false);
  });

  it('returns TRUE when the conclusion is weakened (at least as likely as not -> less likely than not)', () => {
    const weakened = LETTER.replace('at least as likely as not', 'less likely than not');
    expect(holdingChanged(LETTER, weakened)).toBe(true);
  });

  it('returns TRUE when the CFR cite in the holding is changed', () => {
    const swapped = LETTER.replace('38 CFR 3.310', '38 CFR 3.303');
    expect(holdingChanged(LETTER, swapped)).toBe(true);
  });

  it('returns TRUE when the holding sentence is destroyed/obscured (bias to block)', () => {
    const gutted = LETTER.replace(/\*\*It is my opinion[\s\S]*?3\.310\.\*\*/, 'The opinion is provided above.');
    expect(holdingChanged(LETTER, gutted)).toBe(true);
  });

  it('returns false when the OLD letter has no detectable holding (nothing to protect)', () => {
    const noHolding = 'A letter with no Section VII at all.';
    expect(holdingChanged(noHolding, 'Anything goes here.')).toBe(false);
  });

  it('hasHoldingConclusion detects the probabilistic clause', () => {
    expect(hasHoldingConclusion('it is at least as likely as not')).toBe(true);
    expect(hasHoldingConclusion('more likely than not')).toBe(true);
    expect(hasHoldingConclusion('the patient has back pain')).toBe(false);
  });
});

// ── NARROWED §VII lock — holdingConclusionWeakened (Puller, 2026-06-24) ──────────────────────────
// Protects ONLY the probability conclusion, not the causal phrasing. A causation->aggravation
// rephrase that keeps the >50% holding is ALLOWED; weakening/removing the >50% holding is BLOCKED.

// A letter whose §VII uses the STRONG FRN standard "more likely than not (greater than 50% probability)".
const MLTN_LETTER = [
  '**I. Physician Qualifications**',
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
  '',
  '**VII. Opinion**',
  "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**",
  '',
  'The mechanism is well established in the literature.',
  '',
  '**VIII. References**',
  '1. Smith 2019.',
].join('\n');

describe('§VII holding-conclusion lock — holdingConclusionWeakened (narrowed)', () => {
  it('ALLOWS a causation -> aggravation rephrase that keeps "more likely than not" (the Puller fix)', () => {
    // "caused by ... 3.310(a)" -> "aggravated by ... 3.310(b)" — the causal THEORY changes but the
    // >50% probability conclusion survives word-for-word. The old holdingChanged blocked this (the bug).
    const aggravated = MLTN_LETTER
      .replace('proximately caused by', 'aggravated by')
      .replace('38 CFR 3.310(a)', '38 CFR 3.310(b)');
    expect(holdingConclusionWeakened(MLTN_LETTER, aggravated)).toBe(false);
    // Sanity: the OLD strict lock WOULD have blocked this same edit (proves the narrowing).
    expect(holdingChanged(MLTN_LETTER, aggravated)).toBe(true);
  });

  it('BLOCKS removing the >50% / probability clause entirely', () => {
    const removed = MLTN_LETTER.replace('is more likely than not (greater than 50% probability) proximately caused by', 'is related to');
    expect(holdingConclusionWeakened(MLTN_LETTER, removed)).toBe(true);
  });

  it('BLOCKS a downgrade from "more likely than not" to the weaker "at least as likely as not"', () => {
    const downgraded = MLTN_LETTER
      .replace('more likely than not (greater than 50% probability)', 'at least as likely as not');
    // The new opinion still HAS a conclusion clause, but it dropped below the FRN >50% standard.
    expect(hasHoldingConclusion(downgraded)).toBe(true);
    expect(holdingConclusionWeakened(MLTN_LETTER, downgraded)).toBe(true);
  });

  it('BLOCKS a downgrade to "less likely than not" (below 50%)', () => {
    const below = MLTN_LETTER.replace('more likely than not (greater than 50% probability)', 'less likely than not');
    expect(holdingConclusionWeakened(MLTN_LETTER, below)).toBe(true);
  });

  it('BLOCKS destroying/obscuring the opinion sentence', () => {
    const gutted = MLTN_LETTER.replace(/\*\*It is my opinion[\s\S]*?3\.310\(a\)\.\*\*/, 'The opinion is provided above.');
    expect(holdingConclusionWeakened(MLTN_LETTER, gutted)).toBe(true);
  });

  it('ALLOWS an unchanged letter (trivial reflow ignored)', () => {
    const reflowed = MLTN_LETTER.replace('caused by his', 'caused by his\n');
    expect(holdingConclusionWeakened(MLTN_LETTER, reflowed)).toBe(false);
  });

  it('ALLOWS edits to a NON-§VII paragraph', () => {
    const edited = MLTN_LETTER.replace('The mechanism is well established in the literature.', 'The physiologic mechanism is well documented.');
    expect(holdingConclusionWeakened(MLTN_LETTER, edited)).toBe(false);
  });

  it('returns false when the OLD letter has no detectable holding (nothing to protect)', () => {
    expect(holdingConclusionWeakened('A letter with no Section VII at all.', 'Anything.')).toBe(false);
  });
});

// ── PHYSICIAN-ONLY §VII gate helper — sectionViiChanged (Puller, 2026-06-24) ─────────────────────
describe('sectionViiChanged — physician-only §VII gate detector', () => {
  it('TRUE when the §VII causal verb changes (caused by -> aggravated by)', () => {
    const aggravated = MLTN_LETTER.replace('proximately caused by', 'aggravated by');
    expect(sectionViiChanged(MLTN_LETTER, aggravated)).toBe(true);
  });

  it('FALSE when only a NON-§VII section changes (§I credentials prose)', () => {
    const edited = MLTN_LETTER.replace('board-certified in Family Medicine', 'board-certified in Internal Medicine');
    expect(sectionViiChanged(MLTN_LETTER, edited)).toBe(false);
  });

  it('FALSE for an identical letter (trivial reflow ignored)', () => {
    const reflowed = MLTN_LETTER.replace('caused by his', 'caused by his\n');
    expect(sectionViiChanged(MLTN_LETTER, reflowed)).toBe(false);
  });

  it('TRUE when §VII appears in one letter but not the other (null <-> non-null)', () => {
    expect(sectionViiChanged('No sections at all.', MLTN_LETTER)).toBe(true);
    expect(sectionViiChanged(MLTN_LETTER, 'No sections at all.')).toBe(true);
  });

  it('FALSE when neither letter has a §VII (both null)', () => {
    expect(sectionViiChanged('No sections here.', 'Still no sections.')).toBe(false);
  });
});
