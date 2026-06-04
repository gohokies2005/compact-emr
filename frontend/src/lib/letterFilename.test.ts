import { describe, it, expect } from 'vitest';
import { abbreviateCondition, letterFilename } from './letterFilename';

describe('abbreviateCondition', () => {
  it('maps common VA conditions to their expected abbreviation', () => {
    expect(abbreviateCondition('Obstructive Sleep Apnea')).toBe('OSA');
    expect(abbreviateCondition('Obstructive sleep apnea (ICD-10 G47.33)')).toBe('OSA');
    expect(abbreviateCondition('Post-Traumatic Stress Disorder')).toBe('PTSD');
    expect(abbreviateCondition('GERD')).toBe('GERD');
  });

  it('builds an acronym from significant words when unknown', () => {
    expect(abbreviateCondition('Bilateral Pes Planus')).toBe('BPP');
  });

  it('handles a single unknown word and blanks', () => {
    expect(abbreviateCondition('Fibromyalgia')).toBe('Fibromyalgia');
    expect(abbreviateCondition('')).toBe('Claim');
    expect(abbreviateCondition(null)).toBe('Claim');
  });
});

describe('letterFilename', () => {
  it('builds Lastname_Firstname_COND_vN', () => {
    expect(letterFilename('Kasky', 'Ryan', 'Obstructive Sleep Apnea', 3)).toBe('Kasky_Ryan_OSA_v3');
  });

  it('omits the version suffix when no version is known', () => {
    expect(letterFilename('Frank', 'Armand', 'Obstructive sleep apnea')).toBe('Frank_Armand_OSA');
  });

  it('sanitizes punctuation/spaces in names', () => {
    expect(letterFilename("O'Brien", 'Mary Jane', 'PTSD', 2)).toBe('OBrien_MaryJane_PTSD_v2');
  });

  it('falls back gracefully on missing names', () => {
    expect(letterFilename(null, null, 'Tinnitus', 1)).toBe('Veteran_Tinnitus_v1');
  });
});
