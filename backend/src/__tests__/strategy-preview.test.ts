import { describe, it, expect } from 'vitest';
import { computeStrategyPreview, type StrategyPreviewInput } from '../services/strategy-preview.js';

// Locks the deterministic tier ladder. The two anchors Ryan named: knee->blindness must STOP (no
// established pathway), OSA->PTSD must be STRONG (a known strong Board pair). Same chart -> same tier.

function input(over: Partial<StrategyPreviewInput>): StrategyPreviewInput {
  return {
    claimedCondition: 'OSA', claimType: 'secondary', framingChoice: 'causation',
    upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['OSA'],
    ...over,
  };
}

describe('strategy-preview tier ladder (deterministic, reproducible)', () => {
  const cases: Array<{ name: string; over: Partial<StrategyPreviewInput>; tier: string }> = [
    { name: 'OSA secondary to PTSD = Strong (known strong Board pair)', over: {}, tier: 'Strong' },
    { name: 'knee -> blindness = Stop (no established pathway)', over: { claimedCondition: 'blindness', upstreamScCondition: 'knee', serviceConnectedConditions: ['knee'], activeProblems: ['blindness'] }, tier: 'Stop' },
    { name: 'no diagnosis on file = Stop', over: { activeProblems: [] }, tier: 'Stop' },
    { name: 'anchor named but not service-connected = Stop', over: { serviceConnectedConditions: [] }, tier: 'Stop' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(computeStrategyPreview(input(c.over)).tier).toBe(c.tier);
    });
  }

  it('is NOT evaluable on a bare/untriaged case (no claimed condition) — card stays hidden', () => {
    expect(computeStrategyPreview(input({ claimedCondition: '' })).evaluable).toBe(false);
    expect(computeStrategyPreview(input({})).evaluable).toBe(true);
  });

  it('is reproducible — same input twice gives the identical result', () => {
    expect(computeStrategyPreview(input({}))).toEqual(computeStrategyPreview(input({})));
  });

  it('builds a readable primary argument + surfaces the proposed mechanism + 5 criteria', () => {
    const r = computeStrategyPreview(input({ proposedMechanism: 'weight gain from PTSD meds worsened airway collapse' }));
    expect(r.primaryArgument).toContain('OSA');
    expect(r.primaryArgument).toContain('secondary to service-connected PTSD');
    expect(r.proposedMechanism).toBe('weight gain from PTSD meds worsened airway collapse');
    expect(r.criteria).toHaveLength(5);
  });
});
