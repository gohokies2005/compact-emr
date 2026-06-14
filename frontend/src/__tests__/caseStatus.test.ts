import { describe, expect, it } from 'vitest';
import { CASE_STATUS_LABELS, CASE_STATUS_TRANSITIONS, statusDisplayGroup } from '../lib/caseStatus';
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
});
