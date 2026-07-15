// Cross-module BAND→verdict/action agreement (Ryan 2026-06-22, Zimmelman FIX B; reframed 2026-07-04).
//
// HONEST AGREEMENT, NOT A FORCED MIRROR (Ryan 2026-07-04): the RUNTIME forced override — where the persisted
// SOAP `note.action` was set to `planViabilityToAction(band)` regardless of the model — has been RETIRED in
// soap-overview.ts. The SOAP model now owns its own reasoned go/no-go (deferring to the band as a strong
// input), so the live chip reflects the model's honest action, not a mechanical projection of the band.
//
// This test STILL guards the two BAND→ mapping FUNCTIONS, which remain live on the paths where the band IS
// authoritative because no model ran:
//   • the body headline: frontend/src/lib/caseReadinessVerdict.ts  routePickerBandToVerdict(band)
//   • the deterministic FALLBACK note (buildExplanatoryNote, model failed): backend soap-action-map.ts
//     planViabilityToAction(band)
// If those two maps ever disagreed on go/no-go for a band, a fallback note's Plan could contradict the
// headline chip. This test imports BOTH REAL functions and asserts they agree, band-for-band, on the single
// bit that matters: may drafting proceed?
//
// planViabilityToAction is imported from soap-action-map.ts, an SDK-FREE module extracted from
// soap-overview.ts precisely so this frontend test can import the REAL function without pulling the
// Anthropic SDK (which the frontend test env can't resolve). It is the SAME function soap-overview.ts
// re-exports and uses to drive the SOAP Plan action.
// STATUS-COLOR NOTE (Ryan 2026-07-14): the chip now renders a physician_review action GREEN ("Ready to
// draft — doctor confirms theory at signing") unless the persisted note's band is 'marginal' (amber). That is
// a LABEL/COLOR change in soapChip.ts only — the band→action and band→verdict DECISION maps below are
// untouched, and this test continues to pin that they agree on the single go/no-go bit.
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
