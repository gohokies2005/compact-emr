import type { CaseStatus, Role } from './db-types.js';

export const CASE_STATUSES: readonly CaseStatus[] = [
  'intake',
  'records',
  'viability',
  'drafting',
  'physician_review',
  'correction_requested',
  'correction_review',
  'delivered',
  'paid',
  'rejected',
] as const;

export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  intake: ['records', 'rejected'],
  records: ['viability', 'rejected'],
  viability: ['drafting', 'rejected'],
  drafting: ['physician_review', 'rejected'],
  physician_review: ['correction_requested', 'delivered', 'rejected'],
  correction_requested: ['correction_review'],
  correction_review: ['delivered', 'rejected'],
  delivered: ['paid'],
  paid: [],
  rejected: [],
};

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === 'string' && CASE_STATUSES.includes(value as CaseStatus);
}

export function isValidCaseStatusTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from].includes(to);
}

export function requiredRolesForCaseStatusTransition(from: CaseStatus, to: CaseStatus): readonly Role[] {
  if (from === 'delivered' && to === 'paid') return ['admin'];

  if (
    from === 'physician_review' &&
    (to === 'delivered' || to === 'correction_requested')
  ) {
    return ['physician', 'admin'];
  }

  return ['admin', 'ops_staff'];
}

export function canRolePerformCaseStatusTransition(
  role: Role,
  from: CaseStatus,
  to: CaseStatus,
): boolean {
  if (role === 'admin') return true;
  return requiredRolesForCaseStatusTransition(from, to).includes(role);
}
