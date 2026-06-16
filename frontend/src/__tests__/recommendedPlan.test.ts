// recommendedPlan selector — ONE-BRAIN readout tests (2026-06-16).
// The selector must read EXISTING engine fields and never re-threshold. The keystone (architect
// CRITICAL): a strategy 'Stop' must NEVER produce 'draft', even when the info-light viability band
// reads 'strong' — the band cannot see a missing diagnosis / barred theory.
import { describe, it, expect } from 'vitest';
import { recommendedPlan, type RecommendedPlanInputs } from '../lib/recommendedPlan';
import type { StrategyPreview } from '../api/strategy-preview';
import type { CaseViability, BridgePathway } from '../api/case-viability';

function strat(over: Partial<StrategyPreview>): StrategyPreview {
  return {
    evaluable: true,
    primaryArgument: 'x',
    proposedMechanism: null,
    anchor: null,
    tier: 'Strong',
    recommendedPathway: { kind: 'direct', anchor: null, basis: null, differsFromCurrent: false },
    criteria: [],
    summary: 'x',
    ...over,
  } as StrategyPreview;
}

function viab(over: Partial<CaseViability>): CaseViability {
  return {
    version: 2,
    claimed_canonical: 'Obstructive sleep apnea',
    viability: 'weak',
    best_anchor: null,
    alternatives: [],
    why: 'x',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: [],
    confidence: 'low',
    mode: 'info_light',
    table_version: null,
    table_content_hash: null,
    ...over,
  } as CaseViability;
}

const BRIDGE: BridgePathway = {
  bridge_provisional: true,
  physician_review_required: true,
  exposure: 'burn_pit_airborne',
  intermediate_dx: 'Chronic rhinosinusitis',
  intermediate_presumptive_basis: '38 CFR 3.320',
  claimed: 'Obstructive sleep apnea',
  pair_tier: 'conditional',
  pair_M: 2,
  suggestion: 'plain copy',
};

function plan(over: Partial<RecommendedPlanInputs>) {
  return recommendedPlan({ strategy: strat({}), viability: viab({}), ...over });
}

describe('recommendedPlan selector (one-brain readout)', () => {
  it('KEYSTONE: strategy Stop + viability band "strong" → NEVER draft (band cannot see a missing dx)', () => {
    const r = recommendedPlan({ strategy: strat({ tier: 'Stop' }), viability: viab({ viability: 'strong' }) });
    expect(r?.kind).not.toBe('draft');
    expect(r?.kind).toBe('not_draftable');
  });

  it('Stop + a fired bridge → contact_alternative (renders the engine bridge)', () => {
    const r = recommendedPlan({ strategy: strat({ tier: 'Stop' }), viability: viab({ bridge_pathways: [BRIDGE] }) });
    expect(r?.kind).toBe('contact_alternative');
    expect(r?.bridge?.intermediate_dx).toBe('Chronic rhinosinusitis');
    expect(r?.emailEligible).toBe(true);
  });

  it('Stop + a named missing fact (record fully read) → contact_records', () => {
    const r = recommendedPlan({ strategy: strat({ tier: 'Stop' }), viability: viab({ missing_fact: 'A current sleep study (AHI) confirming the OSA diagnosis.' }), hasUnreadPages: false });
    expect(r?.kind).toBe('contact_records');
    expect(r?.missingFact).toContain('sleep study');
    expect(r?.emailEligible).toBe(true);
  });

  it('Stop + unread pages → needs_review (do NOT ask for a record that may be in the unparsed chart)', () => {
    const r = recommendedPlan({ strategy: strat({ tier: 'Stop' }), viability: viab({ missing_fact: 'something' }), hasUnreadPages: true });
    expect(r?.kind).toBe('needs_review');
  });

  it("engine's own anchor-switch (differsFromCurrent) → draft_with_changes, surfacing the engine's anchor", () => {
    const r = recommendedPlan({
      strategy: strat({ tier: 'Strong', recommendedPathway: { kind: 'secondary', anchor: 'PTSD', basis: 'x', differsFromCurrent: true } }),
      viability: viab({ viability: 'strong' }),
    });
    expect(r?.kind).toBe('draft_with_changes');
    expect(r?.switchToAnchor).toBe('PTSD');
    expect(r?.emailEligible).toBe(false);
  });

  it('tier Strong (no switch) → draft', () => {
    expect(plan({ strategy: strat({ tier: 'Strong' }), viability: viab({ viability: 'strong' }) })?.kind).toBe('draft');
  });
  it('tier Plausible → draft', () => {
    expect(plan({ strategy: strat({ tier: 'Plausible' }) })?.kind).toBe('draft');
  });

  it('tier Thin + bridge → contact_alternative', () => {
    expect(plan({ strategy: strat({ tier: 'Thin' }), viability: viab({ bridge_pathways: [BRIDGE] }) })?.kind).toBe('contact_alternative');
  });
  it('tier Thin + missing fact (read) → contact_records', () => {
    expect(plan({ strategy: strat({ tier: 'Thin' }), viability: viab({ missing_fact: 'records X' }) })?.kind).toBe('contact_records');
  });
  it('tier Thin, no bridge, no missing fact → not_draftable', () => {
    expect(plan({ strategy: strat({ tier: 'Thin' }), viability: viab({}) })?.kind).toBe('not_draftable');
  });

  it('no engine read at all → null (section hides)', () => {
    expect(recommendedPlan({ strategy: null, viability: null })).toBeNull();
  });

  it('email eligibility: contact_* true, draft/not_draftable false', () => {
    expect(plan({ strategy: strat({ tier: 'Strong' }) })?.emailEligible).toBe(false);
    expect(plan({ strategy: strat({ tier: 'Thin' }), viability: viab({ missing_fact: 'x' }) })?.emailEligible).toBe(true);
  });
});
