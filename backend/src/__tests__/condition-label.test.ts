import { describe, expect, it } from 'vitest';
import { formatConditionLabel } from '../services/condition-label.js';

// Backend mirror of frontend/src/__tests__/conditionLabel.test.ts. condition-label.ts is kept
// byte-aligned with frontend/src/lib/conditionLabel.ts, so these assertions must match the frontend
// suite (the cover-memo subject/body and the EMR UI both call this formatter — they must agree).
describe('formatConditionLabel (backend mirror)', () => {
  it('syncs OSA / sleep apnea variants to one canonical label', () => {
    expect(formatConditionLabel('osa')).toBe('Obstructive Sleep Apnea (OSA)');
    expect(formatConditionLabel('sleep apnea')).toBe('Obstructive Sleep Apnea (OSA)');
  });
  it('cleans slug/underscore + casing', () => {
    expect(formatConditionLabel('unspecified_genitourinary')).toBe('Unspecified Genitourinary');
    expect(formatConditionLabel('hypertension')).toBe('Hypertension');
  });
  it('keeps acronyms uppercase + canonicalizes', () => {
    expect(formatConditionLabel('ptsd')).toBe('PTSD');
    expect(formatConditionLabel('gerd / gastritis')).toBe('GERD / Gastritis');
  });
  it('empty → empty', () => {
    expect(formatConditionLabel('')).toBe('');
    expect(formatConditionLabel(null)).toBe('');
  });

  // ── Defect 2 (2026-06-28): missing acronyms + spinal-level casing ──
  it('keeps newly-added acronyms uppercase (ckd/hld/dm2/sud/als/oa/djd)', () => {
    expect(formatConditionLabel('ckd')).toBe('CKD');
    expect(formatConditionLabel('hld')).toBe('HLD');
    expect(formatConditionLabel('dm2')).toBe('DM2');
    expect(formatConditionLabel('sud')).toBe('SUD');
    expect(formatConditionLabel('als')).toBe('ALS');
    expect(formatConditionLabel('djd')).toBe('DJD');
    expect(formatConditionLabel('mild osa')).toBe('Mild OSA');
  });
  it('normalizes spinal-level designations (uppercase BOTH vertebra letters)', () => {
    expect(formatConditionLabel('l5-s1')).toBe('L5-S1');
    expect(formatConditionLabel('c5-c6')).toBe('C5-C6');
    expect(formatConditionLabel('t12-l1')).toBe('T12-L1');
    expect(formatConditionLabel('l5-s1 djd')).toBe('L5-S1 DJD');
    expect(formatConditionLabel('L5-S1')).toBe('L5-S1');
  });
  it('title-cases a normal multi-word label + is idempotent', () => {
    expect(formatConditionLabel('lumbar strain')).toBe('Lumbar Strain');
    expect(formatConditionLabel('Lumbar Strain')).toBe('Lumbar Strain');
  });
});
