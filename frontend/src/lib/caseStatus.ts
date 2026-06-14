import type { CaseStatus, Role } from '../types/prisma';

// Mirrors backend/src/services/case-status-transitions.ts. Keep in sync with that file.
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  intake: ['records', 'rejected'],
  records: ['viability', 'rejected'],
  viability: ['drafting', 'rejected'],
  drafting: ['rn_review', 'physician_review', 'needs_rn_decision', 'needs_records', 'rejected'],
  rn_review: ['physician_review', 'drafting', 'rejected'],
  // physician_review -> rn_review: drafter /complete legalization (admin-only as a human move).
  physician_review: ['correction_requested', 'delivered', 'rn_review', 'rejected'],
  correction_requested: ['correction_review'],
  // correction_review -> physician_review: RN "Send corrected letter back to the doctor" for a fresh
  // sign-off (correction-round SSOT, audit 2026-06-13). correction_review -> delivered is physician/
  // admin-only below (closes the RN bare-flip that skipped /letter/approve + the sign-off byte gate).
  correction_review: ['physician_review', 'delivered', 'rejected'],
  // delivered -> physician_review: G4 stale-signature return (admin-only as a human move).
  delivered: ['paid', 'physician_review'],
  paid: [],
  rejected: [],
  needs_rn_decision: ['drafting', 'records', 'rejected'],
  needs_records: ['drafting', 'records', 'rejected'],
};

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  intake: 'Intake',
  records: 'Records',
  viability: 'Viability',
  drafting: 'Drafting',
  rn_review: 'RN review',
  physician_review: 'Physician review',
  correction_requested: 'Correction requested',
  correction_review: 'Correction review',
  // 'delivered' is the approve-transition target (physician approved, pre-payment). Nothing has
  // gone to the veteran yet — real delivery happens after Stripe payment ('paid'). Label only;
  // the enum value stays (transition map, delivery route, payment reconciliation all key on it).
  delivered: 'Ready for delivery',
  paid: 'Paid',
  rejected: 'Rejected',
  needs_rn_decision: 'Needs RN decision',
  needs_records: 'Needs records',
};

/**
 * Display label with the INVOICED overlay (Ryan 2026-06-12): once the RN sends the invoice email
 * (a letter_500 Payment row at status='invoiced'), a 'delivered' case READS "Invoiced" — same
 * neutral format, the label itself changes, no extra chip ("just change ready for delivery to
 * invoiced, keeping the same format"). The enum value stays 'delivered'; this is display-only.
 */
export function caseDisplayLabel(status: CaseStatus, opts?: { invoiced?: boolean | undefined }): string {
  if (status === 'delivered' && opts?.invoiced) return 'Invoiced';
  return CASE_STATUS_LABELS[status];
}

// Coarse display BUCKETS for the dashboard tiles + the cases-list status grouping (C0). These are
// presentation-only — they collapse the fine-grained workflow statuses into the ~9 buckets the RN
// thinks in ("whose ball is it"). The enum values are unchanged; nothing keys on these strings.
// 'Archived' is NOT a status — it comes from Case.archivedAt (a soft-delete flag), so it's an
// optional override here, matching the "archived = a flag, not a status" decision (Ryan 2026-06-13).
export type CaseStatusDisplayGroup =
  | 'Pre-draft'
  | 'Awaiting records'
  | 'Drafting'
  | 'RN review'
  | 'Physician review'
  | 'Awaiting payment'
  | 'Paid'
  | 'Rejected'
  | 'Archived';

const STATUS_DISPLAY_GROUP: Record<CaseStatus, CaseStatusDisplayGroup> = {
  intake: 'Pre-draft',
  viability: 'Pre-draft',
  records: 'Awaiting records',
  needs_records: 'Awaiting records',
  drafting: 'Drafting',
  // Gate-2 park, RN must decide; the doctor-declined corrections are RN work too — all "RN's ball".
  needs_rn_decision: 'RN review',
  rn_review: 'RN review',
  correction_requested: 'RN review',
  correction_review: 'RN review',
  physician_review: 'Physician review',
  // 'delivered' = physician-approved, pre-payment → the case is waiting on the veteran's payment.
  delivered: 'Awaiting payment',
  paid: 'Paid',
  rejected: 'Rejected',
};

export function statusDisplayGroup(status: CaseStatus, opts?: { archived?: boolean | undefined }): CaseStatusDisplayGroup {
  if (opts?.archived === true) return 'Archived';
  return STATUS_DISPLAY_GROUP[status];
}

export function validNextStatuses(from: CaseStatus): readonly CaseStatus[] {
  return CASE_STATUS_TRANSITIONS[from];
}

export function isValidCaseStatusTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from].includes(to);
}

// Mirrors backend requiredRolesForCaseStatusTransition. delivered->paid is admin-only;
// physician_review->delivered/correction_requested needs physician or admin; everything else admin or ops_staff.
export function requiredRolesForCaseStatusTransition(from: CaseStatus, to: CaseStatus): readonly Role[] {
  if (from === 'delivered' && to === 'paid') return ['admin'];
  // G4 stale-signature return + drafter /complete legalization are admin-only as human moves.
  if (from === 'delivered' && to === 'physician_review') return ['admin'];
  if (from === 'physician_review' && to === 'rn_review') return ['admin'];
  if (from === 'physician_review' && (to === 'delivered' || to === 'correction_requested')) return ['physician', 'admin'];
  // correction_review -> delivered is physician/admin-only (audit 2026-06-13) — the RN can no longer
  // bare-flip a corrected case to delivered, skipping /letter/approve + the sign-off byte gate.
  if (from === 'correction_review' && to === 'delivered') return ['physician', 'admin'];
  return ['admin', 'ops_staff'];
}

export function canRolePerformCaseStatusTransition(role: Role, from: CaseStatus, to: CaseStatus): boolean {
  if (role === 'admin') return true;
  return requiredRolesForCaseStatusTransition(from, to).includes(role);
}

// Next statuses the given role may actually move the case to (status-valid AND role-permitted).
export function allowedNextStatusesForRole(role: Role, from: CaseStatus): readonly CaseStatus[] {
  return validNextStatuses(from).filter((to) => canRolePerformCaseStatusTransition(role, from, to));
}
