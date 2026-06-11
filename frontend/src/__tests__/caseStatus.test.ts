import { describe, expect, it } from 'vitest';
import { CASE_STATUS_LABELS, CASE_STATUS_TRANSITIONS } from '../lib/caseStatus';
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
});
