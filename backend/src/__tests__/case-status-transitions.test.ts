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
    // physician_review -> rn_review legalizes the drafter's live /complete flip after a redraft
    // started in physician_review (assessment 2026-06-12 flagged the hop as absent from the map).
    expect(CASE_STATUS_TRANSITIONS.physician_review).toEqual([
      'correction_requested',
      'delivered',
      'rn_review',
      'rejected',
    ]);
    expect(CASE_STATUS_TRANSITIONS.correction_requested).toEqual(['correction_review']);
    expect(CASE_STATUS_TRANSITIONS.correction_review).toEqual(['delivered', 'rejected']);
    // delivered -> physician_review is the G4 stale-signature return (ratified sign/edit
    // lifecycle, Ryan 2026-06-12): an edit over the signed version sends the case back to the
    // doctor's queue for re-signature instead of sitting delivered with changed bytes.
    expect(CASE_STATUS_TRANSITIONS.delivered).toEqual(['paid', 'physician_review']);
  });

  it('rejects ops_staff attempting physician_review to delivered', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'physician_review', 'delivered')).toBe(false);
  });

  // ── Ratified sign/edit lifecycle role gates (2026-06-12) ──────────────────
  it('ops_staff can NOT self-unlock the G1 redraft lock by moving physician_review back to rn_review', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'physician_review', 'rn_review')).toBe(false);
    // The physician's reopen path is decline (-> correction_requested), not this hop, so the
    // legalized drafter-completion transition stays admin-only for humans too.
    expect(canRolePerformCaseStatusTransition('physician', 'physician_review', 'rn_review')).toBe(false);
    expect(canRolePerformCaseStatusTransition('admin', 'physician_review', 'rn_review')).toBe(true);
  });

  it('ops_staff can NOT manually pull a delivered (signed) case back to physician_review — the G4 return is system/admin-only', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'delivered', 'physician_review')).toBe(false);
    expect(canRolePerformCaseStatusTransition('physician', 'delivered', 'physician_review')).toBe(false);
    expect(canRolePerformCaseStatusTransition('admin', 'delivered', 'physician_review')).toBe(true);
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
