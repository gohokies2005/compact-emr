import { describe, expect, it } from 'vitest';
import { formatConditionLabel } from '../lib/conditionLabel';

describe('formatConditionLabel', () => {
  it('syncs OSA / sleep apnea variants to one canonical label', () => {
    expect(formatConditionLabel('osa')).toBe('Obstructive Sleep Apnea (OSA)');
    expect(formatConditionLabel('Sleep Apnea (OSA)')).toBe('Obstructive Sleep Apnea (OSA)');
    expect(formatConditionLabel('sleep apnea')).toBe('Obstructive Sleep Apnea (OSA)');
    expect(formatConditionLabel('Obstructive Sleep Apnea')).toBe('Obstructive Sleep Apnea (OSA)');
  });
  it('cleans slug/underscore + casing', () => {
    expect(formatConditionLabel('unspecified_genitourinary')).toBe('Unspecified Genitourinary');
    expect(formatConditionLabel('hypertension')).toBe('Hypertension');
  });
  it('keeps acronyms uppercase + canonicalizes', () => {
    expect(formatConditionLabel('ptsd')).toBe('PTSD');
    expect(formatConditionLabel('gerd / gastritis')).toBe('GERD / Gastritis');
  });
  it('empty → empty', () => {
    expect(formatConditionLabel('')).toBe('');
    expect(formatConditionLabel(null)).toBe('');
  });
});
