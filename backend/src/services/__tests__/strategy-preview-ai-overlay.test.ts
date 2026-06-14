import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI checks so the overlay is deterministic and never hits Bedrock. We control exactly what
// runStrategyAiChecks returns (null = flag-off/fail-open; an object = flag-on success).
const runStrategyAiChecks = vi.fn();
vi.mock('../strategy-ai-checks.js', () => ({
  runStrategyAiChecks: (...args: unknown[]) => runStrategyAiChecks(...args),
}));

import {
  computeStrategyPreview,
  computeStrategyPreviewWithAi,
  type StrategyPreviewInput,
} from '../strategy-preview.js';

function input(over: Partial<StrategyPreviewInput> = {}): StrategyPreviewInput {
  return {
    claimedCondition: 'OSA', claimType: 'secondary', framingChoice: 'causation',
    upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['OSA'],
    ...over,
  };
}

describe('computeStrategyPreviewWithAi — flag-off byte-identity', () => {
  beforeEach(() => runStrategyAiChecks.mockReset());

  it('AI null (flag off / fail-open) → BYTE-IDENTICAL to the deterministic preview, no aiChecked', async () => {
    runStrategyAiChecks.mockResolvedValueOnce(null);
    const deterministic = computeStrategyPreview(input());
    const withAi = await computeStrategyPreviewWithAi(input());
    expect(withAi).toEqual(deterministic);
    expect(JSON.stringify(withAi)).toBe(JSON.stringify(deterministic));
    expect(withAi.aiChecked).toBeUndefined();
  });

  it('a bare/untriaged case never calls the AI (no spend on an unevaluable preview)', async () => {
    const res = await computeStrategyPreviewWithAi(input({ claimedCondition: '   ' }));
    expect(res.evaluable).toBe(false);
    expect(runStrategyAiChecks).not.toHaveBeenCalled();
  });
});

describe('computeStrategyPreviewWithAi — flag-on overlay', () => {
  beforeEach(() => runStrategyAiChecks.mockReset());

  it('REPLACES the diagnosis criterion with the grounded dx-match (cites the matched dx)', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: 'OSA == obstructive sleep apnea' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'no covered exposure' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(input());
    expect(res.aiChecked).toBe(true);
    const dx = res.criteria.find((c) => c.key === 'diagnosis')!;
    expect(dx.label).toBe('Documented diagnosis matches the claim');
    expect(dx.pass).toBe(true);
    expect(dx.detail).toContain('OSA');
  });

  it('dx NO-MATCH (Porter): diagnosis criterion FAILS with an honest "no documented match" detail', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: false, matchedDx: null, note: 'no documented match' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(input({ claimedCondition: 'allergic conjunctivitis', activeProblems: ['chronic sinusitis'] }));
    const dx = res.criteria.find((c) => c.key === 'diagnosis')!;
    expect(dx.pass).toBe(false);
    expect(dx.detail.toLowerCase()).toContain('no documented diagnosis');
  });

  it('presumptive ELIGIBLE is surfaced FIRST in the criteria list', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'chronic sinusitis', note: '' },
      presumptive: { eligible: true, program: 'PACT', teraAutoFlagged: true, note: 'burn pit; PACT-presumptive' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(input({ claimedCondition: 'chronic sinusitis', activeProblems: ['chronic sinusitis'] }));
    expect(res.criteria[0]!.key).toBe('presumptive');
    expect(res.criteria[0]!.pass).toBe(true);
    expect(res.criteria[0]!.detail).toContain('PACT');
    expect(res.criteria[0]!.detail).toContain('TERA auto-flagged');
  });

  it('presumptive NOT eligible is appended at the END (does not displace the ladder)', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: '' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'no covered exposure' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(input());
    expect(res.criteria[res.criteria.length - 1]!.key).toBe('presumptive');
    expect(res.criteria[0]!.key).toBe('diagnosis');
  });

  it('overlay preserves the deterministic tier and the other deterministic criteria untouched', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: '' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      scAnchorMatch: { matched: false, matchedCondition: null, note: 'anchor already passes deterministically' },
      costUsd: 0.002,
    });
    const deterministic = computeStrategyPreview(input());
    const res = await computeStrategyPreviewWithAi(input());
    expect(res.tier).toBe(deterministic.tier);
    // The pathway/strength/plausible rows are unchanged from the deterministic preview.
    for (const key of ['anchor', 'plausible', 'pathway', 'strength'] as const) {
      expect(res.criteria.find((c) => c.key === key)).toEqual(deterministic.criteria.find((c) => c.key === key));
    }
  });
});

// ============================================================================
// E0 SC-anchor equivalence (2026-06-13) — the Woodley rescue overlay
// ============================================================================

// The Woodley shape: a secondary-to-PTSD claim whose service-connected trauma dx is recorded as "Other
// Specified Trauma/Stressor Disorder" — ZERO shared tokens with "PTSD", so cdsEngine.hasScAnchor wrongly
// fails the anchor and the deterministic tier is Stop.
function woodley(over: Partial<StrategyPreviewInput> = {}): StrategyPreviewInput {
  return input({
    claimedCondition: 'OSA',
    claimType: 'secondary',
    framingChoice: 'causation',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['Other Specified Trauma/Stressor Disorder'],
    activeProblems: ['OSA'],
    ...over,
  });
}

describe('computeStrategyPreviewWithAi — SC-anchor rescue (rescue-only, never downgrade)', () => {
  beforeEach(() => runStrategyAiChecks.mockReset());

  it('the BUG: the deterministic anchor FAILS and the tier is Stop (token-overlap false-negative)', () => {
    const det = computeStrategyPreview(woodley());
    expect(det.criteria.find((c) => c.key === 'anchor')!.pass).toBe(false);
    expect(det.tier).toBe('Stop');
  });

  it('RESCUE: a grounded clinical-equivalence SC anchor flips the anchor criterion to PASS, citing the SC condition', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: 'OSA == obstructive sleep apnea' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      scAnchorMatch: { matched: true, matchedCondition: 'Other Specified Trauma/Stressor Disorder', note: 'PTSD == OSTSRD (trauma cluster)' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(woodley());
    const anchor = res.criteria.find((c) => c.key === 'anchor')!;
    expect(anchor.pass).toBe(true);
    expect(anchor.detail).toContain('Other Specified Trauma/Stressor Disorder');
    // No longer a flat Stop now that the anchor is recognized — the case is viable, not non-viable.
    expect(res.tier).not.toBe('Stop');
    expect(res.aiChecked).toBe(true);
  });

  it('NEVER DOWNGRADE: when the deterministic anchor already PASSES, scAnchorMatch:true is a no-op (anchor stays a real ✓, tier unchanged)', async () => {
    // PTSD upstream + PTSD in the SC list → deterministic anchor already passes. A spurious AI "match"
    // must not recompute/alter anything.
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: '' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      scAnchorMatch: { matched: true, matchedCondition: 'PTSD', note: 'redundant' },
      costUsd: 0.002,
    });
    const baseInput = input({ upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'] });
    const det = computeStrategyPreview(baseInput);
    const res = await computeStrategyPreviewWithAi(baseInput);
    expect(res.tier).toBe(det.tier);
    expect(res.criteria.find((c) => c.key === 'anchor')).toEqual(det.criteria.find((c) => c.key === 'anchor'));
  });

  it('NO RESCUE when scAnchorMatch is not matched: the deterministic Stop + failing anchor stand', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: '' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      scAnchorMatch: { matched: false, matchedCondition: null, note: 'no SC condition encompasses PTSD' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(woodley());
    expect(res.criteria.find((c) => c.key === 'anchor')!.pass).toBe(false);
    expect(res.tier).toBe('Stop');
  });

  it('an older ai object WITHOUT a scAnchorMatch field never throws and performs no rescue', async () => {
    runStrategyAiChecks.mockResolvedValueOnce({
      dxMatch: { matched: true, matchedDx: 'OSA', note: '' },
      presumptive: { eligible: false, program: null, teraAutoFlagged: false, note: 'n/a' },
      costUsd: 0.002,
    });
    const res = await computeStrategyPreviewWithAi(woodley());
    expect(res.criteria.find((c) => c.key === 'anchor')!.pass).toBe(false);
    expect(res.tier).toBe('Stop');
  });
});
