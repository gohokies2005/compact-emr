import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Bedrock caller so these tests never hit the network. invokeAdvisory returns
// { text, usage, stopReason, costUsd } — we control `text` per test (mirrors doctor-pack-page-llm.test).
const invokeAdvisory = vi.fn();
vi.mock('../../advisory/bedrockClient.js', () => ({
  invokeAdvisory: (...args: unknown[]) => invokeAdvisory(...args),
  SONNET_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
  SONNET_PRICE_PER_M_INPUT_USD: 3,
  SONNET_PRICE_PER_M_OUTPUT_USD: 15,
}));

import { runStrategyAiChecks, strategyAiChecksEnabled, type StrategyAiInput } from '../strategy-ai-checks.js';

function aiReturns(text: string, costUsd = 0.002) {
  invokeAdvisory.mockResolvedValueOnce({ text, usage: { input_tokens: 300, output_tokens: 40 }, stopReason: 'end_turn', costUsd });
}

function input(over: Partial<StrategyAiInput> = {}): StrategyAiInput {
  return {
    claimedCondition: 'obstructive sleep apnea',
    activeProblems: ['OSA', 'hypertension'],
    serviceConnectedConditions: ['PTSD'],
    deploymentFacts: null,
    ...over,
  };
}

// A well-formed model response builder for the happy paths. `sc` (E0 SC-anchor equivalence, 2026-06-13)
// is optional — omitted = a model that did not emit the third block (the default secondary-case shape).
function reply(
  dx: { matched: boolean; matchedDx: string | null; note?: string },
  pres: { eligible: boolean; program: string | null; teraAutoFlagged?: boolean; note?: string },
  sc?: { matched: boolean; matchedCondition: string | null; note?: string },
): string {
  return JSON.stringify({
    dxMatch: { matched: dx.matched, matchedDx: dx.matchedDx, note: dx.note ?? '' },
    presumptive: { eligible: pres.eligible, program: pres.program, teraAutoFlagged: pres.teraAutoFlagged ?? false, note: pres.note ?? '' },
    ...(sc !== undefined ? { scAnchorMatch: { matched: sc.matched, matchedCondition: sc.matchedCondition, note: sc.note ?? '' } } : {}),
  });
}

describe('strategyAiChecksEnabled flag', () => {
  const prev = process.env.STRATEGY_AI_CHECKS_ENABLED;
  afterEach(() => { process.env.STRATEGY_AI_CHECKS_ENABLED = prev; });

  it('is OFF by default / when unset', () => {
    delete process.env.STRATEGY_AI_CHECKS_ENABLED;
    expect(strategyAiChecksEnabled()).toBe(false);
  });
  it('is OFF for any value other than "true"', () => {
    process.env.STRATEGY_AI_CHECKS_ENABLED = '1';
    expect(strategyAiChecksEnabled()).toBe(false);
    process.env.STRATEGY_AI_CHECKS_ENABLED = 'TRUE'; // case-insensitive true is allowed
    expect(strategyAiChecksEnabled()).toBe(true);
  });
});

describe('runStrategyAiChecks', () => {
  const prev = process.env.STRATEGY_AI_CHECKS_ENABLED;
  beforeEach(() => { invokeAdvisory.mockReset(); process.env.STRATEGY_AI_CHECKS_ENABLED = 'true'; });
  afterEach(() => { process.env.STRATEGY_AI_CHECKS_ENABLED = prev; });

  it('FLAG OFF → returns null and NEVER calls Bedrock (no spend)', async () => {
    process.env.STRATEGY_AI_CHECKS_ENABLED = 'false';
    const res = await runStrategyAiChecks(input());
    expect(res).toBeNull();
    expect(invokeAdvisory).not.toHaveBeenCalled();
  });

  it('calls Sonnet 4.6 with temperature 0 and Sonnet pricing', async () => {
    aiReturns(reply({ matched: true, matchedDx: 'OSA', note: 'OSA == obstructive sleep apnea' }, { eligible: false, program: null }));
    await runStrategyAiChecks(input());
    const opts = invokeAdvisory.mock.calls[0]![2] as { temperature?: number; modelId?: string; pricePerMInput?: number; pricePerMOutput?: number };
    expect(opts.temperature).toBe(0);
    expect(opts.modelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(opts.pricePerMInput).toBe(3);
    expect(opts.pricePerMOutput).toBe(15);
  });

  it('dx-match: returns matched=true and the cited dx when the model names a REAL documented problem', async () => {
    aiReturns(reply({ matched: true, matchedDx: 'OSA', note: 'OSA == obstructive sleep apnea' }, { eligible: false, program: null }));
    const res = await runStrategyAiChecks(input());
    expect(res!.dxMatch.matched).toBe(true);
    expect(res!.dxMatch.matchedDx).toBe('OSA');
  });

  it('dx-match: NO MATCH (the Porter case) — allergic conjunctivitis claim, no matching dx', async () => {
    aiReturns(reply({ matched: false, matchedDx: null, note: 'no documented match' }, { eligible: false, program: null }));
    const res = await runStrategyAiChecks(input({ claimedCondition: 'allergic conjunctivitis', activeProblems: ['chronic sinusitis'] }));
    expect(res!.dxMatch.matched).toBe(false);
    expect(res!.dxMatch.matchedDx).toBeNull();
  });

  it('GROUNDING: rejects a HALLUCINATED dx — model claims a match but names a dx not in the record', async () => {
    // Model asserts matched:true but matchedDx="sleep apnea (severe)" which is NOT in activeProblems/SC.
    aiReturns(reply({ matched: true, matchedDx: 'sleep apnea (severe)', note: 'fabricated' }, { eligible: false, program: null }));
    const res = await runStrategyAiChecks(input({ activeProblems: ['hypertension'], serviceConnectedConditions: ['PTSD'] }));
    expect(res!.dxMatch.matched).toBe(false); // rejected — not in the record
    expect(res!.dxMatch.matchedDx).toBeNull();
    expect(res!.dxMatch.note).toMatch(/not in the record/);
  });

  it('GROUNDING: verifies a match leniently across whitespace/case', async () => {
    aiReturns(reply({ matched: true, matchedDx: '  Obstructive Sleep Apnea  ' }, { eligible: false, program: null }));
    const res = await runStrategyAiChecks(input({ claimedCondition: 'OSA', activeProblems: ['obstructive sleep apnea'] }));
    expect(res!.dxMatch.matched).toBe(true);
  });

  it('presumptive: PACT eligible (chronic sinusitis) surfaces program + note', async () => {
    aiReturns(reply({ matched: true, matchedDx: 'chronic sinusitis' }, { eligible: true, program: 'PACT', note: 'burn pit exposure; chronic sinusitis is PACT-presumptive' }));
    const res = await runStrategyAiChecks(input({ claimedCondition: 'chronic sinusitis', activeProblems: ['chronic sinusitis'] }));
    expect(res!.presumptive.eligible).toBe(true);
    expect(res!.presumptive.program).toBe('PACT');
  });

  it('presumptive: TERA auto-flagged from a covered deployment even when not eligible for the claim', async () => {
    aiReturns(reply({ matched: false, matchedDx: null }, { eligible: false, program: null, teraAutoFlagged: true, note: 'Iraq post-9/11 deployment establishes TERA; claim not presumptive' }));
    const res = await runStrategyAiChecks(input({ claimedCondition: 'allergic conjunctivitis', deploymentFacts: 'Served in Iraq 2005-2006.' }));
    expect(res!.presumptive.eligible).toBe(false);
    expect(res!.presumptive.teraAutoFlagged).toBe(true);
  });

  it('presumptive: eligible only counts when a program is named (eligible+null program → not eligible)', async () => {
    aiReturns(reply({ matched: true, matchedDx: 'OSA' }, { eligible: true, program: null }));
    const res = await runStrategyAiChecks(input());
    expect(res!.presumptive.eligible).toBe(false);
    expect(res!.presumptive.program).toBeNull();
  });

  it('FAIL-OPEN: unparseable model output → null', async () => {
    aiReturns('I cannot produce JSON.');
    expect(await runStrategyAiChecks(input())).toBeNull();
  });

  it('FAIL-OPEN: JSON missing a required block → null', async () => {
    aiReturns(JSON.stringify({ dxMatch: { matched: false, matchedDx: null, note: 'x' } })); // no presumptive
    expect(await runStrategyAiChecks(input())).toBeNull();
  });

  it('FAIL-OPEN: a thrown Bedrock error → null (never throws)', async () => {
    invokeAdvisory.mockRejectedValueOnce(new Error('ThrottlingException'));
    expect(await runStrategyAiChecks(input())).toBeNull();
  });

  it('tolerates markdown fences / stray prose around the JSON', async () => {
    aiReturns('```json\n' + reply({ matched: true, matchedDx: 'OSA' }, { eligible: false, program: null }) + '\n```');
    const res = await runStrategyAiChecks(input({ claimedCondition: 'OSA', activeProblems: ['OSA'] }));
    expect(res!.dxMatch.matched).toBe(true);
  });

  // ---- E0 SC-anchor equivalence (2026-06-13) ----
  describe('scAnchorMatch (clinical-equivalence anchor)', () => {
    it('WOODLEY: PTSD upstream anchored by service-connected "Other Specified Trauma/Stressor Disorder"', async () => {
      aiReturns(
        reply(
          { matched: true, matchedDx: 'OSA' },
          { eligible: false, program: null },
          { matched: true, matchedCondition: 'Other Specified Trauma/Stressor Disorder', note: 'PTSD == OSTSRD (trauma cluster)' },
        ),
      );
      const res = await runStrategyAiChecks(
        input({
          claimedCondition: 'obstructive sleep apnea',
          upstreamScCondition: 'PTSD',
          serviceConnectedConditions: ['Other Specified Trauma/Stressor Disorder'],
        }),
      );
      expect(res!.scAnchorMatch).not.toBeNull();
      expect(res!.scAnchorMatch!.matched).toBe(true);
      expect(res!.scAnchorMatch!.matchedCondition).toBe('Other Specified Trauma/Stressor Disorder');
    });

    it('GROUNDING: rejects an SC anchor the model names but is NOT in the SC list → matched:false', async () => {
      aiReturns(
        reply(
          { matched: false, matchedDx: null },
          { eligible: false, program: null },
          { matched: true, matchedCondition: 'PTSD', note: 'fabricated — PTSD not in the SC list' },
        ),
      );
      const res = await runStrategyAiChecks(
        input({ upstreamScCondition: 'PTSD', serviceConnectedConditions: ['Other Specified Trauma/Stressor Disorder'] }),
      );
      // The model NAMED "PTSD" but the only SC condition is OSTSRD → ungrounded → rejected.
      expect(res!.scAnchorMatch!.matched).toBe(false);
      expect(res!.scAnchorMatch!.matchedCondition).toBeNull();
      expect(res!.scAnchorMatch!.note).toMatch(/not in the record/);
    });

    it('GROUNDING: verifies the matched SC condition leniently across whitespace/case', async () => {
      aiReturns(
        reply(
          { matched: true, matchedDx: 'OSA' },
          { eligible: false, program: null },
          { matched: true, matchedCondition: '  other specified trauma/stressor DISORDER  ' },
        ),
      );
      const res = await runStrategyAiChecks(
        input({ upstreamScCondition: 'PTSD', serviceConnectedConditions: ['Other Specified Trauma/Stressor Disorder'] }),
      );
      expect(res!.scAnchorMatch!.matched).toBe(true);
    });

    it('NO MATCH: honest false when no SC condition encompasses the upstream', async () => {
      aiReturns(
        reply(
          { matched: true, matchedDx: 'OSA' },
          { eligible: false, program: null },
          { matched: false, matchedCondition: null, note: 'no SC condition encompasses PTSD' },
        ),
      );
      const res = await runStrategyAiChecks(
        input({ upstreamScCondition: 'PTSD', serviceConnectedConditions: ['hypertension', 'tinnitus'] }),
      );
      expect(res!.scAnchorMatch!.matched).toBe(false);
      expect(res!.scAnchorMatch!.matchedCondition).toBeNull();
    });

    it('NO UPSTREAM (direct claim) → scAnchorMatch is null, regardless of what the model emits', async () => {
      aiReturns(
        reply(
          { matched: true, matchedDx: 'OSA' },
          { eligible: false, program: null },
          { matched: true, matchedCondition: 'PTSD', note: 'should be ignored — no upstream' },
        ),
      );
      const res = await runStrategyAiChecks(input({ upstreamScCondition: null }));
      expect(res!.scAnchorMatch).toBeNull();
    });

    it('a model that omits the scAnchorMatch block on a secondary claim → matched:false (not a fail-open)', async () => {
      // reply() without the 3rd arg = no scAnchorMatch key; dx+presumptive still present so NOT a fail-open.
      aiReturns(reply({ matched: true, matchedDx: 'OSA' }, { eligible: false, program: null }));
      const res = await runStrategyAiChecks(
        input({ upstreamScCondition: 'PTSD', serviceConnectedConditions: ['Other Specified Trauma/Stressor Disorder'] }),
      );
      expect(res).not.toBeNull();
      expect(res!.scAnchorMatch!.matched).toBe(false);
    });
  });
});
