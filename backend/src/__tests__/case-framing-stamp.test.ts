// Tests for the IMPURE stamp adapter (architect QA fix 1, 2026-06-10): the never-clobber-RN
// persist guard and the raced-delete fail-open are the highest-risk paths in the SSOT producer —
// a bug here silently overwrites an RN's hand-set framing or kills a draft on a vanished row.
import { describe, it, expect } from 'vitest';
import { refreshDerivedFraming, stampCaseFraming } from '../services/case-framing-stamp.js';
import type { DrafterBundle } from '../services/drafter-bundle.js';
import type { AppDb } from '../services/db-types.js';

interface UpdateCall { where: { id: string }; data: Record<string, unknown> }

interface CaseRowFixture {
  id: string;
  claimedCondition: string;
  claimType: string;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  framingStampSource: string | null;
  veteranStatement: string | null;
  veteran: { scConditions: Array<{ condition: string; ratingPct: number | null; status: string }> } | null;
}

function fakeDb(row: CaseRowFixture | null): { db: AppDb; updates: UpdateCall[] } {
  const updates: UpdateCall[] = [];
  const db = {
    case: {
      findFirst: async () => row,
      update: async (args: UpdateCall) => { updates.push(args); return row; },
    },
  } as unknown as AppDb;
  return { db, updates };
}

const BUNDLE = {
  bundleMeta: { generatedAt: '2026-06-10T00:00:00.000Z', schemaVersion: '2' },
  chartReadiness: { ready: true, manualSummaryRequired: 0 },
} as unknown as DrafterBundle;

function hatfieldRow(overrides: Partial<CaseRowFixture> = {}): CaseRowFixture {
  return {
    id: 'case-1',
    claimedCondition: 'Obstructive Sleep Apnea',
    claimType: 'supplemental',
    framingChoice: null,
    upstreamScCondition: null,
    framingStampSource: null,
    veteranStatement: null,
    veteran: { scConditions: [{ condition: 'Anxiety', ratingPct: 70, status: 'service_connected' }] },
    ...overrides,
  };
}

describe('stampCaseFraming', () => {
  it('stamps the bundle and persists derived framing onto null columns (persist: true)', async () => {
    const { db, updates } = fakeDb(hatfieldRow());
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.version).toBe(1);
    expect(out.caseFraming?.framing).toBe('secondary');
    expect(out.caseFraming?.source).toBe('derived');
    expect(out.bundleMeta).toEqual(BUNDLE.bundleMeta); // original bundle fields preserved
    expect(updates).toHaveLength(1);
    // pkg 5: a FULL-pair machine write stamps framingStampSource='derived' (refreshable later).
    expect(updates[0]?.data).toEqual({ framingChoice: 'secondary', upstreamScCondition: 'Anxiety / GAD', framingStampSource: 'derived' });
  });

  it('NEVER clobbers RN-set values: non-null framingChoice + upstream → zero writes', async () => {
    const { db, updates } = fakeDb(hatfieldRow({ framingChoice: 'aggravation', upstreamScCondition: 'Anxiety' }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.source).toBe('rn_set');
    expect(updates).toHaveLength(0);
  });

  it('rn_set never invents an upstream: RN framingChoice set, upstream null → zero writes (contract mirrors verbatim)', async () => {
    const { db, updates } = fakeDb(hatfieldRow({ framingChoice: 'secondary' }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.source).toBe('rn_set');
    expect(out.caseFraming?.upstreamScCondition).toBeNull(); // verbatim mirror, not derived
    expect(updates).toHaveLength(0);
  });

  it('partial fill: RN named a scoreable upstream but no framingChoice → only framingChoice persists, NO provenance stamp (mixed provenance stays legacy-null = immutable)', async () => {
    const { db, updates } = fakeDb(hatfieldRow({ upstreamScCondition: 'PTSD' }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.source).toBe('derived');
    expect(out.caseFraming?.upstreamScCondition).toBe('PTSD'); // scoreable stored anchor kept
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toEqual({ framingChoice: 'secondary' }); // exact: no framingStampSource
  });

  it('derived direct is NOT persisted (column stays null = unframed)', async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      claimedCondition: 'Chronic migraines',
      claimType: 'initial',
      veteran: { scConditions: [] },
    }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.framing).toBe('direct');
    expect(updates).toHaveLength(0);
  });

  it('undetermined is NOT persisted', async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      claimedCondition: 'Chronic migraines',
      claimType: 'initial',
      framingChoice: 'secondary',
      veteran: { scConditions: [] },
    }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.framing).toBe('undetermined');
    expect(updates).toHaveLength(0);
  });

  it('persist: false stamps but never writes (the GET /drafter-export contract)', async () => {
    const { db, updates } = fakeDb(hatfieldRow());
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: false });
    expect(out.caseFraming?.framing).toBe('secondary');
    expect(updates).toHaveLength(0);
  });

  it('fail-open: raced case delete (findFirst null) returns the bundle UNSTAMPED, no throw', async () => {
    const { db, updates } = fakeDb(null);
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out).toBe(BUNDLE);
    expect(out.caseFraming).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  it('garbage-clear asymmetry is intentional: a non-null garbage anchor is never CLEARED by the stamp', async () => {
    // The backfill endpoint owns clearing garbage anchors on the row; the stamp only fills nulls.
    // The BUNDLE still gets the corrected (direct/cleared) framing — the row just stays dirty.
    const { db, updates } = fakeDb(hatfieldRow({
      claimedCondition: 'Chronic migraines',
      claimType: 'initial',
      upstreamScCondition: 'service I wake up with headaches',
      veteran: { scConditions: [] },
    }));
    const out = await stampCaseFraming(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseFraming?.framing).toBe('direct');
    expect(out.caseFraming?.upstreamScCondition).toBeNull(); // bundle view is corrected
    expect(updates).toHaveLength(0); // row left for the backfill endpoint to clean
  });
});

// Keystone 4c/5 — the refresh rule: derived → overwritable; manual + legacy-null → immutable;
// null COLUMNS still fill. This is what the post-merge restamp hook calls.
describe('refreshDerivedFraming (pkg 5 overwrite rule)', () => {
  it("source='derived': a STALE machine-stamped pair is overwritten by the fresh derivation", async () => {
    // Stored pair points at Tinnitus (stale — stamped before the Anxiety SC row merged in).
    const { db, updates } = fakeDb(hatfieldRow({
      framingChoice: 'secondary',
      upstreamScCondition: 'Tinnitus',
      framingStampSource: 'derived',
    }));
    const out = await refreshDerivedFraming(db, 'case-1');
    expect(out).toBe('overwritten');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toEqual({ framingChoice: 'secondary', upstreamScCondition: 'Anxiety / GAD', framingStampSource: 'derived' });
  });

  it("source='manual' (RN-set) is NEVER overwritten", async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      framingChoice: 'aggravation',
      upstreamScCondition: 'Tinnitus',
      framingStampSource: 'manual',
    }));
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('legacy NULL source with non-null values is immutable (presumed possibly RN-set)', async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      framingChoice: 'secondary',
      upstreamScCondition: 'Tinnitus',
      framingStampSource: null,
    }));
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('NULL source with NULL columns fills like draft time (+ the derived stamp)', async () => {
    const { db, updates } = fakeDb(hatfieldRow()); // all-null pair, anchor derivable
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('filled');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toEqual({ framingChoice: 'secondary', upstreamScCondition: 'Anxiety / GAD', framingStampSource: 'derived' });
  });

  it("source='derived' but the fresh derivation is direct/unpersistable → left alone (no clearing write)", async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      framingChoice: 'secondary',
      upstreamScCondition: 'Anxiety / GAD',
      framingStampSource: 'derived',
      veteran: { scConditions: [] }, // anchor vanished — fresh derivation can't produce a pair
    }));
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it("source='derived' with an UNCHANGED fresh derivation writes nothing (idempotent)", async () => {
    const { db, updates } = fakeDb(hatfieldRow({
      framingChoice: 'secondary',
      upstreamScCondition: 'Anxiety / GAD',
      framingStampSource: 'derived',
    }));
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('raced delete fails open (skipped, no throw)', async () => {
    const { db, updates } = fakeDb(null);
    expect(await refreshDerivedFraming(db, 'case-1')).toBe('skipped');
    expect(updates).toHaveLength(0);
  });
});
