import { describe, it, expect, vi, beforeEach } from 'vitest';

const getState = vi.fn();
vi.mock('../ai-viability.js', () => ({ getAiViabilityState: (...a: unknown[]) => getState(...a) }));

const { resolveGroundedFraming } = await import('../grounded-framing.js');
import type { AppDb } from '../db-types.js';

const db = {} as AppDb;
function ready(leadUpstream: string, leadFraming: string) {
  return { status: 'ready', card: { lead: { upstream: leadUpstream, framing: leadFraming } } };
}

beforeEach(() => getState.mockReset());

describe('resolveGroundedFraming', () => {
  it('manual source → trusts the stored field, no plan read', async () => {
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'manual', framingChoice: 'secondary', upstreamScCondition: 'PTSD' });
    expect(r).toEqual({ upstream: 'PTSD', framing: 'secondary', source: 'manual' });
    expect(getState).not.toHaveBeenCalled();
  });

  it('no stored upstream → nothing to resolve, no plan read', async () => {
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'derived', framingChoice: 'direct', upstreamScCondition: null });
    expect(r.upstream).toBeNull();
    expect(getState).not.toHaveBeenCalled();
  });

  it('JAY: derived "Ankle" + ready plan lead "depression" → grounded depression (override)', async () => {
    getState.mockResolvedValue(ready('depressive disorder with chronic sleep impairment', 'secondary_causation'));
    const r = await resolveGroundedFraming(db, 'CLM-47FAC163B8', { framingStampSource: 'derived', framingChoice: 'secondary', upstreamScCondition: 'Ankle' });
    expect(r.upstream).toBe('depressive disorder with chronic sleep impairment');
    expect(r.source).toBe('grounded');
  });

  it('derived + ready plan with DIRECT lead (no secondary anchor) → SUPPRESS to null', async () => {
    getState.mockResolvedValue(ready('', 'direct'));
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'derived', framingChoice: 'secondary', upstreamScCondition: 'Ankle' });
    expect(r.upstream).toBeNull();
    expect(r.source).toBe('suppressed');
  });

  it('derived + NO ready plan (computing) → SUPPRESS the unverifiable guess to null', async () => {
    getState.mockResolvedValue({ status: 'computing' });
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'derived', framingChoice: 'secondary', upstreamScCondition: 'Ankle' });
    expect(r.upstream).toBeNull();
    expect(r.source).toBe('suppressed');
  });

  it('NON-derived stored value + no ready plan → left as-is (can only improve a derived guess)', async () => {
    getState.mockResolvedValue({ status: 'none' });
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'intake', framingChoice: 'secondary', upstreamScCondition: 'PTSD' });
    expect(r.upstream).toBe('PTSD');
    expect(r.source).toBe('stored');
  });

  it('derived + ready plan that AGREES → grounded (same value, no false override churn in the letter theory)', async () => {
    getState.mockResolvedValue(ready('PTSD', 'secondary'));
    const r = await resolveGroundedFraming(db, 'C', { framingStampSource: 'derived', framingChoice: 'secondary', upstreamScCondition: 'PTSD' });
    expect(r.upstream).toBe('PTSD');
    expect(r.source).toBe('grounded');
  });
});
