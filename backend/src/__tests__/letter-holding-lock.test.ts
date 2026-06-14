import { describe, expect, it } from 'vitest';
import { holdingChanged, hasHoldingConclusion } from '../services/letter-opinion-excerpt.js';

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
