// SDK-FREE one-brain action map (Ryan 2026-06-22, Zimmelman FIX B). Extracted from soap-overview.ts so the
// route-picker band → SOAP-action decision can be imported by a FRONTEND cross-module agreement test WITHOUT
// pulling the Anthropic SDK (soap-overview.ts imports @anthropic-ai/sdk at module top, which the frontend
// test environment cannot resolve). This file has NO runtime dependencies — pure types + one switch — so it
// is safe to import from either package. soap-overview.ts re-exports these so every existing importer is
// unchanged (byte-stable).

/** The route-picker plan's viability band (mirrors AiViabilityCard['viability']). */
export type RoutePickerViability = 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';

export type SoapAction = 'draft' | 'get_records' | 'clarify' | 'physician_review' | 'reject';

/**
 * Deterministic map from the route-picker plan's viability band to the SOAP Plan action (one-brain at the
 * action layer — so the Plan line cannot say "draft" when the drafter's brain says "not_supportable"). Used
 * to OVERRIDE the model's free `action` choice when a route-picker plan is grounding the note.
 *
 * MUST agree, band-for-band on go/no-go, with the frontend chip's routePickerBandToVerdict
 * (frontend/src/lib/caseReadinessVerdict.ts) — pinned by oneBrainChip.agreement.test.ts.
 */
export function planViabilityToAction(viability: RoutePickerViability): SoapAction {
  switch (viability) {
    case 'supportable': return 'draft';
    case 'marginal': return 'physician_review';
    case 'needs_physician_review': return 'physician_review';
    case 'not_supportable': return 'reject';
    default: return 'physician_review';
  }
}
