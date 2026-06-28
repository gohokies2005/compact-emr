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
// Pure + unit-tested so the verdict→chip mapping is pinned without a component-query harness.

import type { SoapNote } from '../api/case-viability';

export type ChipColor = 'green' | 'amber' | 'red' | 'neutral';

export interface SoapChip {
  readonly label: string;
  readonly color: ChipColor;
}

/** White/neutral default: no persisted SOAP yet (still generating, or a transient fallback note). The color
 *  only appears once the real SOAP exists — and then it's fixed. */
const NEUTRAL: SoapChip = { label: 'Preparing…', color: 'neutral' };

/**
 * Map the PERSISTED SOAP note → the Overview chip {label,color}. The color is a pure function of the SOAP
 * `action` (the go/no-go the route-picker brain decided once, which the SOAP Plan line also renders), so the
 * chip can NEVER contradict the SOAP body and NEVER recomputes/flickers across loads:
 *   draft            → green   "Ready to draft"
 *   get_records      → amber   "Records needed"
 *   clarify          → amber   "Clarify with veteran"
 *   physician_review → amber   "Physician review"
 *   reject           → red     "Not supportable"
 * null / a TRANSIENT fallback note (note.fallback === true — the model truncated/failed and the real note
 * isn't persisted yet) → neutral/white "Preparing…". A persisted not-supportable note (fallback:false) is a
 * stable verdict and shows red, as it should.
 */
export function soapChipFromNote(note: Pick<SoapNote, 'action' | 'fallback'> | null | undefined): SoapChip {
  if (!note || note.fallback === true) return NEUTRAL;
  switch (note.action) {
    case 'draft': return { label: 'Ready to draft', color: 'green' };
    case 'get_records': return { label: 'Records needed', color: 'amber' };
    case 'clarify': return { label: 'Clarify with veteran', color: 'amber' };
    case 'physician_review': return { label: 'Physician review', color: 'amber' };
    case 'reject': return { label: 'Not supportable', color: 'red' };
    default: return NEUTRAL;
  }
}
