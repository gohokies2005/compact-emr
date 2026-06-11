import { describe, expect, it } from 'vitest';
import {
  CASE_STATUSES,
  CASE_STATUS_TRANSITIONS,
  IN_FLIGHT_CASE_STATUSES,
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
    // Gate-2 can park a drafting case for an RN decision.
    expect(CASE_STATUS_TRANSITIONS.drafting).toEqual(['rn_review', 'physician_review', 'needs_rn_decision', 'needs_records', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.rn_review).toEqual(['physician_review', 'drafting', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.needs_rn_decision).toEqual(['drafting', 'records', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.needs_records).toEqual(['drafting', 'records', 'rejected']);
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

  // The deactivation guards in users.ts + physicians.ts each carried a HAND-COPIED in-flight list
  // that silently omitted rn_review + the two Gate-2 halt statuses — a provider holding parked
  // work could be deactivated, stranding the case. The shared const is now the single source.
  describe('IN_FLIGHT_CASE_STATUSES (shared deactivation guard)', () => {
    it('contains the 3 statuses the old hand-copied lists were missing', () => {
      expect(IN_FLIGHT_CASE_STATUSES).toContain('rn_review');
      expect(IN_FLIGHT_CASE_STATUSES).toContain('needs_rn_decision');
      expect(IN_FLIGHT_CASE_STATUSES).toContain('needs_records');
    });

    it('is exactly every status where work is parked or moving (no pre-flight/terminal)', () => {
      expect([...IN_FLIGHT_CASE_STATUSES].sort()).toEqual(
        ['correction_requested', 'correction_review', 'drafting', 'needs_records', 'needs_rn_decision', 'physician_review', 'rn_review'].sort(),
      );
    });

    it('partitions the enum with the excluded set (a NEW status must land in one side deliberately)', () => {
      const excluded = CASE_STATUSES.filter((s) => !IN_FLIGHT_CASE_STATUSES.includes(s));
      expect([...excluded].sort()).toEqual(['delivered', 'intake', 'paid', 'records', 'rejected', 'viability'].sort());
      expect(IN_FLIGHT_CASE_STATUSES.length + excluded.length).toBe(CASE_STATUSES.length);
    });
  });
});
