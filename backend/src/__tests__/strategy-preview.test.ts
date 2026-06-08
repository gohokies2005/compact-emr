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

  it('RECOVERS the effective anchor from a garbage stored value (Stocks: migraines secondary to OSA = Strong)', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'secondary', claimedCondition: 'migraines',
      upstreamScCondition: 'service I wake up with headaches', // garbage — resolves to no atlas pair
      serviceConnectedConditions: ['Obstructive sleep apnea'], activeProblems: ['migraines'],
    }));
    expect(r.tier).toBe('Strong');
    expect(r.anchor?.toLowerCase()).toContain('sleep apnea');
    expect(r.primaryArgument.toLowerCase()).toContain('sleep apnea');
    expect(r.criteria.every((c) => c.pass), JSON.stringify(r.criteria)).toBe(true);
  });

  it('does NOT override a scoreable stored anchor (no silent rewrite of a deliberate framing)', () => {
    const r = computeStrategyPreview(input({})); // default = OSA secondary to PTSD; PTSD resolves to a pair
    expect(r.anchor?.toLowerCase()).toContain('ptsd');
  });

  it('preserves aggravation framing when recovering the anchor', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'aggravation', claimedCondition: 'migraines',
      upstreamScCondition: 'garbage zzz', serviceConnectedConditions: ['Obstructive sleep apnea'], activeProblems: ['migraines'],
    }));
    expect(r.primaryArgument.toLowerCase()).toContain('aggravation');
    expect(r.anchor?.toLowerCase()).toContain('sleep apnea');
  });

  it('OSA claim in Jotform format "Sleep Apnea (OSA)" matches the Board pair (Yorde secondary to PTSD = Strong, was Thin)', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'secondary', claimedCondition: 'Sleep Apnea (OSA)',
      upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['Sleep Apnea (OSA)'],
    }));
    expect(r.tier).toBe('Strong');
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

  // ---- CHANGE 5: clean overall grant rate + raw count on the strength criterion ----
  it('strength criterion shows the OVERALL grant rate + raw count (Granted in X of N decided Board appeals)', () => {
    // Knee -> lumbar/back: grant_pct 61.6, n 487 -> round(487*0.616)=300.
    const r = computeStrategyPreview(input({
      claimedCondition: 'lumbar back', upstreamScCondition: 'knee',
      serviceConnectedConditions: ['knee'], activeProblems: ['lumbar back'],
    }));
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.detail).toBe('Granted in 300 of 487 decided Board appeals (61.6%)');
    expect(strength.detail).not.toContain('Board signal');
    expect(strength.detail).not.toContain('relative ranking');
  });

  it('strength detail falls back to non-BVA copy on an unmatched (direct / no-pair) claim', () => {
    const r = computeStrategyPreview(input({
      claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD / Gastritis',
      upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'],
      proposedMechanism: 'onset during service after a deployment exposure',
    }));
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.detail).toContain('No Board odds');
  });

  // ---- CHANGE 1: thin-sample near-miss rescue (Option A) ----
  // A knee->back-shaped, recognized pairing is NEVER Thin (owner's explicit red line).
  it('knee -> back (robust, n=487, 61.6%) is never Thin/Stop — lands Strong', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'lumbar back', upstreamScCondition: 'knee',
      serviceConnectedConditions: ['knee'], activeProblems: ['lumbar back'],
    }));
    expect(r.tier).not.toBe('Thin');
    expect(r.tier).not.toBe('Stop');
    expect(r.tier).toBe('Strong');
  });

  it('thin sample + near-miss grant rate (DM2 -> OSA, n=15, 46.7%) rescues Thin -> Plausible', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'obstructive sleep apnea', upstreamScCondition: 'diabetes type 2',
      serviceConnectedConditions: ['diabetes type 2'], activeProblems: ['obstructive sleep apnea'],
    }));
    expect(r.tier).toBe('Plausible');
    // The rescued tier must NOT show an adverse ✗ on strength — it rests on mechanism.
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.pass).toBe(true);
    expect(strength.detail).toContain('thin Board sample');
    expect(strength.detail).toContain('Granted in 7 of 15 decided Board appeals (46.7%)');
  });

  it('robust-and-low pair (Hip -> Knee, tier high, 33.3%) is NOT rescued — stays Thin with an adverse ✗', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'knee', upstreamScCondition: 'hip',
      serviceConnectedConditions: ['hip'], activeProblems: ['knee'],
    }));
    expect(r.tier).toBe('Thin');
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.pass).toBe(false);
  });

  it('builds a readable primary argument + surfaces the proposed mechanism + 5 criteria', () => {
    const r = computeStrategyPreview(input({ proposedMechanism: 'weight gain from PTSD meds worsened airway collapse' }));
    expect(r.primaryArgument).toContain('OSA');
    expect(r.primaryArgument).toContain('secondary to service-connected PTSD');
    expect(r.proposedMechanism).toBe('weight gain from PTSD meds worsened airway collapse');
    expect(r.criteria).toHaveLength(5);
  });
});
