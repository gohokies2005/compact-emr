import type { CaseStatus, Role } from './db-types.js';

export const CASE_STATUSES: readonly CaseStatus[] = [
  'intake',
  'records',
  'viability',
  'drafting',
  'rn_review',
  'physician_review',
  'correction_requested',
  'correction_review',
  'delivered',
  'paid',
  'rejected',
  'needs_rn_decision',
  'needs_records',
] as const;

export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  intake: ['records', 'rejected'],
  records: ['viability', 'rejected'],
  viability: ['drafting', 'rejected'],
  // A completed draft lands in rn_review (set by the drafter /complete handler). The RN reviews/
  // edits, then sends to the doctor. drafting->physician_review is kept for back-compat/manual use.
  // Gate-2 can park a drafting case for an RN decision (set by the internal /halt handler).
  drafting: ['rn_review', 'physician_review', 'needs_rn_decision', 'needs_records', 'rejected'],
  // RN review: "Send to doctor for review" -> physician_review; a redraft drops back to drafting;
  // or reject. (Ryan 2026-06-04: no auto-route to the doctor.)
  rn_review: ['physician_review', 'drafting', 'rejected'],
  physician_review: ['correction_requested', 'delivered', 'rejected'],
  correction_requested: ['correction_review'],
  correction_review: ['delivered', 'rejected'],
  delivered: ['paid'],
  paid: [],
  rejected: [],
  // Gate-2 parked states: the RN resumes (drafting via the rnDecision draft) or rejects. needs_records
  // can also drop back to records to gather more, then re-run.
  needs_rn_decision: ['drafting', 'records', 'rejected'],
  needs_records: ['drafting', 'records', 'rejected'],
};

// Statuses where staff work is actively parked or moving — deactivating the assigned RN/physician
// would strand the case. Shared by the users.ts + physicians.ts deactivation guards (each had a
// hand-copied list that silently omitted rn_review + the two Gate-2 halt statuses). Derived from
// CASE_STATUSES minus pre-flight (intake, records, viability) and terminal/post-work (delivered,
// paid, rejected) so a future status is in-flight by default unless explicitly excluded here.
const NOT_IN_FLIGHT: readonly CaseStatus[] = ['intake', 'records', 'viability', 'delivered', 'paid', 'rejected'];
export const IN_FLIGHT_CASE_STATUSES: readonly CaseStatus[] = CASE_STATUSES.filter(
  (s) => !NOT_IN_FLIGHT.includes(s),
);

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
