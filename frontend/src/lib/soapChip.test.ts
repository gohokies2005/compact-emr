import { describe, it, expect } from 'vitest';
import { soapChipFromNote } from './soapChip';
import type { SoapNote } from '../api/case-viability';

const note = (action: SoapNote['action'], fallback = false): Pick<SoapNote, 'action' | 'fallback'> => ({ action, fallback });

describe('soapChipFromNote — chip color/label is a PURE function of the persisted SOAP verdict', () => {
  it('draft → green "Ready to draft"', () => {
    expect(soapChipFromNote(note('draft'))).toEqual({ label: 'Ready to draft', color: 'green' });
  });

  it('get_records / clarify / physician_review → amber (all the "needs a human step" actions)', () => {
    expect(soapChipFromNote(note('get_records'))).toEqual({ label: 'Records needed', color: 'amber' });
    expect(soapChipFromNote(note('clarify'))).toEqual({ label: 'Clarify with veteran', color: 'amber' });
    expect(soapChipFromNote(note('physician_review'))).toEqual({ label: 'Physician review', color: 'amber' });
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
});
