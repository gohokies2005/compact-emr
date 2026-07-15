import { describe, it, expect } from 'vitest';
import { intakeKind } from './intakes';

// KNOWN_FORMS belt-and-braces (2026-07): this frontend map was missing BOTH live stage-1 form IDs
// (paid first-time 261180463266153 + FB Fast-Track 261928293758069), so a blank/unhelpful form
// title made the intake pool label a brand-new veteran "Stage 2" and default the assign drawer
// wrong. Kept in sync with backend/src/services/intake-kind.ts (vendored logic).
describe('intakeKind ID-only classification (blank/unhelpful titles)', () => {
  it('classifies the FB Fast-Track form as stage1 by ID alone', () => {
    expect(intakeKind('261928293758069', '')).toBe('stage1');
    expect(intakeKind('261928293758069', null)).toBe('stage1');
    // "Fast-Track" matches none of the title regexes — the ID map must win.
    expect(intakeKind('261928293758069', 'FRN Fast-Track (FB)')).toBe('stage1');
  });

  it('classifies the paid first-time form as stage1 by ID alone', () => {
    expect(intakeKind('261180463266153', '')).toBe('stage1');
  });

  it('keeps the pre-existing known IDs classifying the same way', () => {
    expect(intakeKind('260898029223159', '')).toBe('stage1');
    expect(intakeKind('261495407772061', '')).toBe('stage1');
    expect(intakeKind('261483559233058', '')).toBe('stage2');
    expect(intakeKind('260804641700146', '')).toBe('additional_docs');
  });

  it('title match still takes precedence over the ID map', () => {
    expect(intakeKind('261928293758069', 'Upload additional records')).toBe('additional_docs');
  });

  it('unknown form + blank title defaults to stage2', () => {
    expect(intakeKind('999999999999999', '')).toBe('stage2');
  });
});
