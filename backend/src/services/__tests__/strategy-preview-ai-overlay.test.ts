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
