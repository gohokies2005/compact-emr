// Tests for the IMPURE caseViability stamp adapter (build plan §3.2-3.5): the only-when-null
// persist guard, the fail-open paths, derivedAt route-stamping, and the EMR_CASE_VIABILITY_ENABLED
// flag helper. Mirrors case-framing-stamp.test.ts — a bug here silently overwrites an RN override
// or kills a draft on a vanished row.
import { afterEach, describe, it, expect } from 'vitest';
import { caseViabilityEnabled, deriveCaseViabilityForCase, stampCaseViability } from '../services/case-viability-stamp.js';
import type { DrafterBundle } from '../services/drafter-bundle.js';
import type { AppDb } from '../services/db-types.js';

interface UpdateCall { where: { id: string }; data: Record<string, unknown> }

interface CaseRowFixture {
  id: string;
  claimedCondition: string;
  claimType: string;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  veteranStatement: string | null;
  caseViabilityBand: string | null;
  caseViabilityAnchor: string | null;
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

function osaRow(overrides: Partial<CaseRowFixture> = {}): CaseRowFixture {
  return {
    id: 'case-1',
    claimedCondition: 'Obstructive Sleep Apnea',
    claimType: 'supplemental',
    framingChoice: null,
    upstreamScCondition: null,
    veteranStatement: null,
    caseViabilityBand: null,
    caseViabilityAnchor: null,
    veteran: {
      scConditions: [
        { condition: 'Anxiety', ratingPct: 70, status: 'service_connected' },
        { condition: 'Tinnitus', ratingPct: 10, status: 'service_connected' },
      ],
    },
    ...overrides,
  };
}

describe('caseViabilityEnabled (flag gate — ships DARK)', () => {
  afterEach(() => { delete process.env['EMR_CASE_VIABILITY_ENABLED']; });

  it('off by default (unset env)', () => {
    delete process.env['EMR_CASE_VIABILITY_ENABLED'];
    expect(caseViabilityEnabled()).toBe(false);
  });
  it("only the literal 'true' enables", () => {
    process.env['EMR_CASE_VIABILITY_ENABLED'] = 'true';
    expect(caseViabilityEnabled()).toBe(true);
    process.env['EMR_CASE_VIABILITY_ENABLED'] = 'on';
    expect(caseViabilityEnabled()).toBe(false);
  });
});

describe('deriveCaseViabilityForCase (the shared live derivation, G10)', () => {
  it('reuses the caseFraming grantedScAnchors: OSA + granted Anxiety/Tinnitus → moderate, best Anxiety / GAD (tinnitus excluded, never ranks)', async () => {
    const { db } = fakeDb(osaRow());
    const cv = await deriveCaseViabilityForCase(db, 'case-1');
    expect(cv?.version).toBe(1);
    expect(cv?.viability).toBe('moderate');
    expect(cv?.best_anchor?.upstream_canonical).toBe('Anxiety / GAD');
    expect(cv?.excluded_traps.map((t) => t.upstream_canonical)).toContain('Tinnitus');
    expect(cv).not.toHaveProperty('derivedAt'); // the live read is the pure shape
  });

  it('fail-open: missing case row → null, no throw', async () => {
    const { db } = fakeDb(null);
    expect(await deriveCaseViabilityForCase(db, 'case-1')).toBeNull();
  });

  it('strict anchor hygiene flows through: pending/denied conditions are NOT anchors', async () => {
    const { db } = fakeDb(osaRow({
      veteran: { scConditions: [{ condition: 'PTSD', ratingPct: 70, status: 'pending' }] },
    }));
    const cv = await deriveCaseViabilityForCase(db, 'case-1');
    expect(cv?.viability).toBe('weak'); // no granted anchor — pending PTSD never ranks
    expect(cv?.best_anchor).toBeNull();
  });
});

describe('stampCaseViability', () => {
  it('stamps the bundle (version 1 + derivedAt) and persists band+anchor onto null columns (persist: true)', async () => {
    const { db, updates } = fakeDb(osaRow());
    const out = await stampCaseViability(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseViability?.version).toBe(1);
    expect(out.caseViability?.viability).toBe('moderate');
    expect(out.caseViability?.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // route-stamped (G3)
    expect(out.bundleMeta).toEqual(BUNDLE.bundleMeta); // original bundle fields preserved
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toEqual({ caseViabilityBand: 'moderate', caseViabilityAnchor: 'Anxiety / GAD' });
  });

  it('ONLY-WHEN-NULL: a non-null caseViabilityBand (RN override) → zero writes, bundle still stamped', async () => {
    const { db, updates } = fakeDb(osaRow({ caseViabilityBand: 'weak' }));
    const out = await stampCaseViability(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseViability?.viability).toBe('moderate'); // bundle carries the fresh derivation
    expect(updates).toHaveLength(0); // the row value is never clobbered
  });

  it('persist: false stamps but never writes (the GET /drafter-export contract)', async () => {
    const { db, updates } = fakeDb(osaRow());
    const out = await stampCaseViability(db, 'case-1', BUNDLE, { persist: false });
    expect(out.caseViability?.viability).toBe('moderate');
    expect(updates).toHaveLength(0);
  });

  it('abstain band persists band but NEVER an anchor (graveyard-blocked HTN+PTSD)', async () => {
    const { db, updates } = fakeDb(osaRow({
      claimedCondition: 'Hypertension',
      veteran: { scConditions: [{ condition: 'PTSD', ratingPct: 70, status: 'service_connected' }] },
    }));
    const out = await stampCaseViability(db, 'case-1', BUNDLE, { persist: true });
    expect(out.caseViability?.viability).toBe('abstain');
    expect(out.caseViability?.graveyard_redirect?.redirect_blocked).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toEqual({ caseViabilityBand: 'abstain', caseViabilityAnchor: null });
  });

  it('fail-open: raced case delete (findFirst null) returns the bundle UNSTAMPED, no throw', async () => {
    const { db, updates } = fakeDb(null);
    const out = await stampCaseViability(db, 'case-1', BUNDLE, { persist: true });
    expect(out).toBe(BUNDLE);
    expect(out.caseViability).toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});
