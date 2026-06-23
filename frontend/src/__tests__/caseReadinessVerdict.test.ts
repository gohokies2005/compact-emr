// caseReadinessVerdict — the one-brain Overview reconciler (2026-06-18, Cluster 3).
// Asserts the QA-mandated contract: deterministic core first; over-call → draft_confirm_mechanism;
// extraction add-caution-only + conservative (never flips supportable→not-supportable, but softens
// "request records" → "read chart first"); sanity asymmetric add-caution-only (concern flags + lowers,
// clear/unavailable never relax); explicit disagreements; unavailable inputs degrade, never confident.
import { describe, expect, it } from 'vitest';
import { computeReadinessVerdict, recommendedPlan, type ReadinessSignals } from '../lib/caseReadinessVerdict';
import type { StrategyPreview, StrategyTier } from '../api/strategy-preview';
import type { CaseViability, ViabilityBand } from '../api/case-viability';
import type { ExtractionCoverage, CoverageStatus } from '../api/extraction-coverage';
import type { ImpressionLevel } from '../api/sanity-impression';

function strategy(tier: StrategyTier, over: Partial<StrategyPreview> = {}): StrategyPreview {
  return {
    evaluable: true,
    recommendedPathway: { kind: 'secondary', anchor: null, basis: null, differsFromCurrent: false },
    primaryArgument: '',
    proposedMechanism: null,
    anchor: null,
    tier,
    criteria: [],
    summary: '',
    ...over,
  };
}

function viability(band: ViabilityBand, over: Partial<CaseViability> = {}): CaseViability {
  return {
    version: 1,
    claimed_canonical: 'Multiple sclerosis',
    viability: band,
    best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 3, M_eff: 3, E: null, tier: 'conditional', basis: '3.310a', is_granted_sc: true, mechanism_class: null, requires: null },
    alternatives: [],
    why: '',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: [],
    confidence: 'high',
    mode: 'chart_refined',
    table_version: null,
    table_content_hash: null,
    ...over,
  };
}

function coverage(status: CoverageStatus, coveragePct = 100, analysisState?: ExtractionCoverage['chartAnalysis']['state']): ExtractionCoverage {
  const extractedPages = status === 'complete' ? 10 : 8;
  const state = analysisState ?? (status === 'failed' ? 'failed' : status === 'in_progress' ? 'in_progress' : 'complete');
  return {
    totalPages: 10, extractedPages, coveragePct, gaps: [], status, unknownPageFiles: 0, totalFiles: 1, pageBreakdown: null,
    pagesRead: { pct: coveragePct, readUnits: extractedPages, totalUnits: 10, approximate: false, label: `${coveragePct}% (${extractedPages} of 10)` },
    chartAnalysis: { state, label: '✓ Complete', reason: null, likelyCauseFile: null, findings: null },
  };
}

const SIGNALS = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({
  strategy: strategy('Strong'),
  viability: viability('strong', { best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null, tier: 'blessed', basis: '3.310a', is_granted_sc: true, mechanism_class: null, requires: null, physician_reviewed: true }, recommended_action: { action: 'auto_run', route: null, band: 'strong', reason: 'Dominant recognized pathway — proceed.' } }),
  hasUnreadPages: false,
  extraction: coverage('complete'),
  sanity: 'clear',
  ...over,
});

const UNREVIEWED = (band: ViabilityBand = 'strong'): CaseViability => viability(band, {
  best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null, tier: 'blessed', basis: '3.310b', is_granted_sc: true, mechanism_class: null, requires: null, physician_reviewed: false },
  recommended_action: { action: 'escalate', route: 'physician', band, reason: 'Mechanism not yet physician-reviewed — confirm before drafting.' },
});

describe('computeReadinessVerdict — reconciliation contract', () => {
  it('clean go: Strong + reviewed anchor + complete extraction + sanity clear → draft, high confidence, no disagreements', () => {
    const r = computeReadinessVerdict(SIGNALS())!;
    expect(r.verdict).toBe('draft');
    expect(r.confidence).toBe('high');
    expect(r.disagreements).toHaveLength(0);
    expect(r.nextAction).toMatch(/drafter/i);
  });

  it('OVER-CALL: Strong but the anchor is unreviewed (escalate→physician) → draft_confirm_mechanism + disagreement + lower confidence', () => {
    const r = computeReadinessVerdict(SIGNALS({ viability: UNREVIEWED('strong') }))!;
    expect(r.verdict).toBe('draft_confirm_mechanism');
    expect(r.confidence).not.toBe('high');
    expect(r.disagreements.some((d) => /physician-reviewed|confirm/i.test(d.note))).toBe(true);
  });

  it('OVER-CALL on an anchor-SWITCH: draft_with_changes with an unreviewed anchor still flags confirm-mechanism + lowers confidence', () => {
    const r = computeReadinessVerdict(SIGNALS({
      strategy: strategy('Strong', { recommendedPathway: { kind: 'secondary', anchor: 'PTSD', basis: '3.310b', differsFromCurrent: true } }),
      viability: UNREVIEWED('strong'),
    }))!;
    expect(r.verdict).toBe('draft_with_changes'); // a switch is already a non-clean go
    expect(r.confidence).not.toBe('high');
    expect(r.disagreements.some((d) => /physician-reviewed|confirm/i.test(d.note))).toBe(true);
  });

  it('EXTRACTION conservative: incomplete parse on a Strong case stays draftable but lowers confidence + flags coverage (never not-supportable)', () => {
    const r = computeReadinessVerdict(SIGNALS({ hasUnreadPages: true, extraction: coverage('complete_with_gaps', 80) }))!;
    expect(r.verdict).toBe('draft'); // NOT flipped to not_supportable
    expect(r.confidence).not.toBe('high');
    expect(r.disagreements.some((d) => d.source === 'extraction' && /80%/.test(d.note))).toBe(true);
  });

  it('EXTRACTION softens "request records" → "read chart first" when the chart is not fully read', () => {
    const r = computeReadinessVerdict(SIGNALS({
      strategy: strategy('Thin'),
      viability: viability('weak', { missing_fact: 'a current sleep study' }),
      hasUnreadPages: true,
      extraction: coverage('in_progress', 60),
    }))!;
    expect(r.verdict).toBe('read_chart_first');
    expect(r.nextAction).toMatch(/chart/i);
  });

  it('SANITY asymmetric: concern flags + lowers; clear and unavailable NEVER relax a deterministic caution', () => {
    const concern = computeReadinessVerdict(SIGNALS({ sanity: 'concern' }))!;
    expect(concern.disagreements.some((d) => d.source === 'ai_sanity')).toBe(true);
    expect(concern.confidence).not.toBe('high');

    // A deterministic over-call caution must NOT be relaxed by a 'clear' sanity.
    const overcallClear = computeReadinessVerdict(SIGNALS({ sanity: 'clear', viability: UNREVIEWED('strong') }))!;
    expect(overcallClear.verdict).toBe('draft_confirm_mechanism'); // 'clear' did not promote it back to 'draft'

    // unavailable sanity is NOT 'clear' — it adds nothing but doesn't claim all-clear either.
    const noSanity = computeReadinessVerdict(SIGNALS({ sanity: null as ImpressionLevel | null }))!;
    expect(noSanity.disagreements.some((d) => d.source === 'ai_sanity')).toBe(false);
  });

  it('HARD disagreement (Strong tier but weak/abstain band) → amber draft_reconcile, draftable, explicit disagreement + lower confidence', () => {
    const r = computeReadinessVerdict(SIGNALS({ viability: viability('weak') }))!; // SIGNALS sanity defaults to 'clear'
    expect(r.verdict).toBe('draft_reconcile'); // NOT a confident green draft, NOT flipped to not_supportable
    expect(r.disagreements.some((d) => d.source === 'viability_vs_strategy')).toBe(true);
    expect(r.confidence).not.toBe('high');
    // A 'clear' sanity must NOT relax the steer — plain reconcile copy, no AI strengthening.
    expect(r.nextAction).toMatch(/reconcile the anchor/i);
    expect(r.nextAction).not.toMatch(/AI check also flags/i);
  });

  it('AI sanity corroborates a hard disagreement (concern) → steers to get-more-records/physician (caution-only, one-way)', () => {
    const r = computeReadinessVerdict(SIGNALS({ viability: viability('weak'), sanity: 'concern' }))!;
    expect(r.verdict).toBe('draft_reconcile');
    expect(r.nextAction).toMatch(/more records|physician/i);
    expect(r.nextAction).toMatch(/AI check also flags/i);
    expect(r.disagreements.some((d) => d.source === 'ai_sanity')).toBe(true);
  });

  it('unknown read-state is NOT treated as fully read — adds a cautious coverage note', () => {
    const r = computeReadinessVerdict(SIGNALS({ hasUnreadPages: null, extraction: null }))!;
    expect(r.disagreements.some((d) => d.source === 'extraction' && /unavailable/i.test(d.note))).toBe(true);
    expect(r.confidence).not.toBe('high');
  });

  it('Stop tier → not_supportable (deterministic core wins; a green band cannot override a Stop)', () => {
    const r = computeReadinessVerdict(SIGNALS({ strategy: strategy('Stop'), viability: viability('strong') }))!;
    expect(r.verdict).toBe('not_supportable');
  });

  it('both strategy and viability unavailable → null (surface hides)', () => {
    expect(computeReadinessVerdict({ strategy: null, viability: null, hasUnreadPages: null, extraction: null, sanity: null })).toBeNull();
  });

  it('recommendedPlan re-export still works (back-compat shim): Strong → draft kind', () => {
    expect(recommendedPlan({ strategy: strategy('Strong'), viability: null })?.kind).toBe('draft');
  });
});

// ── CHART-ANALYSIS SAFETY OVERLAY (Ryan 2026-06-23) — THE safety fix: the verdict, not just a label, stops
//    being confident when the chart the verdict is built on wasn't actually analyzed. ──
describe('computeReadinessVerdict — chart-analysis safety overlay', () => {
  it('analysis FAILED on a Strong/supportable case → analysis_failed (directional TEXT suppressed), low confidence', () => {
    const r = computeReadinessVerdict(SIGNALS({ extraction: coverage('failed', 100, 'failed') }))!;
    expect(r.verdict).toBe('analysis_failed'); // NOT a confident "draft" on an empty chart
    expect(r.confidence).toBe('low');
    expect(r.detail).not.toMatch(/not supportable/i);
    expect(r.detail).toMatch(/re-run/i);
    expect(r.disagreements.some((d) => d.source === 'chart_analysis')).toBe(true);
    expect(r.nextAction).toMatch(/re-run/i);
  });

  it('analysis FAILED suppresses a would-be "not supportable" too (never assert not-supportable on an unanalyzed chart)', () => {
    const r = computeReadinessVerdict(SIGNALS({
      strategy: strategy('Stop'), viability: viability('abstain'),
      extraction: coverage('failed', 100, 'failed'),
    }))!;
    expect(r.verdict).toBe('analysis_failed');
    expect(r.detail).not.toMatch(/not supportable/i);
  });

  it('analysis INCOMPLETE (queued/interrupted) with OCR 100% → directional verdict downgraded to read_chart_first, lower confidence', () => {
    const r = computeReadinessVerdict(SIGNALS({ extraction: coverage('complete_with_gaps', 100, 'incomplete') }))!;
    expect(r.verdict).toBe('read_chart_first'); // the verdict (not just the headline label) goes provisional
    expect(r.confidence).not.toBe('high');
    expect(r.disagreements.some((d) => d.source === 'chart_analysis')).toBe(true);
  });

  it('analysis IN_PROGRESS → directional verdict goes provisional read_chart_first', () => {
    const r = computeReadinessVerdict(SIGNALS({ extraction: coverage('in_progress', 100, 'in_progress') }))!;
    expect(r.verdict).toBe('read_chart_first');
  });

  it('FAIL-SAFE: coverage loading/errored (chartAnalysisUnknown) → never a confident verdict, goes provisional', () => {
    const r = computeReadinessVerdict(SIGNALS({ extraction: null, chartAnalysisUnknown: true }))!;
    expect(r.verdict).toBe('read_chart_first'); // unknown fails SAFE, not confident
    expect(r.confidence).not.toBe('high');
    expect(r.disagreements.some((d) => d.source === 'chart_analysis')).toBe(true);
  });

  it('not_analyzed (new/empty case) does NOT downgrade — a clean Strong case stays a confident draft', () => {
    const r = computeReadinessVerdict(SIGNALS({ extraction: coverage('complete', 100, 'not_analyzed') }))!;
    expect(r.verdict).toBe('draft');
    expect(r.confidence).toBe('high');
    expect(r.disagreements.some((d) => d.source === 'chart_analysis')).toBe(false);
  });

  it('a found bridge (contact_alternative) is NOT clobbered by a failed analysis', () => {
    const r = computeReadinessVerdict(SIGNALS({
      strategy: strategy('Stop'),
      viability: viability('abstain', { bridge_pathways: [{
        bridge_provisional: true, physician_review_required: true, exposure: 'Gulf War', intermediate_dx: 'asthma',
        intermediate_presumptive_basis: '3.317', claimed: 'OSA', pair_tier: null, pair_M: null, suggestion: 'establish asthma first',
      }] }),
      extraction: coverage('failed', 100, 'failed'),
    }))!;
    expect(r.verdict).toBe('contact_alternative'); // a presumptive route still stands
  });
});
