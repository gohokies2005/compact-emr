// stampAiViabilityPlan must hand the drafter the coherent last-good route-picker plan even when a recompute is
// TRANSIENTLY in flight (status 'computing'). CLM-BE673DFF78 (Drummond): a 'computing' window at draft-enqueue
// (the recompute-on-open churn / a one-time re-hash after a deploy) made the stamp skip → the drafter
// fresh-derived a self-contradictory "direct 3.303 naming the SC right shoulder as cause" framing → the
// Stage-0.5a plan-validity PARK hard-failed the run with NO letter. The plan JSON is preserved across a
// 'computing' recompute (markPlanStatus never nulls it); a claim-CHANGE nulls it (→ correctly skipped).
import { describe, it, expect } from 'vitest';
import { stampAiViabilityPlan } from '../ai-viability-plan-stamp.js';
import { AI_VIABILITY_PLAN_SCHEMA_VERSION } from '../ai-viability.js';
import type { AppDb } from '../db-types.js';

function stubDb(row: unknown): AppDb {
  return { case: { findFirst: async () => row } } as unknown as AppDb;
}

const coherentPlan = {
  schemaVersion: AI_VIABILITY_PLAN_SCHEMA_VERSION,
  source: 'ai_route_picker',
  inputClaimed: 'Left shoulder dysfunction',
  viability: 'needs_physician_review',
  lead: { framing: 'dual_prong', upstream: 'right shoulder degenerative arthritis with tenosynovitis' },
};

const rowWith = (status: string, plan: unknown = coherentPlan, claim = 'Left shoulder dysfunction') => ({
  claimedCondition: claim,
  aiViabilityPlanJson: plan,
  aiViabilityPlanHash: 'hash-1',
  aiViabilityPlanStatus: status,
});

const bundle = { marker: 'base-bundle' } as never;
const stampedFraming = (b: unknown): unknown => (b as { aiViabilityPlan?: { plan?: { lead?: { framing?: string } } } }).aiViabilityPlan?.plan?.lead?.framing;
const isStamped = (b: unknown): boolean => (b as { aiViabilityPlan?: unknown }).aiViabilityPlan !== undefined;

describe('stampAiViabilityPlan — honors a coherent plan through a transient recompute (CLM-BE673DFF78)', () => {
  it('stamps a coherent plan when status is READY', async () => {
    const out = await stampAiViabilityPlan(stubDb(rowWith('ready')), 'c1', bundle);
    expect(stampedFraming(out)).toBe('dual_prong');
  });

  it('stamps the coherent last-good plan even when status is COMPUTING (recompute in flight)', async () => {
    // RED before the fix: the old `status !== 'ready'` guard drops the good plan → drafter fresh-derives.
    const out = await stampAiViabilityPlan(stubDb(rowWith('computing')), 'c1', bundle);
    expect(stampedFraming(out)).toBe('dual_prong');
  });

  it('does NOT stamp on ERROR status (a failed compute is not trustworthy)', async () => {
    const out = await stampAiViabilityPlan(stubDb(rowWith('error')), 'c1', bundle);
    expect(isStamped(out)).toBe(false);
  });

  it('does NOT stamp when the plan claim no longer matches the live claim (stale/re-claimed)', async () => {
    const out = await stampAiViabilityPlan(stubDb(rowWith('computing', coherentPlan, 'Some other condition')), 'c1', bundle);
    expect(isStamped(out)).toBe(false);
  });

  it('does NOT stamp when the JSON was nulled (claim-change window)', async () => {
    const out = await stampAiViabilityPlan(stubDb(rowWith('computing', null)), 'c1', bundle);
    expect(isStamped(out)).toBe(false);
  });
});
