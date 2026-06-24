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
  // physician_review -> rn_review legalizes what the drafter already does LIVE: an admin redraft
  // started in physician_review parks the case in 'drafting' and the worker's /complete lands it
  // in rn_review (the assessment 2026-06-12 flagged the hop as absent from this map). It is NOT
  // an RN affordance — role-gated admin-only below so ops_staff cannot self-unlock the G1 redraft
  // lock by bouncing the case out of the doctor's queue. The doctor's reopen path stays
  // correction_requested (decline / "Send back to RN").
  physician_review: ['correction_requested', 'delivered', 'rn_review', 'rejected'],
  correction_requested: ['correction_review'],
  // correction_review -> physician_review is the RN "Send corrected letter back to the doctor"
  // action (correction-round SSOT, audit 2026-06-13): after a doctor decline + RN fix the corrected
  // letter MUST return to the physician's queue for a fresh sign-off — there was previously no edge
  // back to the doctor at all, so a corrected case could only go straight to 'delivered' (the bare
  // flip the audit closed). Mirrors rn_review->physician_review (the canonical "send to doctor" hop).
  // correction_review -> delivered stays, but is physician/admin-only below (an RN can no longer
  // bare-flip a corrected case to delivered, skipping /letter/approve and the sign-off byte gate).
  correction_review: ['physician_review', 'delivered', 'rejected'],
  // delivered -> physician_review is the G4 stale-signature return (ratified sign/edit lifecycle,
  // Ryan 2026-06-12): if a new letter version is ever created over the signed one post-approve,
  // the case returns to the doctor's queue for re-signature instead of sitting 'delivered' with
  // changed bytes until the delivery-time signed_bytes_changed 409. Performed by the letter
  // routes in-transaction; role-gated admin-only below as a manual move.
  delivered: ['paid', 'physician_review'],
  paid: [],
  rejected: [],
  // Gate-2 parked states: the RN resumes (drafting via the rnDecision draft) or rejects. needs_records
  // can also drop back to records to gather more, then re-run.
  //
  // needs_rn_decision -> physician_review (2026-06-22, "see/edit/FORWARD"): a body-quality park is a
  // SOFT advisory hold over a FULL produced draft (the /halt receiver advanced currentVersion onto it
  // and letter.ts made it editor-editable). Once the RN fixes the flagged section by hand, the hold is
  // resolved and the letter must move FORWARD to the doctor — never be trapped requiring a ~$15 re-draft
  // to escape. Without this edge the held-and-fixed letter could ONLY go back to 'drafting' (re-draft,
  // discarding the RN's fix) and sign-offs.ts correctly refused the parked case, so the human path the
  // sign-off error TOLD them to take ("fix + send to physician_review") didn't exist. This edge is the
  // forward door. Role = the default (admin, ops_staff) below — identical to the canonical
  // rn_review->physician_review "send to doctor" hop. The cases.ts middleware mirrors the assigned-
  // physician guard onto this edge so a held case can't land in the doctor's queue unassigned.
  needs_rn_decision: ['drafting', 'records', 'physician_review', 'rejected'],
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
  // G4 stale-signature return — system-performed by the letter routes (in-transaction, no role
  // check there); as a HUMAN move it is admin-only so ops_staff can never manually pull a
  // delivered (signed/approved) case back into a mutable status.
  if (from === 'delivered' && to === 'physician_review') return ['admin'];
  // Drafter-completion legalization (see map comment) — live performer is the drafter service
  // principal via the internal /complete route (which bypasses role checks); admin-only as a
  // human move so the RN cannot self-unlock the G1 redraft lock (physician reopen = decline).
  if (from === 'physician_review' && to === 'rn_review') return ['admin'];

  if (
    from === 'physician_review' &&
    (to === 'delivered' || to === 'correction_requested')
  ) {
    return ['physician', 'admin'];
  }
  // correction_review -> delivered is physician/admin-only (correction-round SSOT, audit 2026-06-13):
  // 'delivered' is the approve-transition target, reached through /letter/approve (re-render FINAL +
  // fraud/signer/affirmativeness gates). The default below would have let ops_staff (the RN) bare-flip
  // a corrected case to 'delivered', skipping every one of those gates. Mirrors the physician_review
  // ->delivered rule above. (The RN's path forward on a corrected case is correction_review->
  // physician_review — send it BACK to the doctor for a fresh sign-off, the new edge added above.)
  if (from === 'correction_review' && to === 'delivered') {
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
