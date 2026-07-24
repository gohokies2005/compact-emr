// Step 1 (Ryan 2026-07-23): ONE reconciled case verdict — the note's action + the caution prose can no longer
// contradict the route-picker band. These cases are drawn from the real pre-draft trust audit (15 charts) so a
// regression here means the exact contradiction the audit found has come back.
import { describe, it, expect } from 'vitest';
import { withReconciledCaseVerdict, type SoapNote } from '../soap-overview.js';
import type { MechanismVerdict, MechanismPairing, DualMechanismVerdict } from '../mechanism-viability.js';
import type { RoutePickerViability } from '../soap-action-map.js';

function mkVerdict(band: MechanismVerdict['verdict']): MechanismVerdict {
  return { verdict: band, headline: 'h', reason: 'r', strongestCounterargument: 'c' };
}
function mkPairing(upstream: string, band: MechanismVerdict['verdict']): MechanismPairing {
  return { upstream, verdict: mkVerdict(band) };
}
function note(action: SoapNote['action'], assessment = 'A body.', plan = 'P body.'): SoapNote {
  return { subjective: 's', objective: 'o', assessment, plan, confidence: 'moderate', action, caveat: null };
}
function dual(claimed: string, leadBand: MechanismVerdict['verdict'] | null, vetBand: MechanismVerdict['verdict'] | null): DualMechanismVerdict {
  return {
    claimed,
    lead: leadBand ? mkPairing('Lead upstream', leadBand) : null,
    veteran: vetBand ? mkPairing('Veteran upstream', vetBand) : null,
  };
}

describe('withReconciledCaseVerdict — the three verdict voices become ONE', () => {
  it('band=supportable + model draft + no veto → DRAFT (Guzman/Guillen/Mark Lo)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'supportable', dual('OSA', 'borderline', 'borderline'), null);
    expect(out.action).toBe('draft');
  });

  it('band=supportable but a ⚠ BORDERLINE lead is SUPPRESSED on a draft (Guzman: no more "provider review" on a go)', () => {
    const withCaution = note('draft', '⚠ MECHANISM CHECK — BORDERLINE: strawman.\n\nReal assessment prose.', '⚠ Viability: BORDERLINE — recommend a provider review the viability before drafting.\n\nDraft now.');
    const out = withReconciledCaseVerdict(withCaution, 'supportable', dual('OSA', 'borderline', 'borderline'), null);
    expect(out.action).toBe('draft');
    // the ⚠ caution paragraphs are gone; the model prose survives
    expect(out.assessment).not.toMatch(/⚠/);
    expect(out.assessment).toContain('Real assessment prose.');
    expect(out.plan).not.toMatch(/provider review/i);
    expect(out.plan).toContain('Draft now.');
  });

  it('band=needs_physician_review but model said draft → HOLD, never draft (Lozano/Haines/Treadway/Palmer)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'needs_physician_review', dual('OSA', 'viable', null), null);
    expect(out.action).toBe('physician_review');
  });

  it('band=marginal + model draft → HOLD (amber caps the go)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'marginal', null, null);
    expect(out.action).toBe('physician_review');
  });

  it('band=supportable but model said get_records (missing essential) → KEEP the records hold (Dahill)', () => {
    const out = withReconciledCaseVerdict(note('get_records'), 'supportable', null, null);
    expect(out.action).toBe('get_records');
  });

  it('band=supportable but model said reject → KEEP the more-cautious reject (Johnson out-of-scope)', () => {
    const out = withReconciledCaseVerdict(note('reject'), 'supportable', null, null);
    expect(out.action).toBe('reject');
  });

  it('hard skeptic VETO: band=supportable + model draft but a not_viable pairing → downgrade to hold (tinnitus→OSA)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'supportable', dual('OSA', 'not_viable', null), null);
    expect(out.action).toBe('physician_review');
  });

  it('direct-axis not_viable also vetoes a draft', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'supportable', null, mkVerdict('not_viable'));
    expect(out.action).toBe('physician_review');
  });

  it('borderline does NOT veto a supportable draft (Guzman strawman protection)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'supportable', null, mkVerdict('borderline'));
    expect(out.action).toBe('draft');
  });

  it('HOLD keeps the ⚠ caution prose that explains it (Treadway)', () => {
    const withCaution = note('draft', '⚠ MECHANISM CHECK — NOT SUPPORTABLE AS FRAMED: no pathway.\n\nBody.', '⚠ Viability: NOT SUPPORTABLE AS FRAMED — provider review.\n\nPlan body.');
    const out = withReconciledCaseVerdict(withCaution, 'needs_physician_review', dual('OSA', 'not_viable', null), null);
    expect(out.action).toBe('physician_review');
    expect(out.assessment).toMatch(/⚠/); // caution retained on a hold
  });

  it('band=not_supportable → reject (decline)', () => {
    const out = withReconciledCaseVerdict(note('draft'), 'not_supportable', null, null);
    expect(out.action).toBe('reject');
  });

  it('ungrounded run (band null) → byte-identical to the old fold (action untouched)', () => {
    const n = note('draft');
    const out = withReconciledCaseVerdict(n, null, null, null);
    expect(out.action).toBe('draft');
    expect(out.assessment).toBe(n.assessment);
    expect(out.plan).toBe(n.plan);
  });
});
