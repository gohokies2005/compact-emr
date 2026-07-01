import { describe, expect, it } from 'vitest';
import {
  CASE_STATUSES,
  CASE_STATUS_TRANSITIONS,
  IN_FLIGHT_CASE_STATUSES,
  canRolePerformCaseStatusTransition,
  isValidCaseStatusTransition,
} from '../services/case-status-transitions.js';

describe('case status transitions', () => {
  it('rejected is the only zero-out terminal state; paid now carries the physician-recall edge', () => {
    expect(CASE_STATUS_TRANSITIONS.rejected).toEqual([]);
    // paid is no longer a dead-end (2026-06-28): the physician/owner can RECALL a billed/closed letter to
    // correct it (return-to-physician door). The move does NOT auto-reverse billing.
    expect(CASE_STATUS_TRANSITIONS.paid).toEqual(['physician_review']);
  });

  // ── Return-to-physician recall edge (2026-06-28) ──────────────────────────
  it('paid -> physician_review is a VALID edge but ADMIN-ONLY on the generic /status route', () => {
    expect(isValidCaseStatusTransition('paid', 'physician_review')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'paid', 'physician_review')).toBe(true);
    // ops_staff + physician reach the paid recall ONLY through the dedicated, message-mandatory
    // /cases/:id/return-to-physician route (which does its own role gating) — NEVER via the bare /status
    // flip. Keeping the generic edge admin-only stops an RN silently reopening a closed/billed case.
    expect(canRolePerformCaseStatusTransition('ops_staff', 'paid', 'physician_review')).toBe(false);
    expect(canRolePerformCaseStatusTransition('physician', 'paid', 'physician_review')).toBe(false);
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
    // needs_rn_decision -> physician_review is the "see/edit/FORWARD" door (2026-06-22): a body-quality
    // park over a produced+editable draft must move forward to the doctor once the RN fixes it by hand,
    // never be trapped requiring a ~$15 re-draft to escape. (needs_records has no draft, so no such edge.)
    expect(CASE_STATUS_TRANSITIONS.needs_rn_decision).toEqual(['drafting', 'records', 'physician_review', 'rejected']);
    expect(CASE_STATUS_TRANSITIONS.needs_records).toEqual(['drafting', 'records', 'rejected']);
    // physician_review -> rn_review legalizes the drafter's live /complete flip after a redraft
    // started in physician_review (assessment 2026-06-12 flagged the hop as absent from the map).
    expect(CASE_STATUS_TRANSITIONS.physician_review).toEqual([
      'correction_requested',
      'delivered',
      'rn_review',
      'rejected',
    ]);
    // correction_requested -> physician_review is the RN "Send corrected letter to doctor" one-hop
    // (2026-07-01): correction_review is a dead state nothing enters, so this direct edge is the
    // corrected letter's forward door. No ->delivered edge is added (sign-off gate stays authoritative).
    expect(CASE_STATUS_TRANSITIONS.correction_requested).toEqual(['correction_review', 'physician_review']);
    // correction_review -> physician_review = RN "Send corrected letter back to the doctor" for a
    // fresh sign-off (correction-round SSOT, audit 2026-06-13); -> delivered stays but is physician/
    // admin-only (the bare RN flip the audit closed).
    expect(CASE_STATUS_TRANSITIONS.correction_review).toEqual(['physician_review', 'delivered', 'rejected']);
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

  // ── Forward door out of a body-quality park (2026-06-22, "see/edit/FORWARD — never a trap") ──
  it('needs_rn_decision -> physician_review exists and the RN (ops_staff) may forward a hand-fixed held letter to the doctor', () => {
    // The forward edge must be in the map (so the case can leave the park toward sign-off)...
    expect(CASE_STATUS_TRANSITIONS.needs_rn_decision).toContain('physician_review');
    // ...and the RN — the role that fixes the flagged section — must be allowed to drive it, identical
    // to the canonical rn_review -> physician_review "send to doctor" hop. Without this the held letter
    // could only go back to 'drafting' (re-draft, discarding the fix), which is the trap Ryan called out.
    expect(canRolePerformCaseStatusTransition('ops_staff', 'needs_rn_decision', 'physician_review')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'needs_rn_decision', 'physician_review')).toBe(true);
  });

  it('needs_records (no produced draft) has NO forward-to-physician edge — there is nothing to send', () => {
    // The map is the gate on which edges EXIST (role-permission is a separate, second check). A
    // needs_records park never produced a draft, so it has no forward-to-doctor door — only the map
    // (isValidCaseStatusTransition), not the role check, can express that "this edge does not exist".
    expect(CASE_STATUS_TRANSITIONS.needs_records).not.toContain('physician_review');
    expect(isValidCaseStatusTransition('needs_records', 'physician_review')).toBe(false);
    // Contrast: the body-quality park DOES have the forward edge.
    expect(isValidCaseStatusTransition('needs_rn_decision', 'physician_review')).toBe(true);
  });

  // ── Correction-round SSOT role gates (audit 2026-06-13) ───────────────────
  it('correction_review -> delivered is physician/admin-only — the RN can NOT bare-flip a corrected case to delivered (skipping /letter/approve + the sign-off byte gate)', () => {
    expect(canRolePerformCaseStatusTransition('ops_staff', 'correction_review', 'delivered')).toBe(false);
    expect(canRolePerformCaseStatusTransition('physician', 'correction_review', 'delivered')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'correction_review', 'delivered')).toBe(true);
  });

  it('correction_review -> physician_review exists and the RN (ops_staff) may send a corrected letter back to the doctor for a fresh sign-off', () => {
    expect(CASE_STATUS_TRANSITIONS.correction_review).toContain('physician_review');
    expect(canRolePerformCaseStatusTransition('ops_staff', 'correction_review', 'physician_review')).toBe(true);
  });

  // ── Correction-round forward door — the ONE-HOP send out of correction_requested (2026-07-01) ──
  // The physician declined + the RN hand-fixed the letter (edits, trivial edits, or NONE — editing does
  // not change status). The corrected letter must go straight back to the doctor. Previously the only
  // exit was correction_review, which NO code path ever entered (dead state), so the letter was stranded
  // (CLM-5FB43F91DE). This direct edge is the forward door.
  it('correction_requested -> physician_review exists and the RN (ops_staff) may send a corrected letter to the doctor', () => {
    expect(CASE_STATUS_TRANSITIONS.correction_requested).toContain('physician_review');
    expect(isValidCaseStatusTransition('correction_requested', 'physician_review')).toBe(true);
    expect(canRolePerformCaseStatusTransition('ops_staff', 'correction_requested', 'physician_review')).toBe(true);
    expect(canRolePerformCaseStatusTransition('admin', 'correction_requested', 'physician_review')).toBe(true);
  });

  it('correction_requested -> delivered is STILL invalid — the forward door does NOT add a bare-flip to delivered (sign-off gate stays authoritative)', () => {
    // The MAP is the gate on which edges EXIST (the /status route requires isValidCaseStatusTransition
    // AND canRolePerform). correction_requested has no ->delivered edge, so the bare flip is impossible on
    // the /status route for EVERY role — delivery goes through /letter/approve (re-render FINAL + the
    // fraud/signer/affirmativeness sign-off gates). (canRolePerform alone returns true for admin because
    // it never consults the map; the map is what closes this.)
    expect(CASE_STATUS_TRANSITIONS.correction_requested).not.toContain('delivered');
    expect(isValidCaseStatusTransition('correction_requested', 'delivered')).toBe(false);
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
