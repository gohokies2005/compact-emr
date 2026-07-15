import { describe, it, expect } from 'vitest';
import { isGenericClaimLabel, isInvalidClaimLabel } from './generic-claim-label.js';

describe('isGenericClaimLabel', () => {
  it('flags the Jotform "Other …" dropdown catch-alls (the Drummond case)', () => {
    expect(isGenericClaimLabel('Other Joint (shoulder, Hip, Ankle, Elbow, Wrist)')).toBe(true);
    expect(isGenericClaimLabel('Other')).toBe(true);
    expect(isGenericClaimLabel('Other Condition')).toBe(true);
    expect(isGenericClaimLabel('other joint')).toBe(true);
  });

  it('flags a multi-option parenthetical list even without "Other"', () => {
    expect(isGenericClaimLabel('Joint condition (knee, hip, ankle)')).toBe(true);
  });

  it('does NOT flag a specific diagnosis (the ~90% easy case)', () => {
    expect(isGenericClaimLabel('Obstructive sleep apnea')).toBe(false);
    expect(isGenericClaimLabel('OSA')).toBe(false);
    expect(isGenericClaimLabel('Left shoulder rotator cuff tendinosis with impingement')).toBe(false);
    expect(isGenericClaimLabel('Lumbar degenerative disc disease with radiculopathy')).toBe(false);
    expect(isGenericClaimLabel('Tinnitus')).toBe(false);
  });

  it('does NOT flag an ICD "unspecified" (a legitimate documented dx, not a dropdown catch-all)', () => {
    expect(isGenericClaimLabel('Asthma, unspecified')).toBe(false);
    expect(isGenericClaimLabel('Major depressive disorder, unspecified')).toBe(false);
  });

  it('does NOT flag a single parenthetical qualifier (not a list)', () => {
    expect(isGenericClaimLabel('Tinnitus (bilateral)')).toBe(false);
    expect(isGenericClaimLabel('OSA (obstructive sleep apnea)')).toBe(false);
  });

  it('handles empty / null / non-string safely', () => {
    expect(isGenericClaimLabel('')).toBe(false);
    expect(isGenericClaimLabel('   ')).toBe(false);
    expect(isGenericClaimLabel(null)).toBe(false);
    expect(isGenericClaimLabel(undefined)).toBe(false);
  });
});

describe('isInvalidClaimLabel (Tier A junk guard — Greene `--EYES--`)', () => {
  it('flags dropdown separator tokens (leading AND trailing runs of 2+ dashes)', () => {
    expect(isInvalidClaimLabel('--EYES--')).toBe(true); // the Greene incident value
    expect(isInvalidClaimLabel('----')).toBe(true);
    expect(isInvalidClaimLabel('-- Knees --')).toBe(true);
    expect(isInvalidClaimLabel('  --EYES--  ')).toBe(true); // trims first
  });

  it('flags empty / whitespace / null / undefined', () => {
    expect(isInvalidClaimLabel('')).toBe(true);
    expect(isInvalidClaimLabel('   ')).toBe(true);
    expect(isInvalidClaimLabel(null)).toBe(true);
    expect(isInvalidClaimLabel(undefined)).toBe(true);
  });

  it('flags punctuation-only values (no letter or digit)', () => {
    expect(isInvalidClaimLabel('---')).toBe(true);
    expect(isInvalidClaimLabel('***')).toBe(true);
    expect(isInvalidClaimLabel('?!.')).toBe(true);
    expect(isInvalidClaimLabel('()')).toBe(true);
  });

  it('does NOT flag real conditions, including hyphenated and parenthetical ones', () => {
    expect(isInvalidClaimLabel('Tinnitus (bilateral)')).toBe(false);
    expect(isInvalidClaimLabel('L5-S1 radiculopathy')).toBe(false);
    expect(isInvalidClaimLabel('Foot Dysfunction')).toBe(false);
    expect(isInvalidClaimLabel('PTSD')).toBe(false);
    expect(isInvalidClaimLabel('Obstructive sleep apnea')).toBe(false);
  });

  it('does NOT flag a GENERIC label (that is the AI-narrow path, not the junk path)', () => {
    expect(isInvalidClaimLabel('Other Joint (shoulder, Hip, Ankle, Elbow, Wrist)')).toBe(false);
    expect(isInvalidClaimLabel('Other')).toBe(false);
  });
});
