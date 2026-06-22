// One-brain Overview chip (Ryan 2026-06-22, Zimmelman FIX B) — the chip is a PROJECTION of the AI
// route-picker band, NEVER contradicting the SOAP note (which renders the SAME plan). Asserts:
//   1. routePickerBandToVerdict's go/no-go AGREES, band-for-band, with soap-overview's planViabilityToAction
//      (the cross-module agreement test — two enums, one decision).
//   2. band WINS the headline over a deterministic Stop (band 'supportable' + strategy tier 'Stop' → 'draft')
//      AND surfaces a visible band_vs_deterministic disagreement (not a silent flip).
//   3. with routePickerViability=null the deterministic core still drives the headline (fallback preserved).
import { describe, expect, it } from 'vitest';
import {
  computeReadinessVerdict,
  routePickerBandToVerdict,
  type ReadinessSignals,
} from '../lib/caseReadinessVerdict';
import type { RoutePickerViability } from '../api/case-viability';
import type { StrategyPreview, StrategyTier } from '../api/strategy-preview';

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

const BASE = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({
  strategy: strategy('Strong'),
  viability: null,
  hasUnreadPages: false,
  extraction: null,
  sanity: null,
  ...over,
});

const ALL_BANDS: readonly RoutePickerViability[] = ['supportable', 'marginal', 'needs_physician_review', 'not_supportable'];

// "go" = drafting may proceed. (The true cross-module agreement with soap-overview's planViabilityToAction
// is asserted in backend/src/services/__tests__/oneBrainChip.agreement.test.ts, which imports BOTH real
// functions — this FE-side check pins the band→verdict half of that contract.)
function verdictIsGo(band: RoutePickerViability): boolean {
  const v = routePickerBandToVerdict(band);
  return v === 'draft' || v === 'draft_confirm_mechanism' || v === 'draft_reconcile' || v === 'draft_with_changes';
}

describe('routePickerBandToVerdict — supportable is the only "go" band', () => {
  it('only supportable projects to a go verdict; the rest are no-go', () => {
    expect(ALL_BANDS.filter(verdictIsGo)).toEqual(['supportable']);
    expect(routePickerBandToVerdict('supportable')).toBe('draft');
    expect(routePickerBandToVerdict('marginal')).toBe('needs_review');
    expect(routePickerBandToVerdict('needs_physician_review')).toBe('needs_review');
    expect(routePickerBandToVerdict('not_supportable')).toBe('not_supportable');
  });
});

describe('band wins the headline over a deterministic Stop (no silent flip)', () => {
  it("strategy tier 'Stop' + band 'supportable' → verdict 'draft' WITH a band_vs_deterministic disagreement", () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Stop'), routePickerViability: 'supportable' }))!;
    expect(r.verdict).toBe('draft'); // the band wins the headline
    const dis = r.disagreements.find((d) => d.source === 'band_vs_deterministic');
    expect(dis).toBeTruthy(); // the deterministic concern is SURFACED, not hidden
    expect(dis?.note).toMatch(/route-picker/i);
  });

  it("band 'not_supportable' → verdict 'not_supportable' even when the deterministic core would draft", () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Strong'), routePickerViability: 'not_supportable' }))!;
    expect(r.verdict).toBe('not_supportable');
  });

  it("band 'needs_physician_review' → 'needs_review' headline", () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Strong'), routePickerViability: 'needs_physician_review' }))!;
    expect(r.verdict).toBe('needs_review');
  });

  it('a negative band on an UNREAD chart → read_chart_first (conservative overlay still applies on top of the band)', () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Stop'), hasUnreadPages: true, routePickerViability: 'not_supportable' }))!;
    expect(r.verdict).toBe('read_chart_first');
  });
});

describe('null band → deterministic fallback (prior behavior preserved)', () => {
  it("routePickerViability=null + strategy tier 'Stop' → deterministic not_supportable (NOT draft)", () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Stop'), routePickerViability: null }))!;
    expect(r.verdict).toBe('not_supportable');
    expect(r.disagreements.find((d) => d.source === 'band_vs_deterministic')).toBeUndefined();
  });
  it('routePickerViability omitted (undefined) behaves identically to null', () => {
    const r = computeReadinessVerdict(BASE({ strategy: strategy('Stop') }))!;
    expect(r.verdict).toBe('not_supportable');
  });
});
