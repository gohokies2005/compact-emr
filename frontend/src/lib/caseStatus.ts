import type { CaseStatus, Role } from '../types/prisma';

// Mirrors backend/src/services/case-status-transitions.ts. Keep in sync with that file.
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  intake: ['records', 'rejected'],
  records: ['viability', 'rejected'],
  viability: ['drafting', 'rejected'],
  drafting: ['rn_review', 'physician_review', 'needs_rn_decision', 'needs_records', 'rejected'],
  rn_review: ['physician_review', 'drafting', 'rejected'],
  physician_review: ['correction_requested', 'delivered', 'rejected'],
  correction_requested: ['correction_review'],
  correction_review: ['delivered', 'rejected'],
  delivered: ['paid'],
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
  delivered: 'Delivered',
  paid: 'Paid',
  rejected: 'Rejected',
  needs_rn_decision: 'Needs RN decision',
  needs_records: 'Needs records',
};

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
  if (from === 'physician_review' && (to === 'delivered' || to === 'correction_requested')) return ['physician', 'admin'];
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
