import { describe, it, expect } from 'vitest';
import { assignChartFilenames, guessDocType, abbreviateConditionForFile } from '../services/chart-filename.js';

describe('chart-filename', () => {
  it('guesses a doc type from the original name, else Misc (combined/ambiguous)', () => {
    expect(guessDocType('BlueButton.pdf')).toBe('BlueButton');
    expect(guessDocType('my DD-214.pdf')).toBe('DD214');
    expect(guessDocType('sleep study results.pdf')).toBe('SleepStudy');
    expect(guessDocType('340684654168.pdf')).toBe('Misc'); // a bare Jotform id = unclassifiable
    expect(guessDocType('combined records.pdf')).toBe('Misc');
  });

  it('abbreviates common conditions', () => {
    expect(abbreviateConditionForFile('Obstructive Sleep Apnea')).toBe('OSA');
    expect(abbreviateConditionForFile('Post-Traumatic Stress Disorder')).toBe('PTSD');
    expect(abbreviateConditionForFile('Bilateral Pes Planus')).toBe('BPP');
  });

  it('builds Lastname_Condition_DocType and numbers collisions', () => {
    const out = assignChartFilenames('Frank', 'Obstructive Sleep Apnea', [
      'BlueButton.pdf', 'VA decision.pdf', 'combined.pdf', 'another combined.pdf',
    ]);
    expect(out).toEqual([
      'Frank_OSA_BlueButton.pdf',
      'Frank_OSA_Decision.pdf',
      'Frank_OSA_Misc.pdf',
      'Frank_OSA_Misc_2.pdf', // collision → numbered
    ]);
  });

  it('falls back gracefully on missing name/condition', () => {
    expect(assignChartFilenames(null, null, ['x.pdf'])).toEqual(['Veteran_Claim_Misc.pdf']);
  });
});
