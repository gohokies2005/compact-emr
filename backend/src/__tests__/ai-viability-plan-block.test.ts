import { describe, it, expect } from 'vitest';
import { isViabilityShaped, buildAiPlanGroundingBlock } from '../advisory/aiViabilityPlanBlock.js';
import type { AppDb } from '../services/db-types.js';
import type { AiViabilityCard } from '../services/ai-viability.js';

// A minimal db stub: only case.findFirst is used by the block builder.
function dbWithPlan(plan: AiViabilityCard | null): AppDb {
  return {
    case: {
      findFirst: async () => ({ aiViabilityPlanJson: plan }),
    },
  } as unknown as AppDb;
}

const supportablePlan: AiViabilityCard = {
  source: 'ai_route_picker',
  viability: 'supportable',
  lead: {
    upstream: 'PTSD', claimed: 'obstructive sleep apnea', framing: 'secondary_causation',
    cfr_basis: '3.310(a)', mechanism: 'PTSD fragments sleep architecture and raises arousal',
    confidence: 'moderate', rationale: 'documented PTSD with weight gain and AHI 22',
    counterargument: 'BMI 38 is an independent OSA driver the letter must rebut',
  },
  convergent: [{ upstream: 'depression', note: 'overlapping sleep-disruption pathway' }],
  alternatives: [{ upstream: 'hypertension', framing: 'secondary_causation', why_not: 'weaker mechanistic link than PTSD' }],
  excluded: [{ upstream: 'bilateral knee strain', reason: 'wrong_physiologic_direction' }],
  missing: [{ fact: 'confirm PTSD is service-connected', why: 'the secondary anchor requires SC status' }],
  nuance: 'dual_prong is available if aggravation is also pleaded',
  overall: 'sound secondary pathway pending SC confirmation',
};

describe('isViabilityShaped', () => {
  it('fires on viability-shaped questions', () => {
    expect(isViabilityShaped('Is this OSA claim viable secondary to PTSD?')).toBe(true);
    expect(isViabilityShaped('why not the knee as the anchor?')).toBe(true);
    expect(isViabilityShaped('what is the best anchor here')).toBe(true);
  });
  it('does not fire on non-viability questions', () => {
    expect(isViabilityShaped('draft an email telling the veteran we received the records')).toBe(false);
    expect(isViabilityShaped('what is the turnaround time')).toBe(false);
  });
});

describe('buildAiPlanGroundingBlock', () => {
  it('returns null for a non-viability question even when a plan exists', async () => {
    const block = await buildAiPlanGroundingBlock(dbWithPlan(supportablePlan), 'c1', 'what is the turnaround time?');
    expect(block).toBeNull();
  });

  it('returns null when no plan is persisted yet', async () => {
    const block = await buildAiPlanGroundingBlock(dbWithPlan(null), 'c1', 'is this OSA claim viable secondary to PTSD?');
    expect(block).toBeNull();
  });

  it('formats the lead, framing, confidence, convergent, alternatives, excludes, and missing facts', async () => {
    const block = await buildAiPlanGroundingBlock(dbWithPlan(supportablePlan), 'c1', 'is this OSA claim viable, and why not the knee?');
    expect(block).toContain('AI ROUTE-PICKER PLAN');
    expect(block).toContain('PTSD → obstructive sleep apnea');
    expect(block).toContain('secondary_causation');
    expect(block).toContain('38 CFR 3.310(a)');
    expect(block).toContain('moderate');
    // hard exclude must be surfaced with a plain-English reason
    expect(block).toContain('bilateral knee strain');
    expect(block).toContain('the physiology runs the wrong direction');
    // convergent + missing-fact gating present
    expect(block).toContain('depression');
    expect(block).toContain('confirm PTSD is service-connected');
    // never leaks a BVA figure
    expect(block).not.toMatch(/\b\d{1,3}\s?%/);
  });

  it('emits an abstain directive (no invented band) when the picker found no lead pathway', async () => {
    const abstain: AiViabilityCard = {
      source: 'ai_route_picker', viability: 'not_supportable',
      lead: { upstream: '', claimed: 'tinnitus', framing: '', cfr_basis: '', mechanism: '', confidence: '', rationale: '', counterargument: '' },
      convergent: [], alternatives: [], excluded: [], missing: [], nuance: '', overall: 'no sound pathway',
    };
    const block = await buildAiPlanGroundingBlock(dbWithPlan(abstain), 'c1', 'is tinnitus viable here?');
    expect(block).toContain('NO validated lead pathway');
    expect(block).toContain('Do NOT invent');
  });
});
