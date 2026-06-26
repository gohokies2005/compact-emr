import { describe, it, expect, vi, beforeEach } from 'vitest';

// The doctor's "send back to RN" note must REACH the RN on the case Action page. The RN Action tab
// renders the correction note only from Case.operatorMessage, and only /letter/decline sets it (plus a
// case-linked StaffMessage to the RN). The OLD sendBackToRn wrote the note to a veteran-scoped chart
// note (invisible on the Action page) — so the RN saw the status flip with no content (Dr. Kasky
// 2026-06-26). These tests pin that sendBackToRn now routes to declineLetter when a note is present.
vi.mock('../api/letter', () => ({
  declineLetter: vi.fn().mockResolvedValue({ data: { status: 'correction_requested' } }),
}));
vi.mock('../api/cases', async (orig) => {
  const actual = await orig<typeof import('../api/cases')>();
  return { ...actual, transitionCaseStatus: vi.fn().mockResolvedValue({ data: {} }) };
});
vi.mock('../api/chart-notes', () => ({ createChartNote: vi.fn() }));

import { sendBackToRn } from '../api/drafter';
import { declineLetter } from '../api/letter';
import { transitionCaseStatus } from '../api/cases';
import { createChartNote } from '../api/chart-notes';

describe('sendBackToRn — the doctor→RN note reaches the RN Action page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('WITH a note: routes to /letter/decline (sets operatorMessage + RN StaffMessage); no veteran chart note', async () => {
    await sendBackToRn({ caseId: 'C1', veteranId: 'V1', from: 'physician_review', version: 7, note: '  Rework as aggravation  ' });
    expect(declineLetter).toHaveBeenCalledWith('C1', { reason: 'Rework as aggravation' });
    expect(createChartNote).not.toHaveBeenCalled();        // the old, invisible path is gone
    expect(transitionCaseStatus).not.toHaveBeenCalled();   // decline does the transition itself
  });

  it('WITHOUT a note: a plain status transition, no decline / no message', async () => {
    await sendBackToRn({ caseId: 'C1', veteranId: 'V1', from: 'physician_review', version: 7 });
    expect(declineLetter).not.toHaveBeenCalled();
    expect(transitionCaseStatus).toHaveBeenCalledWith('C1', { from: 'physician_review', to: 'correction_requested', version: 7 });
    expect(createChartNote).not.toHaveBeenCalled();
  });
});
