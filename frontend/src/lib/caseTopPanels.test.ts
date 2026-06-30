import { describe, expect, it } from 'vitest';
import {
  resolveCaseTopPanels,
  deriveLatestHaltSignals,
  type CaseTopPanelInputs,
  type DraftJobHaltShape,
} from './caseTopPanels';
import type { CaseStatus, Role } from '../types/prisma';

// C8c panel stability, 2026-06-14: pins the status×role→panel matrix the claim page's top region
// renders from. The gates were hoisted out of CaseDetailPage's IIFE into resolveCaseTopPanels; this
// test is the contract that the hoist was behavior-equivalent AND that a future refactor can't
// silently collapse the two INTENTIONAL co-render cells (drafting+failed shows Send-to-Drafter AND
// OpsHeld; drafting+ops_staff+letter shows OpsHeld AND the RN editor-entry card).

function inputs(over: Partial<CaseTopPanelInputs> & { status: CaseStatus; role: Role }): CaseTopPanelInputs {
  return {
    latestDraftState: undefined,
    hasLatestDraftJob: false,
    hasCompletedDraft: false,
    hasHaltedJob: false,
    hasHaltPayload: false,
    hasViewableLetterJob: false,
    runComplete: undefined,
    shipRecommendation: undefined,
    operatorState: undefined,
    ...over,
  };
}

describe('resolveCaseTopPanels', () => {
  it('in-flight draft (queued/running) shows ONLY the in-flight panel', () => {
    for (const state of ['queued', 'running']) {
      const p = resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', latestDraftState: state, hasLatestDraftJob: true }));
      expect(p.inFlightDraft).toBe(true);
      // everything that gates on !inFlightDraft is suppressed
      expect(p.canSendFirstDraft).toBe(false);
      expect(p.canSeeOpsHeldPanel).toBe(false); // canSeeOpsHeldPanel is gated on !inFlightDraft at the call site, but the resolver value itself only needs to NOT mis-fire here
      expect(p.canShowRnEditorEntry).toBe(false);
    }
  });

  it('a fresh case (no draft yet) lets RN/admin send the first draft', () => {
    for (const role of ['admin', 'ops_staff'] as Role[]) {
      const p = resolveCaseTopPanels(inputs({ status: 'intake', role }));
      expect(p.canSendFirstDraft).toBe(true);
    }
    // physician cannot kick off a draft
    expect(resolveCaseTopPanels(inputs({ status: 'intake', role: 'physician' })).canSendFirstDraft).toBe(false);
  });

  it('does NOT offer Send-to-Drafter once a draft has completed, or while parked at a halt', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'rn_review', role: 'ops_staff', hasCompletedDraft: true })).canSendFirstDraft).toBe(false);
    expect(resolveCaseTopPanels(inputs({ status: 'needs_rn_decision', role: 'ops_staff' })).canSendFirstDraft).toBe(false);
    expect(resolveCaseTopPanels(inputs({ status: 'needs_records', role: 'ops_staff' })).canSendFirstDraft).toBe(false);
  });

  it('physician_review shows the physician ready panel to physician/admin only', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'physician' })).canSeePhysicianReadyPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'admin' })).canSeePhysicianReadyPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'ops_staff' })).canSeePhysicianReadyPanel).toBe(false);
  });

  it('rn_review shows the RN review panel to RN/admin only', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'rn_review', role: 'ops_staff' })).canSeeRnReviewPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'rn_review', role: 'admin' })).canSeeRnReviewPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'rn_review', role: 'physician' })).canSeeRnReviewPanel).toBe(false);
  });

  it('OpsHeld fires on a drafting case that is non-ready (runComplete false / revise / non-ready operatorState)', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', runComplete: false })).canSeeOpsHeldPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', shipRecommendation: 'revise' })).canSeeOpsHeldPanel).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', operatorState: 'paused' })).canSeeOpsHeldPanel).toBe(true);
    // a clean ready operatorState does NOT hold
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', operatorState: 'ready' })).canSeeOpsHeldPanel).toBe(false);
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', operatorState: 'ready_with_notes' })).canSeeOpsHeldPanel).toBe(false);
    // physician never sees the held panel
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'physician', runComplete: false })).canSeeOpsHeldPanel).toBe(false);
  });

  it('Gate-2 halt panel fires on needs_rn_decision / needs_records (any role)', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'needs_rn_decision', role: 'ops_staff' })).isGate2Halt).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'needs_records', role: 'admin' })).isGate2Halt).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff' })).isGate2Halt).toBe(false);
  });

  // ── CANCELLED / WATCHER-RECONCILED draft: calm OpsHeld panel, NOT the dx-verification card ──
  // (Ryan 2026-06-29). A user-cancelled or watcher-reaped draft lands at needs_rn_decision +
  // operatorState='paused' with NO halt payload and NO halted job. The OLD gate read needs_rn_decision
  // as a Gate-2 halt and wrongly showed the dx card ("override / records are in / change the dx") whose
  // buttons are nonsensical for a cancelled case. The discriminator (isParkedWithoutHalt) routes it to
  // OpsHeld and EXCLUDES it from Gate2HaltPanel.
  it('cancelled/interrupted (needs_rn_decision + paused, no halt payload, no halted job) → OpsHeld, NOT Gate2', () => {
    const p = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'ops_staff', operatorState: 'paused',
      hasHaltPayload: false, hasHaltedJob: false,
    }));
    expect(p.canSeeOpsHeldPanel).toBe(true);   // calm "this draft did not finish — start a new draft" panel
    expect(p.isGate2Halt).toBe(false);          // dx-verification card suppressed
    expect(p.canSendFirstDraft).toBe(false);    // OpsHeld's "Re-run full draft" owns the single redraft action
  });

  it('cancelled/interrupted routes to OpsHeld for admin too', () => {
    const p = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'admin', operatorState: 'paused',
    }));
    expect(p.canSeeOpsHeldPanel).toBe(true);
    expect(p.isGate2Halt).toBe(false);
  });

  it('REAL dx-halt: needs_rn_decision + persisted halt payload STILL shows Gate2HaltPanel (no regression)', () => {
    // A genuine dx-verification halt carries haltPayloadJson (e.g. reasonCode dx_not_found) — it must
    // STILL render the Gate-2 card even if operatorState reads 'paused'.
    const withPayload = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'ops_staff', operatorState: 'paused', hasHaltPayload: true,
    }));
    expect(withPayload.isGate2Halt).toBe(true);
    expect(withPayload.canSeeOpsHeldPanel).toBe(false);
    // and via a job in 'halted' state (the other positive halt signal)
    const withHaltedJob = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'ops_staff', operatorState: 'paused', hasHaltedJob: true,
    }));
    expect(withHaltedJob.isGate2Halt).toBe(true);
    expect(withHaltedJob.canSeeOpsHeldPanel).toBe(false);
  });

  it('needs_records is UNCHANGED — still a Gate-2 halt, never the cancelled-draft path', () => {
    const p = resolveCaseTopPanels(inputs({ status: 'needs_records', role: 'ops_staff', operatorState: 'paused' }));
    expect(p.isGate2Halt).toBe(true);
    expect(p.canSeeOpsHeldPanel).toBe(false);
  });

  it('the RN-lock sky banner is ops_staff-only in physician_review', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'ops_staff' })).isRnLockBanner).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'admin' })).isRnLockBanner).toBe(false);
    expect(resolveCaseTopPanels(inputs({ status: 'physician_review', role: 'physician' })).isRnLockBanner).toBe(false);
  });

  it('the RN editor-entry card needs ops_staff + a viewable letter + drafting/correction_requested/correction_review + nothing in flight', () => {
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', hasViewableLetterJob: true })).canShowRnEditorEntry).toBe(true);
    // correction_requested = the doctor declined + sent the letter BACK to the RN; the RN must be able
    // to HAND-FIX it in the editor, not just View/Redraft (Dr. Kasky 2026-06-24; backend
    // EDITABLE_STATUSES already accepts it). This was the bug — correction_requested was missing here.
    expect(resolveCaseTopPanels(inputs({ status: 'correction_requested', role: 'ops_staff', hasViewableLetterJob: true })).canShowRnEditorEntry).toBe(true);
    expect(resolveCaseTopPanels(inputs({ status: 'correction_review', role: 'ops_staff', hasViewableLetterJob: true })).canShowRnEditorEntry).toBe(true);
    // no letter → no card
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', hasViewableLetterJob: false })).canShowRnEditorEntry).toBe(false);
    expect(resolveCaseTopPanels(inputs({ status: 'correction_requested', role: 'ops_staff', hasViewableLetterJob: false })).canShowRnEditorEntry).toBe(false);
    // in flight → no card
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'ops_staff', hasViewableLetterJob: true, latestDraftState: 'running', hasLatestDraftJob: true })).canShowRnEditorEntry).toBe(false);
    // admin/physician aren't the audience (they reach the editor via the ready panel)
    expect(resolveCaseTopPanels(inputs({ status: 'drafting', role: 'admin', hasViewableLetterJob: true })).canShowRnEditorEntry).toBe(false);
  });

  // ── INTERRUPTED DRAFT: single "Resume" affordance, NO parallel fresh-start (Ryan 2026-06-18) ──
  it('drafting + failed draft → OpsHeld (Resume) ONLY, NOT a parallel Send-to-Drafter', () => {
    // An interrupted draft (status='drafting', latest job 'failed', no completed letter) must offer ONE
    // clear "Resume draft" action via the OpsHeld panel — the bare fresh-start "Send to Drafter" is now
    // SUPPRESSED (was: both shown). Reverses the prior deliberate co-render per Ryan's directive.
    const p = resolveCaseTopPanels(inputs({
      status: 'drafting', role: 'ops_staff', latestDraftState: 'failed', hasLatestDraftJob: true,
      hasCompletedDraft: false, runComplete: false,
    }));
    expect(p.inFlightDraft).toBe(false);
    expect(p.canSeeOpsHeldPanel).toBe(true);
    expect(p.canSendFirstDraft).toBe(false); // suppressed — the interrupted panel owns the single action
  });

  it('ORPHANED draft: status=drafting + failed + NO operator signals still shows the interrupted panel (the scale-killed gap)', () => {
    // The scale-killed case the old gate MISSED: a Fargate task killed mid-run reaped to 'failed' with
    // NO runComplete/shipRecommendation/operatorState. Previously canSeeOpsHeldPanel was FALSE → the case
    // sat at a bare "Send to Drafter" with no "interrupted" explanation. Now it shows the Resume panel.
    const p = resolveCaseTopPanels(inputs({
      status: 'drafting', role: 'ops_staff', latestDraftState: 'failed', hasLatestDraftJob: true,
      hasCompletedDraft: false, runComplete: null, shipRecommendation: null, operatorState: null,
    }));
    expect(p.canSeeOpsHeldPanel).toBe(true);
    expect(p.canSendFirstDraft).toBe(false);
  });

  it('OVERLAP: drafting + ops_staff + viewable letter shows BOTH OpsHeld AND the RN editor-entry card', () => {
    const p = resolveCaseTopPanels(inputs({
      status: 'drafting', role: 'ops_staff', latestDraftState: 'failed', hasLatestDraftJob: true,
      hasViewableLetterJob: true, runComplete: false,
    }));
    expect(p.canSeeOpsHeldPanel).toBe(true);
    expect(p.canShowRnEditorEntry).toBe(true);
  });
});

// ── deriveLatestHaltSignals: NEWEST-job-only halt derivation (resume→cancel residual, 2026-06-30) ──
// CaseDetailPage previously read hasHaltPayload via .some() over ALL jobs and the halted job via .find()
// over ALL jobs. After a draft halted (job1=halted+payload) → RN resumed (job2 queued) → RN cancelled
// (job2=failed, case→needs_rn_decision+paused), job1's stale payload kept hasHaltPayload/hasHaltedJob
// true, so the cancelled case wrongly rendered the Gate-2 dx card. The fix derives BOTH signals from the
// newest job only. (draftJobs is newest-first — enqueuedAt DESC, backend cases.ts.)
describe('deriveLatestHaltSignals (newest-job-only halt derivation)', () => {
  it('resume→cancel residual: [failed (newest), halted+payload (older)] → NO halt signals', () => {
    const jobs: DraftJobHaltShape[] = [
      { state: 'failed', haltPayloadJson: null },                         // newest (the cancelled resume)
      { state: 'halted', haltPayloadJson: { reasonCode: 'dx_not_found' } }, // older (the original halt)
    ];
    const s = deriveLatestHaltSignals(jobs);
    expect(s.hasHaltPayload).toBe(false);
    expect(s.hasHaltedJob).toBe(false);

    // …and end-to-end through the resolver at the live state: it lands on OpsHeld, NOT Gate2.
    const p = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'ops_staff', operatorState: 'paused',
      hasHaltPayload: s.hasHaltPayload, hasHaltedJob: s.hasHaltedJob,
    }));
    expect(p.isGate2Halt).toBe(false);
    expect(p.canSeeOpsHeldPanel).toBe(true);
  });

  it('a real CURRENT halt (newest job halted+payload) STILL yields halt signals → Gate2 (no regression)', () => {
    const jobs: DraftJobHaltShape[] = [
      { state: 'halted', haltPayloadJson: { reasonCode: 'dx_not_found' } }, // newest IS the halt
    ];
    const s = deriveLatestHaltSignals(jobs);
    expect(s.hasHaltPayload).toBe(true);
    expect(s.hasHaltedJob).toBe(true);

    const p = resolveCaseTopPanels(inputs({
      status: 'needs_rn_decision', role: 'ops_staff', operatorState: 'paused',
      hasHaltPayload: s.hasHaltPayload, hasHaltedJob: s.hasHaltedJob,
    }));
    expect(p.isGate2Halt).toBe(true);
    expect(p.canSeeOpsHeldPanel).toBe(false);
  });

  it('empty / undefined history → no halt signals (no crash)', () => {
    expect(deriveLatestHaltSignals([])).toEqual({ hasHaltPayload: false, hasHaltedJob: false });
    expect(deriveLatestHaltSignals(undefined)).toEqual({ hasHaltPayload: false, hasHaltedJob: false });
  });
});
