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
    // DIRECT claim with no Board pair must NEVER Stop — the false-Stop bug Ryan caught (GERD/OSA direct).
    // WITH an in-service hook on file -> Plausible; WITHOUT -> Thin (we don't know the nexus story yet).
    { name: 'direct claim WITH in-service hook, no Board pair = Plausible (NEVER Stop)', over: { claimType: 'direct', claimedCondition: 'GERD / Gastritis', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'], proposedMechanism: 'onset during service after a deployment exposure' }, tier: 'Plausible' },
    { name: 'direct claim with NO in-service hook = Thin (flag the missing nexus story, not Stop)', over: { claimType: 'direct', claimedCondition: 'GERD / Gastritis', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'] }, tier: 'Thin' },
    // SECONDARY claim with no Board pair = Thin ("rely on literature"), not Stop — absence of data ≠ impossible.
    { name: 'secondary, no Board pair = Thin (not Stop)', over: { claimedCondition: 'blindness', upstreamScCondition: 'knee', serviceConnectedConditions: ['knee'], activeProblems: ['blindness'] }, tier: 'Thin' },
    { name: 'no diagnosis on file = Stop (hard gate)', over: { activeProblems: [] }, tier: 'Stop' },
    { name: 'anchor named but not service-connected = Stop (hard gate)', over: { serviceConnectedConditions: [] }, tier: 'Stop' },
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

  it('recommends secondary-to-X when a strong Board pair exists for a granted SC condition', () => {
    // OSA claimed, framed "direct", but PTSD is granted SC and PTSD->OSA is a strong pair -> suggest secondary.
    const r = computeStrategyPreview(input({ claimType: 'direct', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: ['PTSD'], claimedCondition: 'OSA', activeProblems: ['OSA'] }));
    expect(r.recommendedPathway.kind).toBe('secondary');
    expect(r.recommendedPathway.anchor?.toLowerCase()).toContain('ptsd');
    expect(r.recommendedPathway.differsFromCurrent).toBe(true);
  });

  it('does NOT nag to switch when already anchored on the suggested pathway', () => {
    // Default input = OSA already framed secondary to granted PTSD (the strong pair) — no "switch" nag.
    const r = computeStrategyPreview(input({}));
    expect(r.recommendedPathway.kind).toBe('secondary');
    expect(r.recommendedPathway.differsFromCurrent).toBe(false);
  });

  it('recommends direct when no granted SC condition has a Board pair to the claimed condition', () => {
    const r = computeStrategyPreview(input({ claimType: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], claimedCondition: 'GERD' }));
    expect(r.recommendedPathway.kind).toBe('direct');
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
