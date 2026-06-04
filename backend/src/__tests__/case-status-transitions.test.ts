import { describe, expect, it } from 'vitest';
import {
  CASE_STATUS_TRANSITIONS,
  canRolePerformCaseStatusTransition,
} from '../services/case-status-transitions.js';

describe('case status transitions', () => {
  it('terminal states accept zero outgoing transitions', () => {
    expect(CASE_STATUS_TRANSITIONS.paid).toEqual([]);
    expect(CASE_STATUS_TRANSITIONS.rejected).toEqual([]);
  });

  it('matches the full non-terminal transition table', () => {
    expect(CASE_STATUS_TRANSITIONS.intake).toEqual(['records', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.records).toEqual(['viability', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.viability).toEqual(['drafting', 'rejected']);
    // A completed draft lands in rn_review (RN reviews/edits, then sends to the doctor). No
    // auto-route to the physician. (Ryan 2026-06-04.)
    expect(CASE_STATUS_TRANSITIONS.drafting).toEqual(['rn_review', 'physician_review', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.rn_review).toEqual(['physician_review', 'drafting', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.physician_review).toEqual([
      'correction_requested',
      'delivered',
      'rejected',
    ]);
    expect(CASE_STATUS_TRANSITIONS.correction_requested).toEqual(['correction_review']);
    expect(CASE_STATUS_TRANSITIONS.correction_review).toEqual(['delivered', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.delivered).toEqual(['paid']);
  });

  it('rejects ops_staff attempting physician_review to delivered', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'physician_review', 'delivered')).toBe(false);
  });

  it('lets the RN (ops_staff) send rn_review to the doctor (physician_review)', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'rn_review', 'physician_review')).toBe(true);
  });

  it('allows admin on any transition', () => {
    expect(canRolePerformCaseStatusTransition('admin', 'paid', 'rejected')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'physician_review', 'delivered')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'delivered', 'paid')).toBe(true);
  });
});
