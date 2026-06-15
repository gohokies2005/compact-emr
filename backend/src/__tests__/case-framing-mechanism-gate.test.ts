// Bug C (Pichette, 2026-06-15) — the SSOT framing producer must mechanism-gate its anchor pick.
//
// Root cause: deriveFramingFromEvidence ranks granted-SC anchors purely by BVA Board win-rate
// (bestGrantedScPair → findPair). The atlas carries `Tinnitus → Obstructive sleep apnea` at tier
// "high" (a co-occurrence artifact — tinnitus does NOT cause OSA), so the "Argument" box picked
// "secondary to Tinnitus". The vendored anchor-mechanism resolver marks that pair `excluded`.
//
// Fix: the IMPURE adapter injects an AnchorMechanismFilter (the vendored resolver) so the producer
// drops mechanism-EXCLUDED granted anchors before scoring, and emits 'undetermined' (not a bogus
// secondary, not a silent 'direct') when every candidate anchor is excluded and the claim is not a
// presumptive direct path. Filter ABSENT = legacy behavior (fail-open) — locked below too.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  deriveCaseFraming,
  type AnchorMechanismFilter,
  type CaseFramingCaseInput,
  type ScConditionInput,
} from '../services/case-framing.js';

const require2 = createRequire(import.meta.url);
const anchor = require2('../vendor/anchorMechanism.cjs') as {
  resolveAnchorEligibility(u: string, c: string): { eligibility: string };
  presumptiveFor(c: string): unknown | null;
};
// The REAL vendored resolver, wired exactly as case-framing-stamp.ts will wire it.
const filter: AnchorMechanismFilter = {
  isEligibleAnchor: (u, c) => {
    try { return anchor.resolveAnchorEligibility(u, c).eligibility !== 'excluded'; } catch { return true; }
  },
  isPresumptive: (c) => {
    try { return anchor.presumptiveFor(c) !== null; } catch { return false; }
  },
};

const sc = (condition: string, ratingPct: number | null = 10): ScConditionInput => ({
  condition,
  ratingPct,
  status: 'service_connected',
});
const caseInput = (over: Partial<CaseFramingCaseInput>): CaseFramingCaseInput => ({
  claimedCondition: 'Obstructive sleep apnea',
  claimType: 'initial',
  framingChoice: null,
  upstreamScCondition: null,
  veteranStatement: null,
  ...over,
});

describe('Bug C — mechanism-gated framing producer (Pichette)', () => {
  it('PICHETTE: OSA claimed, only Tinnitus SC (mechanism-EXCLUDED) → undetermined, no anchor', () => {
    const cf = deriveCaseFraming(caseInput({}), [sc('Tinnitus')], new Date('2026-06-15T00:00:00Z'), filter);
    expect(cf.framing).toBe('undetermined');
    expect(cf.upstreamScCondition).toBeNull();
    // grantedScAnchors still lists the granted SC (consumers may read it) — only the THEORY is undetermined.
    expect(cf.grantedScAnchors.map((a) => a.condition)).toEqual(['Tinnitus']);
  });

  it('REGRESSION LOCK: WITHOUT the filter the producer still picks the bogus secondary (proves the gate is the fix)', () => {
    const cf = deriveCaseFraming(caseInput({}), [sc('Tinnitus')]); // legacy, no filter
    expect(cf.framing).toBe('secondary');
    expect(cf.upstreamScCondition).toBe('Tinnitus');
  });

  it('an ELIGIBLE anchor (PTSD→OSA blessed) still wins even when an excluded one is present', () => {
    const cf = deriveCaseFraming(caseInput({}), [sc('Tinnitus', 10), sc('PTSD', 70)], new Date('2026-06-15T00:00:00Z'), filter);
    expect(cf.framing).toBe('secondary');
    expect(cf.upstreamScCondition).toBe('PTSD');
  });

  it('GENUINE DIRECT: claimed condition with a granted SC that has NO atlas relation → direct, NOT undetermined', () => {
    // Tinnitus claimed + Right knee strain SC: no BVA pair, mechanism 'plausible' (NOT excluded), non-
    // presumptive. Nothing is dropped, so the undetermined escape must NOT fire — it stays a direct claim.
    const cf = deriveCaseFraming(
      caseInput({ claimedCondition: 'Tinnitus' }),
      [sc('Right knee strain')],
      new Date('2026-06-15T00:00:00Z'),
      filter,
    );
    expect(cf.framing).toBe('direct');
  });

  it('stored upstream that is mechanism-EXCLUDED is not kept (storedScoreable guard) → undetermined', () => {
    const cf = deriveCaseFraming(
      caseInput({ upstreamScCondition: 'Tinnitus' }),
      [sc('Tinnitus')],
      new Date('2026-06-15T00:00:00Z'),
      filter,
    );
    expect(cf.framing).toBe('undetermined');
    expect(cf.upstreamScCondition).toBeNull();
  });
});
