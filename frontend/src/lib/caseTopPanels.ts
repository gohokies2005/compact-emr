// C8c panel stability, 2026-06-14: the claim page's top-region drafter/review panels used to be a
// cascade of independent `&&` conditionals inside an IIFE, each computing its own gate inline. On
// every status/poll transition (case query polls 8s in records/viability/drafting, 15s while parked;
// draft-concurrency polls 8s while drafting) the region re-evaluated and panels mounted/unmounted,
// causing flicker/jump. This pure resolver hoists the SAME gates out so (a) the region renders from a
// single derived object instead of N inline expressions, and (b) the gating is unit-testable.
//
// CRITICAL — this is a STABILITY refactor, NOT a feature change. Each boolean here is the gate copied
// VERBATIM from the prior inline conditions; which panel shows when is byte-identical. The panels are
// NOT mutually exclusive: in status 'drafting' with a FAILED draft, sendToDrafter AND opsHeld are BOTH
// true (the stuck-job-watcher's operator copy literally says "click Send to Drafter again" while the
// "Drafting was interrupted" panel explains why) — so this returns the full boolean SET, never a single
// "primary panel" discriminant. Collapsing co-renderable panels into one slot would delete a
// deliberately-intended affordance. See CaseDetailPage stability tests for the pinned overlap cells.
import type { CaseStatus, Role } from '../types/prisma';

// The shape the resolver reads. Kept structural (not the full CaseDetail) so the helper stays pure and
// trivially testable — only the fields the gates actually consult.
export interface CaseTopPanelInputs {
  readonly status: CaseStatus;
  readonly role: Role;
  // latest DraftJob state (c.draftJobs?.[0]?.state); undefined when there are no jobs.
  readonly latestDraftState: string | undefined;
  readonly hasLatestDraftJob: boolean;
  // any job with state 'done' exists
  readonly hasCompletedDraft: boolean;
  // a job with state 'halted' exists (drives the Gate-2 halt panel's job prop upstream)
  readonly hasHaltedJob: boolean;
  // there is a viewable letter job (terminal/keyed) — gates the RN editor-entry card
  readonly hasViewableLetterJob: boolean;
  // held-state signals (OpsHeldPanel)
  readonly runComplete: boolean | null | undefined;
  readonly shipRecommendation: string | null | undefined;
  readonly operatorState: string | null | undefined;
}

export interface CaseTopPanels {
  // latest job queued or running → in-flight progress panel
  readonly inFlightDraft: boolean;
  // RN/admin can kick off the first draft (none in flight, none completed, not parked at a halt)
  readonly canSendFirstDraft: boolean;
  // physician/admin view of a sent letter (physician_review)
  readonly canSeePhysicianReadyPanel: boolean;
  // RN/admin view of a completed draft awaiting send (rn_review)
  readonly canSeeRnReviewPanel: boolean;
  // a drafting case that failed/came back non-ready (re-run + send-back)
  readonly canSeeOpsHeldPanel: boolean;
  // Gate-2 dx/event verification halt (needs_rn_decision / needs_records)
  readonly isGate2Halt: boolean;
  readonly hasHaltedJob: boolean;
  // ops_staff RN-lock notice while the doctor has the case (physician_review)
  readonly isRnLockBanner: boolean;
  // ops_staff letter-edit entry card (drafting / correction_review, letter present, nothing in flight)
  readonly canShowRnEditorEntry: boolean;
  // Extraction-coverage report — visible across the WHOLE staff working window (pre-draft, drafting, a
  // Gate-2 halt, rn_review), not just the narrow Send-to-Drafter moment, so the RN can always check how
  // much of the chart was read (Ryan 2026-06-14: it was missing during a Gate-2 halt). Advisory only.
  readonly canSeeExtractionCoverage: boolean;
}

// The staff working window where the chart matters + the extraction-coverage score is relevant. NOT
// physician_review / delivered / paid / rejected (the chart's read job is done by then).
const CHART_WORKING_STATUSES: readonly CaseStatus[] = [
  'intake', 'records', 'viability', 'drafting', 'needs_rn_decision', 'needs_records', 'rn_review',
];

// Pure resolution of which top-region panels are visible. Mirrors the prior inline gates EXACTLY.
export function resolveCaseTopPanels(input: CaseTopPanelInputs): CaseTopPanels {
  const { status, role, latestDraftState } = input;
  const isStaff = role === 'admin' || role === 'ops_staff';

  const inFlightDraft = latestDraftState === 'queued' || latestDraftState === 'running';

  // Hide "Send to Drafter" while parked at a Gate-2 halt — the halt panel owns the decision there.
  const isParkedAtHalt = status === 'needs_rn_decision' || status === 'needs_records';
  const canSendFirstDraft = isStaff && !inFlightDraft && !input.hasCompletedDraft && !isParkedAtHalt;

  const canSeePhysicianReadyPanel =
    status === 'physician_review' && (role === 'admin' || role === 'physician');

  const canSeeRnReviewPanel = status === 'rn_review' && isStaff;

  const canSeeOpsHeldPanel =
    isStaff &&
    status === 'drafting' &&
    (input.runComplete === false ||
      input.shipRecommendation === 'revise' ||
      (input.operatorState !== undefined &&
        input.operatorState !== null &&
        input.operatorState !== 'ready' &&
        input.operatorState !== 'ready_with_notes'));

  const isGate2Halt = status === 'needs_rn_decision' || status === 'needs_records';

  const isRnLockBanner = role === 'ops_staff' && status === 'physician_review';

  const canShowRnEditorEntry =
    !inFlightDraft &&
    role === 'ops_staff' &&
    input.hasViewableLetterJob &&
    (status === 'drafting' || status === 'correction_review');

  return {
    inFlightDraft,
    canSendFirstDraft,
    canSeePhysicianReadyPanel,
    canSeeRnReviewPanel,
    canSeeOpsHeldPanel,
    isGate2Halt,
    hasHaltedJob: input.hasHaltedJob,
    isRnLockBanner,
    canShowRnEditorEntry,
    canSeeExtractionCoverage: isStaff && CHART_WORKING_STATUSES.includes(status),
  };
}
