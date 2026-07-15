import { describe, it, expect } from 'vitest';
import { intakeKind, isStage1 } from '../intake-kind.js';

// KNOWN_FORMS belt-and-braces (2026-07): the FB Fast-Track form's TITLE doesn't match any of the
// title regexes, so the ID map is the load-bearing classifier — a missing entry silently demotes a
// brand-new stage-1 veteran to the 'stage2' default (wrong assign defaults + undercounted "new
// intakes today" on the dashboard).
describe('intakeKind ID-only classification (blank/unhelpful titles)', () => {
  it('classifies the FB Fast-Track form as stage1 by ID with a BLANK title', () => {
    expect(intakeKind('261928293758069', '')).toBe('stage1');
    expect(intakeKind('261928293758069', null)).toBe('stage1');
    expect(intakeKind('261928293758069', undefined)).toBe('stage1');
  });

  it('classifies the FB Fast-Track form as stage1 by ID with an UNHELPFUL title', () => {
    // "Fast-Track" matches none of the title regexes — the ID map must win.
    expect(intakeKind('261928293758069', 'FRN Fast-Track (FB)')).toBe('stage1');
    expect(isStage1('261928293758069', 'FRN Fast-Track (FB)')).toBe(true);
  });

  it('classifies the paid first-time form as stage1 by ID alone', () => {
    expect(intakeKind('261180463266153', '')).toBe('stage1');
  });

  it('classifies the other known IDs correctly with blank titles', () => {
    expect(intakeKind('261495407772061', '')).toBe('stage1');      // returning-client no-fee
    expect(intakeKind('260898029223159', '')).toBe('stage1');      // old main stage-1 (historical)
    expect(intakeKind('261178428720156', '')).toBe('stage2');      // stage-2 master
    expect(intakeKind('261483559233058', '')).toBe('stage2');      // stage-2 condition form
    expect(intakeKind('260804641700146', '')).toBe('additional_docs'); // additional records
  });

  it('title match still takes precedence over the ID map', () => {
    // A stage-1 ID whose title clearly says additional-docs classifies by TITLE first.
    expect(intakeKind('261928293758069', 'Upload additional records')).toBe('additional_docs');
  });

  it('unknown form + blank title defaults to stage2 (a follow-up, not a new intake)', () => {
    expect(intakeKind('999999999999999', '')).toBe('stage2');
    expect(intakeKind(null, '')).toBe('stage2');
  });
});
