// Cross-module ONE-BRAIN agreement (Ryan 2026-06-22, Zimmelman FIX B). The Overview chip and the SOAP note
// derive from the SAME route-picker band but in TWO different enums:
//   • the chip:  frontend/src/lib/caseReadinessVerdict.ts  routePickerBandToVerdict(band) → ReadinessVerdict
//   • the note:  backend/src/services/soap-action-map.ts   planViabilityToAction(band)    → SoapAction
// If these ever disagree on the go/no-go for a band, the chip ("Ready to draft") could contradict the note's
// Plan ("route to a physician") — the exact bug this fix kills. This test imports BOTH REAL functions and
// asserts they agree, band-for-band, on the single bit that matters: may drafting proceed?
//
// planViabilityToAction is imported from soap-action-map.ts, an SDK-FREE module extracted from
// soap-overview.ts precisely so this frontend test can import the REAL function without pulling the
// Anthropic SDK (which the frontend test env can't resolve). It is the SAME function soap-overview.ts
// re-exports and uses to drive the SOAP Plan action.
import { describe, expect, it } from 'vitest';
import { routePickerBandToVerdict, type ReadinessVerdict } from '../lib/caseReadinessVerdict';
import { planViabilityToAction, type RoutePickerViability } from '../../../backend/src/services/soap-action-map';

const ALL_BANDS: readonly RoutePickerViability[] = ['supportable', 'marginal', 'needs_physician_review', 'not_supportable'];

// A SOAP action is a "go" only when it is 'draft'. A chip verdict is a "go" when drafting may proceed.
function actionIsGo(band: RoutePickerViability): boolean {
  return planViabilityToAction(band) === 'draft';
}
function verdictIsGo(band: RoutePickerViability): boolean {
  const v: ReadinessVerdict = routePickerBandToVerdict(band);
  return v === 'draft' || v === 'draft_confirm_mechanism' || v === 'draft_reconcile' || v === 'draft_with_changes';
}

describe('chip verdict and SOAP action agree on go/no-go for every route-picker band', () => {
  it('routePickerBandToVerdict(band) go/no-go === planViabilityToAction(band) go/no-go', () => {
    for (const band of ALL_BANDS) {
      expect(verdictIsGo(band)).toBe(actionIsGo(band));
    }
  });
  it('supportable is the ONLY go band on both sides', () => {
    expect(ALL_BANDS.filter(verdictIsGo)).toEqual(['supportable']);
    expect(ALL_BANDS.filter(actionIsGo)).toEqual(['supportable']);
  });
  it('not_supportable maps to reject (note) and not_supportable (chip) — both no-go', () => {
    expect(planViabilityToAction('not_supportable')).toBe('reject');
    expect(routePickerBandToVerdict('not_supportable')).toBe('not_supportable');
    expect(actionIsGo('not_supportable')).toBe(false);
    expect(verdictIsGo('not_supportable')).toBe(false);
  });
});
