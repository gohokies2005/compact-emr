// Keystone 4c — the post-merge restamp orchestrator: the CDS lane's gates (flag + provenance) and
// the per-group failure isolation (one group's throw can never starve the others or escape).
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { refreshDerivedStamps } from '../services/case-stamp-refresh.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import type { AppDb } from '../services/db-types.js';

interface CdsFixture {
  cdsVerdict: string;
  cdsStampSource: string | null;
}

// One full row serving every findFirst in the chain (the mocks ignore `select`). framing is
// 'manual' so the framing lane fast-skips; the viability lane is dark (flag unset) — this file
// focuses on the CDS lane + isolation; the framing/viability rules have their own suites.
function makeDb(cds: CdsFixture) {
  const caseUpdates: Record<string, unknown>[] = [];
  const activityCreates: Record<string, unknown>[] = [];
  const row = {
    id: 'CASE-1',
    veteranId: 'VET-1',
    claimedCondition: 'Obstructive sleep apnea',
    claimedConditions: ['Obstructive sleep apnea'],
    claimType: 'initial',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    framingStampSource: 'manual',
    veteranStatement: null,
    caseViabilityBand: null,
    caseViabilityAnchor: null,
    viabilityStampSource: null,
    ...cds,
    veteran: { scConditions: [{ condition: 'PTSD', ratingPct: 70, status: 'service_connected' }] },
  };
  const tx = {
    case: { update: vi.fn(async (a: { data: Record<string, unknown> }) => { caseUpdates.push(a.data); return a.data; }) },
    activityLog: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { activityCreates.push(a.data); return a.data; }) },
  };
  const db = {
    case: { findFirst: vi.fn(async () => row), update: tx.case.update },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', scConditions: [{ condition: 'PTSD' }], activeProblems: [{ problem: 'Obstructive sleep apnea' }] })) },
    activityLog: tx.activityLog,
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return { db, caseUpdates, activityCreates };
}

beforeEach(() => { delete process.env['CDS_ENABLED']; delete process.env['EMR_CASE_VIABILITY_ENABLED']; });
afterEach(() => { delete process.env['CDS_ENABLED']; delete process.env['EMR_CASE_VIABILITY_ENABLED']; });

describe('refreshDerivedStamps — CDS lane', () => {
  it('CDS_ENABLED off (the default): cds is skipped — the hook never re-activates the unwired engine', async () => {
    const { db, caseUpdates } = makeDb({ cdsVerdict: 'not_yet_run', cdsStampSource: null });
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.cds).toBe('skipped');
    expect(caseUpdates).toHaveLength(0);
  });

  it("cdsStampSource='manual' (RN-run) is immutable even with the engine on", async () => {
    process.env['CDS_ENABLED'] = 'on';
    const { db, caseUpdates } = makeDb({ cdsVerdict: 'accept', cdsStampSource: 'manual' });
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.cds).toBe('skipped');
    expect(caseUpdates).toHaveLength(0);
  });

  it('legacy null source with a real verdict is immutable (presumed possibly staff-run)', async () => {
    process.env['CDS_ENABLED'] = 'on';
    const { db, caseUpdates } = makeDb({ cdsVerdict: 'accept', cdsStampSource: null });
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.cds).toBe('skipped');
    expect(caseUpdates).toHaveLength(0);
  });

  it('never-run (not_yet_run + null source) FILLS: runs the engine, stamps derived, worker actor', async () => {
    process.env['CDS_ENABLED'] = 'on';
    const { db, caseUpdates, activityCreates } = makeDb({ cdsVerdict: 'not_yet_run', cdsStampSource: null });
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.cds).toBe('filled');
    expect(caseUpdates).toHaveLength(1);
    expect(caseUpdates[0]).toMatchObject({ cdsVerdict: 'accept', cdsStampSource: 'derived' });
    expect(activityCreates[0]).toMatchObject({ action: 'cds_evaluated', actorUserId: SERVICE_ACTORS.WORKER });
  });

  it("a prior hook-stamped ('derived') verdict is refreshed (overwritten)", async () => {
    process.env['CDS_ENABLED'] = 'on';
    const { db, caseUpdates } = makeDb({ cdsVerdict: 'caution', cdsStampSource: 'derived' });
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.cds).toBe('overwritten');
    expect(caseUpdates[0]).toMatchObject({ cdsStampSource: 'derived' });
  });
});

describe('refreshDerivedStamps — failure isolation', () => {
  it('a throwing group reports failed and NEVER escapes (the hook can never fail the merge callback)', async () => {
    const db = {
      case: { findFirst: vi.fn(async () => { throw new Error('db down'); }), update: vi.fn() },
      veteran: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as AppDb;
    const out = await refreshDerivedStamps(db, 'CASE-1');
    expect(out.framing).toBe('failed'); // threw inside, caught + reported
    expect(out.viability).toBe('skipped'); // dark flag — never reached the db
    expect(out.cds).toBe('skipped'); // engine off — never reached the db
  });
});
