// BASELINE LOCK for evaluateDraftReadiness (architect QA 2026-06-10: this gate had ZERO tests and
// is being rewired to consume the SSOT caseFraming — the legacy/absent-caseFraming path below must
// stay byte-identical through the rewire; fail-open is proven by these tests continuing to pass).
import { describe, it, expect } from 'vitest';
import { evaluateDraftReadiness, type DraftReadinessInput } from '../services/draft-readiness.js';

function input(overrides: Partial<DraftReadinessInput> = {}): DraftReadinessInput {
  return {
    claimType: 'initial',
    framingChoice: null,
    claimedCondition: 'Obstructive Sleep Apnea',
    claimedConditions: [],
    inServiceEvent: null,
    grantedScCount: 0,
    noScConditionsConfirmed: false,
    problemNames: [],
    documents: [],
    ...overrides,
  };
}

describe('evaluateDraftReadiness — legacy baseline (no caseFraming)', () => {
  it('direct/initial claim: no sc_conditions item, no denial item; dx + event evaluated', () => {
    const r = evaluateDraftReadiness(input());
    expect(r.items.map((i) => i.key)).toEqual(['current_diagnosis', 'in_service_event']);
    expect(r.ready).toBe(false);
  });

  it("framingChoice exact-string 'secondary' adds the SC-primary item (missing → upload rating decision)", () => {
    const r = evaluateDraftReadiness(input({ framingChoice: 'secondary' }));
    const sc = r.items.find((i) => i.key === 'sc_conditions');
    expect(sc?.present).toBe(false);
    expect(sc?.message).toContain('rating decision');
  });

  it("LEGACY QUIRK locked: free-text 'Secondary to PTSD' does NOT match the exact-string check", () => {
    const r = evaluateDraftReadiness(input({ framingChoice: 'Secondary to PTSD' }));
    expect(r.items.find((i) => i.key === 'sc_conditions')).toBeUndefined();
  });

  it("LEGACY QUIRK locked: 'aggravation' framing adds NO SC-primary item on the legacy path", () => {
    const r = evaluateDraftReadiness(input({ framingChoice: 'aggravation' }));
    expect(r.items.find((i) => i.key === 'sc_conditions')).toBeUndefined();
  });

  it('secondary + grants on file → SC-primary present', () => {
    const r = evaluateDraftReadiness(input({ framingChoice: 'secondary', grantedScCount: 2 }));
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(true);
  });

  it('secondary + RN-confirmed-none → present:false with the not-viable-as-secondary message', () => {
    const r = evaluateDraftReadiness(input({ framingChoice: 'secondary', noScConditionsConfirmed: true }));
    const sc = r.items.find((i) => i.key === 'sc_conditions');
    expect(sc?.present).toBe(false);
    expect(sc?.message).toContain('no service-connected condition');
  });

  it('appeal claim types require the denial letter; found via filename regex', () => {
    for (const ct of ['supplemental', 'hlr', 'appeal_bva'] as const) {
      const missing = evaluateDraftReadiness(input({ claimType: ct }));
      expect(missing.items.find((i) => i.key === 'denial_letter')?.present).toBe(false);
      const found = evaluateDraftReadiness(input({ claimType: ct, documents: [{ filename: 'VA Rating Decision 2024.pdf', docTag: null }] }));
      expect(found.items.find((i) => i.key === 'denial_letter')?.present).toBe(true);
    }
  });

  it('current diagnosis: claimed condition matched in problem names (synonym-folded)', () => {
    const r = evaluateDraftReadiness(input({ problemNames: ['Obstructive sleep apnea'] }));
    expect(r.items.find((i) => i.key === 'current_diagnosis')?.present).toBe(true);
  });

  it('in-service event: satisfied by event text OR a service document', () => {
    expect(evaluateDraftReadiness(input({ inServiceEvent: 'IED blast 2009' })).items.find((i) => i.key === 'in_service_event')?.present).toBe(true);
    expect(evaluateDraftReadiness(input({ documents: [{ filename: 'DD-214.pdf', docTag: null }] })).items.find((i) => i.key === 'in_service_event')?.present).toBe(true);
    expect(evaluateDraftReadiness(input()).items.find((i) => i.key === 'in_service_event')?.present).toBe(false);
  });

  it('ready=true with the all-on-file summary when nothing is missing', () => {
    const r = evaluateDraftReadiness(input({
      problemNames: ['Obstructive sleep apnea'],
      inServiceEvent: 'documented noise exposure',
    }));
    expect(r.ready).toBe(true);
    expect(r.summary).toBe('All essential documents are on file.');
  });
});

// ---------------------------------------------------------------------------
// SSOT caseFraming consumption (version-gated; work order Task 2 + Task 3 feed)
// ---------------------------------------------------------------------------
import type { CaseFraming } from '../services/case-framing.js';

function cf(overrides: Partial<CaseFraming> = {}): CaseFraming {
  return {
    version: 1,
    framing: 'secondary',
    grantedScAnchors: [{ condition: 'Anxiety', ratingPct: 70, status: 'service_connected' }],
    upstreamScCondition: 'Anxiety',
    framingChoice: null,
    claimType: 'supplemental',
    source: 'derived',
    derivedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  } as CaseFraming;
}

describe('evaluateDraftReadiness — SSOT caseFraming consumption', () => {
  it('Hatfield shape: SSOT secondary + granted anchor → SC primary present AND event satisfied by the anchor', () => {
    const r = evaluateDraftReadiness(input({ claimType: 'supplemental', caseFraming: cf(), documents: [{ filename: 'VA denial 2025.pdf', docTag: null }], problemNames: ['Obstructive sleep apnea'] }));
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(true);
    const ev = r.items.find((i) => i.key === 'in_service_event');
    expect(ev?.present).toBe(true);
    expect(ev?.basis).toBe('satisfied by granted SC anchor Anxiety (70%)');
    expect(r.ready).toBe(true);
    expect(r.caseFraming).toEqual(cf()); // the Gate-1 pre-fill / provenance feed
  });

  it('SSOT closes the free-text gap: rn_set "Secondary to PTSD" now adds the SC-primary item', () => {
    const r = evaluateDraftReadiness(input({
      framingChoice: 'Secondary to PTSD', // legacy exact-check missed this (baseline quirk above)
      caseFraming: cf({ framingChoice: 'secondary', source: 'rn_set', grantedScAnchors: [] }),
    }));
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(false);
  });

  it('SSOT aggravation widening: aggravation framing requires the SC anchor (legacy did not)', () => {
    const r = evaluateDraftReadiness(input({
      caseFraming: cf({ framing: 'aggravation', source: 'rn_set', framingChoice: 'aggravation', grantedScAnchors: [], upstreamScCondition: null }),
    }));
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(false);
  });

  it('SSOT anchor count outranks the legacy grantedScCount (no status re-filter drift)', () => {
    const r = evaluateDraftReadiness(input({
      grantedScCount: 3, // stale/legacy count says 3...
      caseFraming: cf({ grantedScAnchors: [] }), // ...but the SSOT strict filter says none
    }));
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(false);
  });

  it("undetermined framing = absence for THEORY: falls back to the legacy exact-string check", () => {
    const r = evaluateDraftReadiness(input({
      framingChoice: 'aggravation', // legacy exact-check: NOT 'secondary' → no item
      caseFraming: cf({ framing: 'undetermined', source: 'rn_set', framingChoice: 'aggravation' }),
    }));
    expect(r.items.find((i) => i.key === 'sc_conditions')).toBeUndefined();
  });

  it('unknown contract version = full fail-open to legacy', () => {
    const future = { ...cf(), version: 2 } as unknown as CaseFraming;
    const r = evaluateDraftReadiness(input({ framingChoice: 'secondary', caseFraming: future }));
    // legacy path: exact-string secondary fires, grantedScCount 0 → missing
    expect(r.items.find((i) => i.key === 'sc_conditions')?.present).toBe(false);
    expect(r.caseFraming).toBeUndefined();
  });
});
