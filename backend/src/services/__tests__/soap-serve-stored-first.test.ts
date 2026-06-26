import { describe, it, expect } from 'vitest';
import { decideServeStored, SOAP_NOTE_SCHEMA_VERSION, type SoapNote } from '../soap-overview.js';

// Bays 2026-06-26: serve the REAL persisted SOAP note on a plain open despite route-picker inputHash
// drift (the hash-drift gate wedge), instead of regenerating a truncated ungrounded fallback.
const REAL: SoapNote = {
  subjective: 's', objective: 'o', assessment: 'a', plan: 'p',
  confidence: 'moderate', action: 'draft', caveat: null, fallback: false,
};
const row = (over: Partial<{ inputHash: string; schemaVersion: number; resultJson: unknown }> = {}) =>
  ({ inputHash: 'FP-GROUNDED', schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: REAL, ...over });

describe('decideServeStored — serve the real stored note despite inputHash drift (Bays)', () => {
  it('THE BUG: a current-shape real note is SERVED even when the live fingerprint drifted, with refresh=true', () => {
    const d = decideServeStored(row(), 'FP-UNGROUNDED-LIVE');
    expect(d).not.toBeNull();
    expect(d!.note).toEqual(REAL);   // the REAL note, not a regenerated fallback
    expect(d!.refresh).toBe(true);   // drift → caller fires ONE background auto-refresh
  });

  it('an UNCHANGED fingerprint serves the note with refresh=false (no needless recompute)', () => {
    const d = decideServeStored(row({ inputHash: 'FP-X' }), 'FP-X');
    expect(d!.refresh).toBe(false);
  });

  it('a fallback:true stored row is NOT served (returns null) — never serve a transient brief as durable', () => {
    expect(decideServeStored(row({ resultJson: { ...REAL, fallback: true } }), 'FP')).toBeNull();
  });

  it('a wrong-SHAPE stored row returns null (the shape-stale heal owns it)', () => {
    expect(decideServeStored(row({ schemaVersion: SOAP_NOTE_SCHEMA_VERSION - 1 }), 'FP-GROUNDED')).toBeNull();
  });

  it('no stored row / malformed json returns null (cold path falls through to generate)', () => {
    expect(decideServeStored(null, 'FP')).toBeNull();
    expect(decideServeStored(row({ resultJson: 'not-an-object' }), 'FP')).toBeNull();
  });
});
