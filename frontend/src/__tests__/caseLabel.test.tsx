import { describe, expect, it } from 'vitest';
import { joinCaseLabel, resolveCaseLabel, type CaseLabelParts } from '../components/messaging/caseLabel';

// C4 (messaging, 2026-06-14): caseId -> "Veteran — Condition" resolution. The pure helpers underpin
// the inbox case chip, the ThreadView "linked to …" line, and the chart-tab locked-case chip — none
// of which should ever show a raw caseId UUID when the case is resolvable.
describe('joinCaseLabel', () => {
  it('joins veteran + condition with an em dash', () => {
    expect(joinCaseLabel('Lozano, Maria', 'Obstructive Sleep Apnea (OSA)', 'CASE-1')).toBe(
      'Lozano, Maria — Obstructive Sleep Apnea (OSA)',
    );
  });

  it('falls back to whichever single side is present', () => {
    expect(joinCaseLabel('Lozano, Maria', '', 'CASE-1')).toBe('Lozano, Maria');
    expect(joinCaseLabel('', 'PTSD', 'CASE-1')).toBe('PTSD');
  });

  it('falls back to the raw id when nothing resolves', () => {
    expect(joinCaseLabel('', '', 'CASE-1')).toBe('CASE-1');
  });
});

describe('resolveCaseLabel', () => {
  const byId: Readonly<Record<string, CaseLabelParts>> = {
    'CASE-1': { veteran: 'Lozano, Maria', condition: 'PTSD', label: 'Lozano, Maria — PTSD' },
  };

  it('resolves a known caseId to its friendly label', () => {
    expect(resolveCaseLabel('CASE-1', byId).label).toBe('Lozano, Maria — PTSD');
  });

  it('degrades to the raw caseId when the case is not in view', () => {
    const out = resolveCaseLabel('CASE-UNKNOWN', byId);
    expect(out.label).toBe('CASE-UNKNOWN');
    expect(out.veteran).toBe('');
    expect(out.condition).toBe('');
  });
});
