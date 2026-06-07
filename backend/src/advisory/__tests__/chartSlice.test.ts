import { describe, it, expect } from 'vitest';
import { formatChartSlice, type ChartSliceData } from '../chartSlice.js';

const base: ChartSliceData = {
  claimType: 'secondary',
  claimedCondition: 'OSA',
  claimedConditions: ['OSA'],
  upstreamScCondition: 'PTSD',
  scConditions: [{ condition: 'PTSD', status: 'service_connected', ratingPct: 70, dcCode: '9411' }],
  activeProblems: [{ problem: 'Obesity', icd10: 'E66.9', notes: 'BMI 34' }],
  activeMedications: [{ drugName: 'sertraline', indication: 'PTSD' }],
};

describe('formatChartSlice', () => {
  it('builds a compact slice with claim, SC conditions, problems, meds', () => {
    const { text } = formatChartSlice(base);
    expect(text).toContain('Claim: OSA (secondary)');
    expect(text).toContain('Stated upstream SC condition: PTSD');
    expect(text).toContain('- PTSD (70%) [DC 9411] — service_connected');
    expect(text).toContain('- Obesity [E66.9]: BMI 34');
    expect(text).toContain('- sertraline (for PTSD)');
  });

  it('derives the retrieval condition list = claimed + upstream + SC anchors, deduped', () => {
    const { conditions } = formatChartSlice(base);
    expect(conditions).toContain('OSA');
    expect(conditions).toContain('PTSD');
    expect(conditions.filter((c) => c === 'PTSD')).toHaveLength(1); // upstream + SC anchor collapse to one
  });

  it('handles an empty chart with "(none recorded)"', () => {
    const { text, conditions } = formatChartSlice({ ...base, scConditions: [], activeProblems: [], activeMedications: [] });
    expect(text).toContain('Service-connected conditions of record:\n  (none recorded)');
    expect(text).toContain('Active problem list:\n  (none recorded)');
    expect(conditions).toContain('OSA');
  });

  it('omits the medications block when there are none', () => {
    expect(formatChartSlice({ ...base, activeMedications: [] }).text).not.toContain('Active medications:');
  });
});
