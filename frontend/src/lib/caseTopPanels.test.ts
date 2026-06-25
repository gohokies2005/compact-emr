import { describe, expect, it } from 'vitest';
import { resolveCaseTopPanels, type CaseTopPanelInputs } from './caseTopPanels';
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
