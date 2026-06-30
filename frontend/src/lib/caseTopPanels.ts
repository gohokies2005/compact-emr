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
  // a persisted Gate-2 halt payload (DraftJob.haltPayloadJson) exists on ANY draft job. Together with
  // hasHaltedJob this is the positive signal of a REAL dx/event verification halt — distinguishing it
  // from a user-cancelled / watcher-reconciled draft that lands at needs_rn_decision with no halt data.
  readonly hasHaltPayload: boolean;
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
  // ops_staff letter-edit entry card (drafting / correction_requested / correction_review, letter
  // present, nothing in flight)
  readonly canShowRnEditorEntry: boolean;
  // Extraction-coverage report — visible across the WHOLE staff working window (pre-draft, drafting, a
  // Gate-2 halt, rn_review), not just the narrow Send-to-Drafter moment, so the RN can always check how
  // much of the chart was read (Ryan 2026-06-14: it was missing during a Gate-2 halt). Advisory only.
  readonly canSeeExtractionCoverage: boolean;
}

// The minimal shape of a DraftJob row the halt-signal derivation reads. The case API returns
// draftJobs ordered enqueuedAt DESC (backend cases.ts), so index 0 is ALWAYS the newest job.
export interface DraftJobHaltShape {
  readonly state?: string | null;
  readonly haltPayloadJson?: unknown;
}

// Derive the Gate-2 halt signals (hasHaltPayload / hasHaltedJob) from the NEWEST draft job ONLY.
//
// WHY newest-only (Fix, 2026-06-30): a draft halt that is later RESUMED (a new queued/drafting job)
// or CANCELLED (job→failed, case→needs_rn_decision+paused) leaves the OLD halted job AND its
// haltPayloadJson in the row history. The prior derivation read them with .some()/.find() over ALL
// jobs, so a stale prior halt out-voted the current state and a cancelled case wrongly rendered the
// Gate-2 dx card. Any job NEWER than a halt necessarily moved the case off that halt, so a genuine
// CURRENT halt is ALWAYS the latest job. `jobs` is newest-first (enqueuedAt DESC, per cases.ts).
export function deriveLatestHaltSignals(
  jobs: readonly DraftJobHaltShape[] | undefined,
): { hasHaltPayload: boolean; hasHaltedJob: boolean } {
  const latest = jobs?.[0];
  return {
    hasHaltPayload: !!latest?.haltPayloadJson,
    hasHaltedJob: latest?.state === 'halted',
  };
}

// The staff working window where the chart matters + the extraction-coverage score is relevant. NOT
// physician_review / delivered / paid / rejected (the chart's read job is done by then).
export const CHART_WORKING_STATUSES: readonly CaseStatus[] = [
  'intake', 'records', 'viability', 'drafting', 'needs_rn_decision', 'needs_records', 'rn_review',
];

// Pure resolution of which top-region panels are visible. Mirrors the prior inline gates EXACTLY.
export function resolveCaseTopPanels(input: CaseTopPanelInputs): CaseTopPanels {
  const { status, role, latestDraftState } = input;
  const isStaff = role === 'admin' || role === 'ops_staff';

  const inFlightDraft = latestDraftState === 'queued' || latestDraftState === 'running';

  // INTERRUPTED-DRAFT panel (Ryan 2026-06-18). Two ways a draft ends up needing recovery while the case
  // is still status='drafting':
  //   (a) operator-held — the run finished but was flagged (runComplete=false / revise / operatorState
  //       not-ready). The original OpsHeld gate.
  //   (b) ORPHANED/KILLED — the Fargate task was killed mid-run (ECS scale-in / deploy) and reaped to
  //       'failed', so NO operator signals were ever posted. The old gate MISSED this → the case showed
  //       a bare "Send to Drafter" (looked like a fresh start, no "it was interrupted" explanation) and
  //       silently sat at 'drafting'. THIS is the orphaned-status bug. latestDraftState==='failed' with
  //       no completed draft, in 'drafting' status, IS an interrupted draft.
  // CANCELLED / WATCHER-RECONCILED draft (Ryan 2026-06-29). When a user cancels a draft, or the
  // stuck-job watcher reaps/reconciles a dead run, the case lands at status='needs_rn_decision' +
  // operatorState='paused' with NO persisted halt payload and NO job in 'halted' state. This is NOT a
  // Gate-2 dx/event verification halt — it is an interrupted draft. The two gates below BOTH key on
  // this single predicate so they can never disagree about which case it is: it routes to the calm
  // OpsHeld "this draft did not finish — start a new draft" panel, and is EXCLUDED from isGate2Halt so
  // it never renders the dx-verification card (whose "override / records are in / change the dx"
  // buttons are nonsensical for a cancelled case). A REAL dx-halt always carries hasHaltPayload and/or
  // hasHaltedJob, so those two guards keep genuine halts on the Gate-2 panel even when operatorState
  // happens to read 'paused'.
  const isParkedWithoutHalt =
    status === 'needs_rn_decision' &&
    input.operatorState === 'paused' &&
    !input.hasHaltPayload &&
    !input.hasHaltedJob;

  const canSeeOpsHeldPanel =
    isStaff &&
    ((status === 'drafting' &&
      (input.runComplete === false ||
        input.shipRecommendation === 'revise' ||
        (latestDraftState === 'failed' && !input.hasCompletedDraft) ||
        (input.operatorState !== undefined &&
          input.operatorState !== null &&
          input.operatorState !== 'ready' &&
          input.operatorState !== 'ready_with_notes'))) ||
      isParkedWithoutHalt);

  // Hide "Send to Drafter" while parked at a Gate-2 halt — the halt panel owns the decision there.
  // ALSO hide it when the interrupted panel is showing (Ryan 2026-06-18): an interrupted draft must offer
  // ONE clear "Resume draft" action via the interrupted panel — NOT a confusing parallel fresh-start
  // "Send to Drafter" button. (Reverses the prior deliberate co-render of the two.)
  const isParkedAtHalt = status === 'needs_rn_decision' || status === 'needs_records';
  const canSendFirstDraft =
    isStaff && !inFlightDraft && !input.hasCompletedDraft && !isParkedAtHalt && !canSeeOpsHeldPanel;

  const canSeePhysicianReadyPanel =
    status === 'physician_review' && (role === 'admin' || role === 'physician');

  const canSeeRnReviewPanel = status === 'rn_review' && isStaff;

  // EXCLUDE the cancelled/interrupted case (isParkedWithoutHalt) so it stops routing to Gate2HaltPanel.
  // needs_records is unaffected (a records hold never carries operatorState='paused' as its signal).
  const isGate2Halt =
    (status === 'needs_rn_decision' || status === 'needs_records') && !isParkedWithoutHalt;

  const isRnLockBanner = role === 'ops_staff' && status === 'physician_review';

  // 'correction_requested' = the physician DECLINED the letter and sent it back to the RN (the
  // /letter/decline path; the case SITS here until the RN acts). The RN must be able to hand-fix it
  // in the full editor, not be forced to Redraft (Dr. Kasky 2026-06-24; backend EDITABLE_STATUSES
  // already accepts it — see letter.ts). 'correction_review' = the RN is actively reworking before
  // sending back to the doctor. Both are RN-editable post-draft states.
  const canShowRnEditorEntry =
    !inFlightDraft &&
    role === 'ops_staff' &&
    input.hasViewableLetterJob &&
    (status === 'drafting' || status === 'correction_requested' || status === 'correction_review');

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
