import { describe, it, expect } from 'vitest';
import { abbreviateCondition, letterFilename } from '../letterFilename.js';

describe('letterFilename (download name convention — Ryan 2026-06-18)', () => {
  it('builds Lastname_FirstInitialOrName_COND_vN (the Ewell_S_OSA_v7 example)', () => {
    expect(letterFilename('Ewell', 'S', 'Obstructive Sleep Apnea', 7)).toBe('Ewell_S_OSA_v7');
    expect(letterFilename('Kasky', 'Ryan', 'GERD', 3)).toBe('Kasky_Ryan_GERD_v3');
  });
  it('abbreviates common long conditions', () => {
    expect(abbreviateCondition('Hypertension')).toBe('HTN');
    expect(abbreviateCondition('Diabetes Mellitus Type 2')).toBe('Diabetes');
    expect(abbreviateCondition('Post-Traumatic Stress Disorder')).toBe('PTSD');
  });
  it('omits the _vN when no version, and sanitizes punctuation (safe for a filename header)', () => {
    expect(letterFilename("O'Brien", 'Mary-Jane', 'Tinnitus', null)).toBe('OBrien_MaryJane_Tinnitus');
    expect(letterFilename('Ewell', 'S', 'OSA', 0)).toBe('Ewell_S_OSA'); // version 0 → no suffix
  });
  it('degrades safely on missing data — never empty, never a bare extension', () => {
    expect(letterFilename(null, null, null, 5)).toBe('Veteran_Claim_v5');
    expect(abbreviateCondition('')).toBe('Claim');
  });
});
