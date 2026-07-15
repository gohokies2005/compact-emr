import { describe, it, expect } from 'vitest';
import { soapChipFromNote, SOAP_CHIP_TOOLTIP } from './soapChip';
import type { SoapNote } from '../api/case-viability';

const note = (
  action: SoapNote['action'],
  fallback = false,
  viabilityBand?: SoapNote['viabilityBand'],
): Pick<SoapNote, 'action' | 'fallback' | 'viabilityBand'> => ({ action, fallback, ...(viabilityBand !== undefined ? { viabilityBand } : {}) });

describe('soapChipFromNote — chip color/label is a PURE function of the persisted SOAP verdict', () => {
  it('draft → green "Ready to draft"', () => {
    expect(soapChipFromNote(note('draft'))).toEqual({ label: 'Ready to draft', color: 'green' });
  });

  it('get_records / clarify → amber (true "needs a human step" cautions)', () => {
    expect(soapChipFromNote(note('get_records'))).toEqual({ label: 'Records needed', color: 'amber' });
    expect(soapChipFromNote(note('clarify'))).toEqual({ label: 'Clarify with veteran', color: 'amber' });
  });

  // STATUS-COLOR DIRECTIVE (Ryan 2026-07-14, HARD: "make it GREEN"; amber ONLY for true caution).
  it('physician_review + band needs_physician_review → GREEN action-directive "Ready to draft — doctor confirms theory at signing"', () => {
    expect(soapChipFromNote(note('physician_review', false, 'needs_physician_review')))
      .toEqual({ label: 'Ready to draft — doctor confirms theory at signing', color: 'green' });
  });

  it('physician_review + band marginal → AMBER directive "Draftable — thin case, doctor\'s judgment call"', () => {
    expect(soapChipFromNote(note('physician_review', false, 'marginal')))
      .toEqual({ label: "Draftable — thin case, doctor's judgment call", color: 'amber' });
  });

  it('OLD persisted note (physician_review, NO band — pre-2026-07-14 DB rows) → GREEN treatment (same band family)', () => {
    expect(soapChipFromNote(note('physician_review')))
      .toEqual({ label: 'Ready to draft — doctor confirms theory at signing', color: 'green' });
  });

  it('reject → red "Not supportable" (a STABLE, persisted no-go shows red)', () => {
    expect(soapChipFromNote(note('reject'))).toEqual({ label: 'Not supportable', color: 'red' });
  });

  it('null (no persisted SOAP yet) → neutral/white "Preparing…" — the color only appears once the SOAP exists', () => {
    expect(soapChipFromNote(null)).toEqual({ label: 'Preparing…', color: 'neutral' });
    expect(soapChipFromNote(undefined)).toEqual({ label: 'Preparing…', color: 'neutral' });
  });

  it('a TRANSIENT fallback note (model truncated/failed, not persisted) → neutral, NOT a colored verdict', () => {
    // fallback:true means the real note is still being prepared — must not flash a green/red verdict.
    expect(soapChipFromNote(note('draft', true))).toEqual({ label: 'Preparing…', color: 'neutral' });
    expect(soapChipFromNote(note('reject', true))).toEqual({ label: 'Preparing…', color: 'neutral' });
  });

  it('STABILITY: the same persisted action always yields the same chip (no recompute/flicker)', () => {
    const a = soapChipFromNote(note('draft'));
    const b = soapChipFromNote(note('draft'));
    expect(a).toEqual(b);
  });

  it('the chip tooltip says the read is advisory and never blocks drafting (NO-BLOCK rule)', () => {
    expect(SOAP_CHIP_TOOLTIP).toMatch(/never blocks drafting/i);
  });

  // SEMANTICS GUARD: the color move is labels/colors ONLY — physician_review is still NOT the 'draft' action,
  // and reject is still the only red. The go/no-go decision layer (planViabilityToAction /
  // routePickerBandToVerdict) is pinned separately by oneBrainChip.agreement.test.ts.
  it('green physician_review chip still carries an action-directive label distinct from plain "Ready to draft"', () => {
    expect(soapChipFromNote(note('physician_review')).label).not.toBe(soapChipFromNote(note('draft')).label);
  });
});
