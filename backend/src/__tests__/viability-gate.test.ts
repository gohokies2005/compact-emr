import { describe, expect, it } from 'vitest';
import { evaluateViabilityGate, VIABILITY_GATE_VERSION, type ViabilityInput } from '../services/viability-gate.js';

function buildInput(overrides: Partial<ViabilityInput['caseRow']> = {}, activeProblems: readonly { problem: string }[] = [{ problem: 'OSA' }]): ViabilityInput {
  return {
    caseRow: {
      id: 'CASE-1',
      status: 'physician_review',
      claimedCondition: 'Obstructive sleep apnea',
      claimType: 'initial',
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      assignedPhysicianId: 'PHYS-001',
      cdsVerdict: 'accept',
      ...overrides,
    },
    activeProblems,
    // Existing tests assert CDS-on behavior; CDS is unwired by default in prod (Ryan 2026-06-03),
    // so the route passes cdsEnabled=false there. Default true here to keep the CDS-branch tests
    // meaningful; the flag-off behavior is covered by its own test below.
    cdsEnabled: true,
  };
}

describe('evaluateViabilityGate', () => {
  it('returns go when nothing is blocking', () => {
    const r = evaluateViabilityGate(buildInput());
    expect(r.verdict).toBe('go');
    expect(r.blockers).toEqual([]);
    expect(r.gateVersion).toBe(VIABILITY_GATE_VERSION);
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns not_viable when there is no diagnosis on file', () => {
    const r = evaluateViabilityGate(buildInput({}, []));
    expect(r.verdict).toBe('not_viable');
    expect(r.blockers.some((b) => b.code === 'no_diagnosis_on_file')).toBe(true);
  });

  it('returns not_viable when CDS rejected', () => {
    const r = evaluateViabilityGate(buildInput({ cdsVerdict: 'reject' }));
    expect(r.verdict).toBe('not_viable');
    expect(r.blockers.some((b) => b.code === 'cds_reject')).toBe(true);
  });

  it('returns needs_from_vet when status is records (and no harder block)', () => {
    const r = evaluateViabilityGate(buildInput({ status: 'records' }));
    expect(r.verdict).toBe('needs_from_vet');
    expect(r.blockers.some((b) => b.code === 'chart_records_pending')).toBe(true);
  });

  it('prefers not_viable over needs_from_vet when both fire', () => {
    const r = evaluateViabilityGate(buildInput({ status: 'records' }, []));
    expect(r.verdict).toBe('not_viable');
  });

  it('CDS OFF: a not_yet_run case is NOT degraded to clarify (no cds_not_run, no dead-end recommendation)', () => {
    const r = evaluateViabilityGate({ ...buildInput({ cdsVerdict: 'not_yet_run' }), cdsEnabled: false });
    expect(r.blockers.some((b) => b.code === 'cds_not_run')).toBe(false);
    expect(r.recommendations.some((s) => s.toLowerCase().includes('cds'))).toBe(false);
    expect(r.verdict).toBe('go');
  });

  it('CDS OFF: a stale reject verdict does NOT permanently block (no cds_reject)', () => {
    const r = evaluateViabilityGate({ ...buildInput({ cdsVerdict: 'reject' }), cdsEnabled: false });
    expect(r.blockers.some((b) => b.code === 'cds_reject')).toBe(false);
    expect(r.verdict).toBe('go');
  });

  it('returns clarify when CDS has not been run', () => {
    const r = evaluateViabilityGate(buildInput({ cdsVerdict: 'not_yet_run' }));
    expect(r.verdict).toBe('clarify');
    expect(r.blockers.some((b) => b.code === 'cds_not_run')).toBe(true);
  });

  it('returns clarify on caution CDS with secondary missing upstream', () => {
    const r = evaluateViabilityGate(buildInput({ cdsVerdict: 'caution', framingChoice: 'secondary', upstreamScCondition: null }));
    expect(r.verdict).toBe('clarify');
    expect(r.blockers.some((b) => b.code === 'no_upstream_for_secondary')).toBe(true);
  });

  it('returns clarify when no assigned physician', () => {
    const r = evaluateViabilityGate(buildInput({ assignedPhysicianId: null }));
    expect(r.verdict).toBe('clarify');
    expect(r.blockers.some((b) => b.code === 'no_assigned_physician')).toBe(true);
  });

  it('direct framing does not require an upstream SC condition', () => {
    const r = evaluateViabilityGate(buildInput({ framingChoice: 'direct', upstreamScCondition: null, cdsVerdict: 'accept' }));
    expect(r.verdict).toBe('go');
  });

  it('aggravation framing without upstream warns (same family as secondary)', () => {
    const r = evaluateViabilityGate(buildInput({ framingChoice: 'aggravation', upstreamScCondition: null, cdsVerdict: 'accept' }));
    expect(r.verdict).toBe('clarify');
    expect(r.blockers.some((b) => b.code === 'no_upstream_for_secondary')).toBe(true);
  });

  it('emits recommendations alongside blockers', () => {
    const r = evaluateViabilityGate(buildInput({ cdsVerdict: 'not_yet_run', assignedPhysicianId: null }));
    expect(r.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(r.recommendations.some((s) => s.toLowerCase().includes('cds'))).toBe(true);
  });

  it('is deterministic for verdict + blockers (only checkedAt varies)', () => {
    const a = evaluateViabilityGate(buildInput());
    const b = evaluateViabilityGate(buildInput());
    expect(a.verdict).toBe(b.verdict);
    expect(a.blockers).toEqual(b.blockers);
    expect(a.gateVersion).toBe(b.gateVersion);
  });
});
