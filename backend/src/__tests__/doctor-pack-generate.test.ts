import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { HttpError } from '../http/errors.js';

// Package 7 (2026-06-11): unit tests for the EXTRACTED Doctor Pack generate service — the
// single copy behind both POST /doctor-pack/generate ('manual') and the case status route's
// send-to-doctor auto-fire ('auto_send_to_doctor'). The two modes differ ONLY in the
// idempotency guard; these tests pin that contract:
//   - auto: skip (never throw) on queued/generating/ready at the CURRENT case version OR the
//     pre-transition version (manual-gen-then-send must not double-generate).
//   - manual: 409 on in-flight (queued/generating) at the current version; a READY pack does
//     NOT block — Regenerate keeps working.

vi.mock('../services/chart-summary-aggregator.js', () => ({
  aggregateChartSummary: vi.fn(async () => null),
}));

vi.mock('../services/doctor-pack-queue.js', () => ({
  publishDoctorPackQueued: vi.fn(async () => ({ skipped: true })),
}));

interface ExistingPack {
  readonly id: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly state: string;
  readonly createdAt: Date;
}

// Emulates the delegate's where-clause semantics for the two query shapes the service issues:
// caseVersion as a number ('manual') and caseVersion: { in: [...] } ('auto'), state: { in: [...] }.
function packFindFirstFor(existingPacks: readonly ExistingPack[]) {
  return vi.fn(async (args: { where: { caseId: string; caseVersion: number | { in: number[] }; state: { in: string[] } } }) => {
    const w = args.where;
    const versions = typeof w.caseVersion === 'number' ? [w.caseVersion] : w.caseVersion.in;
    const states = w.state.in;
    return existingPacks.find(
      (p) => p.caseId === w.caseId && versions.includes(p.caseVersion) && states.includes(p.state),
    ) ?? null;
  });
}

function makeGenDb(opts: { existingPacks?: readonly ExistingPack[]; caseVersion?: number } = {}) {
  const caseVersion = opts.caseVersion ?? 6;
  const created: { data?: Record<string, unknown> } = {};
  const activityLogCreate = vi.fn(async (_args: { data: { detailsJson: { trigger: string } } }) => ({}));
  const doctorPackCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    created.data = args.data;
    return { ...args.data, createdAt: new Date(), updatedAt: new Date(), version: 1 };
  });
  const tx = {
    keyDoc: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: 'kd-1', ...args.create })),
    },
    doctorPack: { create: doctorPackCreate },
    activityLog: { create: activityLogCreate },
  };
  const db = {
    case: {
      findFirst: vi.fn(async () => ({
        id: 'CASE-1',
        veteranId: 'VET-1',
        version: caseVersion,
        claimedCondition: 'obstructive sleep apnea',
        claimType: 'initial',
        framingChoice: null,
        upstreamScCondition: null,
        status: 'physician_review',
        cdsVerdict: 'not_yet_run',
        cdsOddsPct: null,
        cdsRationale: null,
        veteranStatement: null,
        inServiceEvent: null,
        documents: [{ id: 'doc-1', s3Key: 'cases/CASE-1/aaaa1111-DD-214.pdf', pageCount: 3, docTag: null }],
      })),
    },
    doctorPack: { findFirst: packFindFirstFor(opts.existingPacks ?? []) },
    fileReadStatus: { findMany: vi.fn(async () => []) },
    keyDoc: { findMany: vi.fn(async () => []) },
    documentPage: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as never, tx, created, spies: { doctorPackCreate, activityLogCreate, packFindFirst: db.doctorPack.findFirst } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDoctorPackForCase — auto_send_to_doctor trigger (Package 7)', () => {
  it('no existing pack: queues exactly ONE pack stamped with the current (post-transition) case version', async () => {
    const { db, created, spies } = makeGenDb({ caseVersion: 6 });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1',
      actorSub: 'RN-1',
      trigger: 'auto_send_to_doctor',
      priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
    expect(created.data?.caseVersion).toBe(6);
    expect(created.data?.state).toBe('queued');
    expect(created.data?.generatedBy).toBe('RN-1');
    // The audit row distinguishes the auto-fire from a manual Generate.
    const logArg = spies.activityLogCreate.mock.calls[0]?.[0];
    expect(logArg?.data.detailsJson.trigger).toBe('auto_send_to_doctor');
  });

  it('SKIPS (no create) when a ready pack exists at the current version — a re-fire does not duplicate', async () => {
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-1', caseId: 'CASE-1', caseVersion: 6, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' && result.existingPackId).toBe('pack-1');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('SKIPS when a ready pack exists at the PRE-transition version (RN generated manually, then clicked Send)', async () => {
    // The only mutation between priorCaseVersion (5) and the current version (6) is the status
    // flip itself, so the v5 pack reflects the identical chart — re-enqueueing would double-gen.
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-v5', caseId: 'CASE-1', caseVersion: 5, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' && result.existingPackId).toBe('pack-v5');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('SKIPS (does not throw) on an in-flight queued pack — auto mode never 409s', async () => {
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-q', caseId: 'CASE-1', caseVersion: 6, state: 'queued', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('a STALE pack (older version, not the prior one) does NOT block — new chart state regenerates', async () => {
    // Correction round-trip: pack from v2, case now at v6 (prior v5) — the chart/letter moved on.
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-old', caseId: 'CASE-1', caseVersion: 2, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
  });
});

describe('generateDoctorPackForCase — manual trigger (pre-extraction contract preserved)', () => {
  it('throws 409 on an in-flight (queued) pack at the current version', async () => {
    const { db } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-q', caseId: 'CASE-1', caseVersion: 6, state: 'queued', createdAt: new Date() }],
    });
    await expect(
      generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a READY pack does NOT block manual generation (Regenerate must keep working)', async () => {
    const { db, spies, created } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-r', caseId: 'CASE-1', caseVersion: 6, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
    const logArg = spies.activityLogCreate.mock.calls[0]?.[0];
    expect(logArg?.data.detailsJson.trigger).toBe('manual');
    expect(created.data?.caseVersion).toBe(6);
  });

  it('404s on an unknown case', async () => {
    const { db } = makeGenDb();
    (db as unknown as { case: { findFirst: ReturnType<typeof vi.fn> } }).case.findFirst.mockResolvedValue(null);
    await expect(
      generateDoctorPackForCase(db, { caseId: 'NOPE', actorSub: 'OPS-1' }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
