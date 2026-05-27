import { describe, expect, it } from 'vitest';
import { evaluateCdsMulti, type CdsMultiInput } from '../services/cdsEngine.js';

// Shared base: a PTSD-anchored secondary cluster with diagnoses on file. Individual cases override
// claimedConditions / activeProblems / serviceConnectedConditions as needed.
function base(over: Partial<CdsMultiInput> = {}): CdsMultiInput {
  return {
    claimedConditions: ['Obstructive sleep apnea'],
    claimType: 'initial',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['PTSD'],
    activeProblems: ['Obstructive sleep apnea'],
    ...over,
  };
}

describe('evaluateCdsMulti', () => {
  it('(a) picks the better-odds member as overall + sets driverCondition', () => {
    // PTSD -> OSA is 89.2% accept; PTSD -> Hypertension is 85% accept. OSA wins on odds.
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Hypertension', 'Obstructive sleep apnea'],
      activeProblems: ['Hypertension', 'Obstructive sleep apnea'],
    }));
    expect(r.perCondition).toHaveLength(2);
    expect(r.driverCondition).toBe('Obstructive sleep apnea');
    expect(r.overall.verdict).toBe('accept');
    expect(r.overall.oddsPct).toBe(89.2);
    // The non-driver member is still evaluated and reported.
    const htn = r.perCondition.find((p) => p.condition === 'Hypertension');
    expect(htn?.result.oddsPct).toBe(85);
  });

  it('(a) order-independent: driver is the better member regardless of array order', () => {
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Obstructive sleep apnea', 'Hypertension'],
      activeProblems: ['Obstructive sleep apnea', 'Hypertension'],
    }));
    expect(r.driverCondition).toBe('Obstructive sleep apnea');
    expect(r.overall.oddsPct).toBe(89.2);
  });

  it('(b) all-reject set stays reject overall', () => {
    // Two pairs both below the supportable threshold (real fallback pairs < 50%).
    const r = evaluateCdsMulti(base({
      upstreamScCondition: 'Hip',
      serviceConnectedConditions: ['Hip'],
      claimedConditions: ['Cervical / neck'],
      activeProblems: ['Cervical / neck'],
    }));
    expect(r.overall.verdict).toBe('reject');
    expect(r.perCondition.every((p) => p.result.verdict === 'reject')).toBe(true);
  });

  it('(c) empty activeProblems => no_diagnosis overall regardless of conditions', () => {
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Obstructive sleep apnea', 'Hypertension'],
      activeProblems: [],
    }));
    expect(r.overall.verdict).toBe('reject');
    expect(r.overall.hardGate.rule).toBe('no_diagnosis');
    // Every member hits the same hard gate.
    expect(r.perCondition.every((p) => p.result.hardGate.rule === 'no_diagnosis')).toBe(true);
  });

  it('(d) an "Unspecified …" condition falls to caution (no atlas pair)', () => {
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Unspecified respiratory / sleep condition'],
      activeProblems: ['Unspecified respiratory / sleep condition'],
    }));
    expect(r.overall.verdict).toBe('caution');
    expect(r.overall.bva.matched).toBe(false);
    expect(r.driverCondition).toBe('Unspecified respiratory / sleep condition');
  });

  it('prefers any numeric oddsPct over a null-odds caution member', () => {
    // OSA (89.2% accept) vs an unmatched caution (null odds). The numeric member drives.
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Unspecified respiratory / sleep condition', 'Obstructive sleep apnea'],
      activeProblems: ['Unspecified respiratory / sleep condition', 'Obstructive sleep apnea'],
    }));
    expect(r.driverCondition).toBe('Obstructive sleep apnea');
    expect(r.overall.oddsPct).toBe(89.2);
  });

  it('empty claimedConditions evaluates defensively as a single empty-condition eval', () => {
    const r = evaluateCdsMulti(base({ claimedConditions: [] }));
    expect(r.perCondition).toHaveLength(1);
    expect(r.driverCondition).toBe('');
    // OSA is in activeProblems but the empty claimed condition can't match a BVA pair => caution.
    expect(r.overall.verdict).toBe('caution');
  });

  it('ties resolve to the primary (first) condition', () => {
    // Two identical-odds members (both PTSD -> OSA via aliases): primary order wins.
    const r = evaluateCdsMulti(base({
      claimedConditions: ['Obstructive sleep apnea', 'Sleep apnea'],
      activeProblems: ['Obstructive sleep apnea', 'Sleep apnea'],
    }));
    expect(r.overall.oddsPct).toBe(89.2);
    expect(r.driverCondition).toBe('Obstructive sleep apnea');
  });
});
