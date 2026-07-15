// Case Overview status CHIP — a PURE projection of the PERSISTED SOAP verdict (Ryan 2026-06-27).
//
// Dr. Kasky: the Case Overview chip (top-right of the SOAP card, e.g. "Needs review" with a colored dot)
// kept CHANGING COLOR on its own — amber→green→amber across loads/polls — because its color was recomputed
// LIVE every render from a separate engine (computeReadinessVerdict over the polling viability + coverage
// queries). It flickered and contradicted the stable SOAP body.
//
// The fix: the chip color is decided WHEN THE SOAP NOTE IS GENERATED and persisted WITH it (the note's
// `action`, stored in soap_overviews.result_json). So the chip stays LOCKED to the SOAP text — one color,
// stable across loads, until the SOAP is regenerated. White/neutral when there is no persisted SOAP yet.
//
// STATUS-COLOR DIRECTIVE (Ryan 2026-07-14, HARD: "make it GREEN"; amber ONLY for true caution): a
// physician-review action is NOT a caution — the RN preps the letter and the doctor confirms the theory at
// signing, so it reads GREEN with an action-directive label. The ONLY physician_review case that stays
// amber is a genuinely THIN case (the persisted note's route-picker band === 'marginal'), where the doctor's
// judgment call is a real gate. Old stored notes carry no band → green treatment (same band family). The
// go/no-go SEMANTICS are untouched — only labels/colors moved (oneBrainChip.agreement.test.ts still pins
// the band→action/verdict agreement).
//
// Pure + unit-tested so the verdict→chip mapping is pinned without a component-query harness.

import type { SoapNote } from '../api/case-viability';

export type ChipColor = 'green' | 'amber' | 'red' | 'neutral';

export interface SoapChip {
  readonly label: string;
  readonly color: ChipColor;
}

/** Hover tooltip for the chip (Ryan 2026-07-14): the chip is advisory, never a blocker (NO-BLOCK rule). */
export const SOAP_CHIP_TOOLTIP = "The AI's drafting-strategy read. It never blocks drafting.";

/** White/neutral default: no persisted SOAP yet (still generating, or a transient fallback note). The color
 *  only appears once the real SOAP exists — and then it's fixed. */
const NEUTRAL: SoapChip = { label: 'Preparing…', color: 'neutral' };

/**
 * Map the PERSISTED SOAP note → the Overview chip {label,color}. The color is a pure function of the SOAP
 * `action` (plus, for physician_review only, the persisted route-picker band that disambiguates the two
 * bands the action collapses), so the chip can NEVER contradict the SOAP body and NEVER recomputes/flickers
 * across loads:
 *   draft                                  → green "Ready to draft"
 *   get_records                            → amber "Records needed"
 *   clarify                                → amber "Clarify with veteran"
 *   physician_review + band 'marginal'     → amber "Draftable — thin case, doctor's judgment call"
 *   physician_review (any other/no band)   → green "Ready to draft — doctor confirms theory at signing"
 *   reject                                 → red   "Not supportable"
 * null / a TRANSIENT fallback note (note.fallback === true — the model truncated/failed and the real note
 * isn't persisted yet) → neutral/white "Preparing…". A persisted not-supportable note (fallback:false) is a
 * stable verdict and shows red, as it should.
 */
export function soapChipFromNote(note: Pick<SoapNote, 'action' | 'fallback' | 'viabilityBand'> | null | undefined): SoapChip {
  if (!note || note.fallback === true) return NEUTRAL;
  switch (note.action) {
    case 'draft': return { label: 'Ready to draft', color: 'green' };
    case 'get_records': return { label: 'Records needed', color: 'amber' };
    case 'clarify': return { label: 'Clarify with veteran', color: 'amber' };
    case 'physician_review':
      // Amber ONLY for a genuinely thin case (band 'marginal'). needs_physician_review — and every older
      // persisted note that carries no band — is the green family: ready to draft, doctor confirms at signing.
      return note.viabilityBand === 'marginal'
        ? { label: "Draftable — thin case, doctor's judgment call", color: 'amber' }
        : { label: 'Ready to draft — doctor confirms theory at signing', color: 'green' };
    case 'reject': return { label: 'Not supportable', color: 'red' };
    default: return NEUTRAL;
  }
}
