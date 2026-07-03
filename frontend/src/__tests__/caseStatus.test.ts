import { describe, expect, it } from 'vitest';
import { CASE_STATUS_LABELS, CASE_STATUS_TRANSITIONS, statusDisplayGroup, lifecycleBucket, LIFECYCLE_BUCKET_ORDER, LIFECYCLE_BUCKET_LABELS, type LifecycleBucket } from '../lib/caseStatus';
import type { CaseStatus } from '../types/prisma';

describe('caseStatus maps', () => {
  const transitionKeys = Object.keys(CASE_STATUS_TRANSITIONS) as CaseStatus[];
  const labelKeys = Object.keys(CASE_STATUS_LABELS) as CaseStatus[];

  // No-orphan-status lock: every status has both a label and a transition entry, and every
  // transition target is itself a known status. A new enum value missing from either map
  // renders blank chips / dead dropdown options without this.
  it('labels and transitions cover the same status set', () => {
    expect([...labelKeys].sort()).toEqual([...transitionKeys].sort());
  });

  it('every transition target is a known status', () => {
    for (const from of transitionKeys) {
      for (const to of CASE_STATUS_TRANSITIONS[from]) {
        expect(transitionKeys).toContain(to);
      }
    }
  });

  it('every status has a non-empty human label', () => {
    for (const status of labelKeys) {
      expect(CASE_STATUS_LABELS[status].trim().length).toBeGreaterThan(0);
    }
  });

  // Ryan 2026-06-10: post-approve pre-payment showing "Delivered" was "totally wrong... dumb.
  // confusing." — nothing has gone to the veteran until payment. Display label only; the enum
  // value stays 'delivered'.
  it("labels 'delivered' as Ready for delivery (pre-payment, nothing sent to the veteran yet)", () => {
    expect(CASE_STATUS_LABELS.delivered).toBe('Ready for delivery');
  });

  // C0 — statusDisplayGroup() is the foundation for the dashboard tiles + cases-list grouping.
  describe('statusDisplayGroup', () => {
    it('maps every status to a non-empty bucket (no orphan status renders blank)', () => {
      for (const status of transitionKeys) {
        expect(statusDisplayGroup(status).length).toBeGreaterThan(0);
      }
    });

    it('buckets the load-bearing statuses where the RN expects them', () => {
      expect(statusDisplayGroup('intake')).toBe('Pre-draft');
      expect(statusDisplayGroup('records')).toBe('Awaiting records');
      expect(statusDisplayGroup('needs_records')).toBe('Awaiting records');
      expect(statusDisplayGroup('drafting')).toBe('Drafting');
      expect(statusDisplayGroup('rn_review')).toBe('RN review');
      expect(statusDisplayGroup('correction_requested')).toBe('RN review');
      expect(statusDisplayGroup('physician_review')).toBe('Physician review');
      expect(statusDisplayGroup('delivered')).toBe('Awaiting payment'); // pre-payment, not "Paid"
      expect(statusDisplayGroup('paid')).toBe('Paid');
      expect(statusDisplayGroup('rejected')).toBe('Rejected');
    });

    it('the archived flag overrides the status bucket (archived = a flag, not a status)', () => {
      expect(statusDisplayGroup('paid', { archived: true })).toBe('Archived');
      expect(statusDisplayGroup('rn_review', { archived: true })).toBe('Archived');
      expect(statusDisplayGroup('rn_review', { archived: false })).toBe('RN review');
    });
  });

  // Backend-parity guard for the RN "Revise & resend" reopen edges (2026-07-03). Mirrors
  // backend/src/services/case-status-transitions.ts; a drop here means the frontend map drifted.
  describe('revise-and-resend reopen edges (mirror backend)', () => {
    it('delivered reopens to correction_requested', () => {
      expect(CASE_STATUS_TRANSITIONS.delivered).toEqual(['paid', 'physician_review', 'correction_requested']);
    });
    it('paid carries the physician recall + the RN revise edges', () => {
      expect(CASE_STATUS_TRANSITIONS.paid).toEqual(['physician_review', 'correction_requested']);
    });
    it('correction_requested forwards to physician_review (send corrected letter to doctor)', () => {
      expect(CASE_STATUS_TRANSITIONS.correction_requested).toContain('physician_review');
    });
  });

  // === FIXED lifecycle grouping for the Cases page (Dr. Kasky 2026-06-24) ===
  describe('lifecycleBucket', () => {
    it('exposes the six buckets in the LOCKED top->bottom order', () => {
      expect(LIFECYCLE_BUCKET_ORDER).toEqual([
        'pre_draft', 'drafting', 'rn_review', 'physician_review', 'ready_for_delivery', 'invoiced',
      ]);
      // The human labels render in the same locked order.
      expect(LIFECYCLE_BUCKET_ORDER.map((b) => LIFECYCLE_BUCKET_LABELS[b])).toEqual([
        'Pre-draft', 'Drafting', 'RN review', 'Physician review', 'Ready for delivery', 'Invoiced',
      ]);
    });

    it('maps EVERY CaseStatus enum value to one of the six buckets (no orphan falls through)', () => {
      const validBuckets = new Set<LifecycleBucket>(LIFECYCLE_BUCKET_ORDER);
      for (const status of labelKeys) {
        const b = lifecycleBucket(status);
        expect(validBuckets.has(b)).toBe(true);
      }
    });

    it('maps each status to the expected lifecycle bucket', () => {
      // Pre-draft = everything before drafting starts (incl. the two pre-draft parks).
      expect(lifecycleBucket('intake')).toBe('pre_draft');
      expect(lifecycleBucket('records')).toBe('pre_draft');
      expect(lifecycleBucket('viability')).toBe('pre_draft');
      expect(lifecycleBucket('needs_records')).toBe('pre_draft');
      expect(lifecycleBucket('needs_rn_decision')).toBe('pre_draft');
      // Drafting = the pipeline is running.
      expect(lifecycleBucket('drafting')).toBe('drafting');
      // RN review = rn_review + the correction round.
      expect(lifecycleBucket('rn_review')).toBe('rn_review');
      expect(lifecycleBucket('correction_requested')).toBe('rn_review');
      expect(lifecycleBucket('correction_review')).toBe('rn_review');
      // Physician review.
      expect(lifecycleBucket('physician_review')).toBe('physician_review');
      // Ready for delivery = physician-approved, pre-payment / invoice-out.
      expect(lifecycleBucket('delivered')).toBe('ready_for_delivery');
      // Invoiced = the terminal billed/closed rung (paid + rejected fold here).
      expect(lifecycleBucket('paid')).toBe('invoiced');
      expect(lifecycleBucket('rejected')).toBe('invoiced');
    });

    it('routes a delivered case to the bucket matching its display label via the invoiced flag', () => {
      // No invoice out yet → Ready for delivery (label reads "Ready for delivery").
      expect(lifecycleBucket('delivered', { invoiced: false })).toBe('ready_for_delivery');
      expect(lifecycleBucket('delivered', {})).toBe('ready_for_delivery');
      // Invoice out → Invoiced bucket, mirroring caseDisplayLabel (label reads "Invoiced"), so the
      // case no longer sits under Ready for delivery while its chip says Invoiced.
      expect(lifecycleBucket('delivered', { invoiced: true })).toBe('invoiced');
      // The flag is ignored for every non-delivered status (e.g. paid stays terminal Invoiced).
      expect(lifecycleBucket('paid', { invoiced: true })).toBe('invoiced');
      expect(lifecycleBucket('physician_review', { invoiced: true })).toBe('physician_review');
    });
  });
});
