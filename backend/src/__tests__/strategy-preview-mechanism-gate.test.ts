// BVA-RETIREMENT (Pichette, 2026-06-15) — the strategy card must mechanism-gate its anchor pick.
//
// The visible "Argument:" line (computeStrategyPreview) + "Anticipated... secondary to {anchor}"
// (suggestPathway) ranked anchors by BVA Board win-rate (bestGrantedScPair → findPair). The atlas
// carries Tinnitus→OSA at tier "high" (a co-occurrence artifact), so Pichette's card showed
// "secondary to Tinnitus — Strong" even though the mechanism resolver marks that pair `excluded`.
//
// Fix: the route injects the vendored resolver as an AnchorMechanismFilter; the card drops excluded
// anchors before BVA scoring, won't leak an excluded stored anchor, and reads Stop / no-recognized-
// anchor when the only granted SC is excluded. Filter ABSENT = byte-identical legacy (fail-open).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  computeStrategyPreview,
  suggestPathway,
  type StrategyPreviewInput,
} from '../services/strategy-preview.js';
import type { AnchorMechanismFilter } from '../services/case-framing.js';

const require2 = createRequire(import.meta.url);
const anchor = require2('../vendor/anchorMechanism.cjs') as {
  resolveAnchorEligibility(u: string, c: string): { eligibility: string };
  presumptiveFor(c: string): unknown | null;
};
const filter: AnchorMechanismFilter = {
  isEligibleAnchor: (u, c) => {
    try { return anchor.resolveAnchorEligibility(u, c).eligibility !== 'excluded'; } catch { return true; }
  },
  isPresumptive: (c) => {
    try { return anchor.presumptiveFor(c) !== null; } catch { return false; }
  },
};

function input(over: Partial<StrategyPreviewInput>): StrategyPreviewInput {
  return {
    claimedCondition: 'Obstructive sleep apnea',
    claimType: 'initial',
    framingChoice: null,
    upstreamScCondition: null,
    serviceConnectedConditions: ['Tinnitus'],
    activeProblems: ['Obstructive sleep apnea'],
    ...over,
  };
}

describe('strategy card — BVA retirement / mechanism gate (Pichette)', () => {
  it('PICHETTE: OSA + only Tinnitus SC (excluded) → Stop, no anchor, honest argument', () => {
    const p = computeStrategyPreview(input({ mechanismFilter: filter }));
    expect(p.tier).toBe('Stop');
    expect(p.anchor).toBeNull();
    expect(p.primaryArgument).toContain('no recognized service-connected anchor');
    expect(p.primaryArgument).not.toContain('secondary to');
  });

  it('PICHETTE suggestPathway parity: → direct, NOT "secondary to Tinnitus"', () => {
    const rec = suggestPathway(input({ mechanismFilter: filter }));
    expect(rec.kind).toBe('direct');
    expect(rec.anchor).toBeNull();
  });

  it('REGRESSION LOCK: WITHOUT the filter the card still shows "Strong secondary to Tinnitus" (the bug)', () => {
    const p = computeStrategyPreview(input({})); // legacy, no filter
    expect(p.anchor).toBe('Tinnitus');
    expect(p.tier).toBe('Strong');
    expect(p.primaryArgument).toContain('secondary to service-connected Tinnitus');
  });

  it('stored-excluded leak: upstreamScCondition=Tinnitus (excluded) → Stop, anchor not leaked', () => {
    const p = computeStrategyPreview(input({ upstreamScCondition: 'Tinnitus', mechanismFilter: filter }));
    expect(p.tier).toBe('Stop');
    expect(p.anchor).toBeNull();
  });

  it('eligible PTSD anchor still wins (blessed) and is NOT Stopped', () => {
    const p = computeStrategyPreview(input({ serviceConnectedConditions: ['PTSD'], mechanismFilter: filter }));
    expect(p.anchor).toBe('PTSD');
    expect(p.tier).not.toBe('Stop');
  });

  it('an excluded anchor does NOT poison an otherwise-viable case (Tinnitus + PTSD → PTSD)', () => {
    const p = computeStrategyPreview(input({ serviceConnectedConditions: ['Tinnitus', 'PTSD'], mechanismFilter: filter }));
    expect(p.anchor).toBe('PTSD');
    expect(p.tier).not.toBe('Stop');
  });

  it('genuine direct (Tinnitus claimed + knee SC, plausible, not excluded) → NOT a false Stop', () => {
    const p = computeStrategyPreview(input({
      claimedCondition: 'Tinnitus',
      serviceConnectedConditions: ['Right knee strain'],
      activeProblems: ['Tinnitus'],
      mechanismFilter: filter,
    }));
    expect(p.tier).not.toBe('Stop');
    expect(p.primaryArgument).toContain('direct service connection');
  });

  it('absent filter = byte-identical legacy for an eligible anchor (PTSD)', () => {
    const withF = computeStrategyPreview(input({ serviceConnectedConditions: ['PTSD'], mechanismFilter: filter }));
    const noF = computeStrategyPreview(input({ serviceConnectedConditions: ['PTSD'] }));
    expect(withF.anchor).toBe(noF.anchor);
    expect(withF.tier).toBe(noF.tier);
    expect(withF.primaryArgument).toBe(noF.primaryArgument);
  });
});
