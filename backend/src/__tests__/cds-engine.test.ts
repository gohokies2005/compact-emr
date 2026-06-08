import { describe, expect, it } from 'vitest';
import { evaluateCds, type CdsEngineInput } from '../services/cdsEngine.js';

const base: CdsEngineInput = {
  claimedCondition: 'Obstructive sleep apnea',
  claimType: 'initial',
  framingChoice: 'secondary',
  upstreamScCondition: 'PTSD',
  serviceConnectedConditions: ['PTSD'],
  activeProblems: ['Obstructive sleep apnea'],
};

describe('cdsEngine', () => {
  it('accepts a strong BVA pair (PTSD -> OSA, imo_win_pct 82.1)', () => {
    const r = evaluateCds({ ...base });
    expect(r.verdict).toBe('accept');
    expect(r.oddsPct).toBe(82.1);
    expect(r.bva.matched).toBe(true);
    expect(r.bva.upstream).toBe('PTSD');
    expect(r.hardGate.triggered).toBe(false);
  });

  it('matches condition aliases (post-traumatic stress disorder, sleep apnea)', () => {
    const r = evaluateCds({ ...base, upstreamScCondition: 'Post-traumatic stress disorder', serviceConnectedConditions: ['Post-traumatic stress disorder'], claimedCondition: 'Sleep apnea', activeProblems: ['Sleep apnea'] });
    expect(r.bva.matched).toBe(true);
    expect(r.verdict).toBe('accept');
  });

  it('hard-rejects when no diagnosis is on file', () => {
    const r = evaluateCds({ ...base, activeProblems: [] });
    expect(r.verdict).toBe('reject');
    expect(r.hardGate.rule).toBe('no_diagnosis');
  });

  it('hard-rejects a secondary claim with no service-connected anchor', () => {
    const r = evaluateCds({ ...base, serviceConnectedConditions: ['Tinnitus'] });
    expect(r.verdict).toBe('reject');
    expect(r.hardGate.rule).toBe('no_sc_anchor');
  });

  it('hard-rejects a barred direct tobacco-causation theory', () => {
    const r = evaluateCds({ claimedCondition: 'COPD from in-service tobacco use', claimType: 'initial', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['COPD'] });
    expect(r.verdict).toBe('reject');
    expect(r.hardGate.rule).toBe('barred_theory');
  });

  it('cautions a direct claim with no BVA pair (odds model covers secondary)', () => {
    const r = evaluateCds({ claimedCondition: 'Tinnitus', claimType: 'initial', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['Tinnitus'] });
    expect(r.verdict).toBe('caution');
    expect(r.bva.matched).toBe(false);
    expect(r.oddsPct).toBeNull();
  });

  it('is reproducible (same input -> same verdict/odds)', () => {
    const a = evaluateCds({ ...base });
    const b = evaluateCds({ ...base });
    expect(a.verdict).toBe(b.verdict);
    expect(a.oddsPct).toBe(b.oddsPct);
  });
});
