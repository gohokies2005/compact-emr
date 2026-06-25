// FIX 1 (QA architect + AI-SME, 2026-06-25): the case-framing stamp is the 4th SC read site. Before the fix
// it derived grantedScAnchors from RAW (un-reconciled) ScCondition rows, so a synonym/status dup ("PTSD"
// service_connected + "Post-traumatic stress disorder" pending) produced TWO granted anchors in the stamp
// while bundle.scConditions (reconciled at the other 3 sites) carried ONE row — a cross-field inconsistency
// inside a single drafter bundle. These tests pin that the stamp now reconciles its input rows first, so its
// granted-anchor set is consistent with reconcileScConditions.
import { describe, it, expect } from 'vitest';
import { deriveCaseFramingForCase } from '../case-framing-stamp.js';
import { reconcileScConditions } from '../sc-reconcile.js';
import { buildGrantedScAnchors } from '../case-framing.js';
import type { AppDb } from '../db-types.js';

// A minimal stub db exposing only case.findFirst — the one read fetchCaseRowForFraming makes.
function stubDb(row: unknown): AppDb {
  return { case: { findFirst: async () => row } } as unknown as AppDb;
}

const baseCase = (scConditions: Array<{ condition: string; ratingPct: number | null; status: string }>) => ({
  id: 'case-1',
  claimedCondition: 'Obstructive sleep apnea',
  claimType: 'initial',
  framingChoice: null,
  upstreamScCondition: null,
  framingStampSource: null,
  veteranStatement: null,
  veteran: { scConditions },
});

describe('case-framing-stamp — reconciles SC rows before deriving framing (4th read site)', () => {
  it('synonym-dup PTSD (SC + pending) yields ONE granted anchor in the stamp, matching the reconciled list', async () => {
    const sc = [
      { condition: 'PTSD', ratingPct: 70, status: 'service_connected' },
      { condition: 'Post-traumatic stress disorder', ratingPct: null, status: 'pending' },
    ];
    const cf = await deriveCaseFramingForCase(stubDb(baseCase(sc)), 'case-1');
    expect(cf).not.toBeNull();
    // ONE granted anchor (not two) — the synonym dup folded. The surviving display name is whichever row
    // reconcile picked (the service_connected "PTSD" wins on status precedence over the pending dup).
    expect(cf!.grantedScAnchors).toHaveLength(1);
    expect(cf!.grantedScAnchors[0]!.condition.toLowerCase()).toMatch(/ptsd|post-?traumatic/);

    // CONSISTENCY: the stamp's granted anchors equal what buildGrantedScAnchors would produce from the
    // RECONCILED rows — i.e. the stamp now sees the same single PTSD row the other 3 sites surface.
    const reconciled = reconcileScConditions(sc).map((s) => ({ condition: s.condition, ratingPct: s.ratingPct ?? null, status: String(s.status) }));
    const expectedAnchors = buildGrantedScAnchors(reconciled, 'Obstructive sleep apnea');
    expect(cf!.grantedScAnchors.map((a) => a.condition)).toEqual(expectedAnchors.map((a) => a.condition));
    expect(expectedAnchors).toHaveLength(1);
  });

  it('without reconcile the RAW rows would have produced TWO anchors (proves the fix changed behavior)', () => {
    const rawRows = [
      { condition: 'PTSD', ratingPct: 70, status: 'service_connected' },
      { condition: 'Post-traumatic stress disorder', ratingPct: 80, status: 'service_connected' },
    ];
    // buildGrantedScAnchors on RAW rows dedups only via trim+lowercase (no synonym fold) → TWO anchors.
    expect(buildGrantedScAnchors(rawRows, 'Obstructive sleep apnea')).toHaveLength(2);
    // The reconciled input collapses them to ONE.
    const reconciled = reconcileScConditions(rawRows).map((s) => ({ condition: s.condition, ratingPct: s.ratingPct ?? null, status: String(s.status) }));
    expect(buildGrantedScAnchors(reconciled, 'Obstructive sleep apnea')).toHaveLength(1);
  });

  it('a pending-only dup of a real grant surfaces the granted anchor (status precedence applied)', async () => {
    // "OSA service_connected" is the CLAIMED condition (self-anchor, excluded). Use a different anchor.
    const sc = [
      { condition: 'PTSD', ratingPct: null, status: 'pending' },
      { condition: 'Post-traumatic stress disorder', ratingPct: 70, status: 'service_connected' },
    ];
    const cf = await deriveCaseFramingForCase(stubDb(baseCase(sc)), 'case-1');
    expect(cf!.grantedScAnchors).toHaveLength(1);
    expect(cf!.grantedScAnchors[0]!.status).toBe('service_connected');
    expect(cf!.grantedScAnchors[0]!.ratingPct).toBe(70);
  });

  it('fails open: a vanished case row → null (no crash)', async () => {
    const cf = await deriveCaseFramingForCase(stubDb(null), 'missing');
    expect(cf).toBeNull();
  });
});
