import { describe, expect, it, vi } from 'vitest';

// Mock the auto-re-run primitive so ADDITION A's bounded re-run is observable + side-effect-free.
const rerunMock = vi.fn(async () => ({ enqueued: true, jobId: 'new-job', version: 4 }));
vi.mock('../services/draft-auto-rerun.js', () => ({
  enqueueAutoRerunForCase: (...args: unknown[]) => rerunMock(...(args as [])),
  DRAFT_AUTO_RERUN_ACTION: 'draft_job_auto_rerun',
}));

import { handler } from '../lambdas/stuck-job-watcher.js';
import type { PrismaClient } from '@prisma/client';

// Regression for the 2026-06-06 "reaped queued letters" incident: the watcher must NOT reap a
// 'queued' job that's merely waiting in the FIFO behind a long-running draft. It may reap a
// 'running' job whose heartbeat went stale, or a 'queued' job abandoned for hours (backstop).
function makePrisma(): { prisma: PrismaClient; calls: { where?: unknown } } {
  const calls: { where?: unknown } = {};
  const prisma = {
    draftJob: {
      findMany: vi.fn(async (args: { where: unknown }) => { calls.where = args.where; return []; }),
    },
    // case.findMany feeds the RECONCILE pass (Bug 1) — return [] so these reap-predicate tests stay
    // focused on the stale-job sweep query.
    case: { update: vi.fn(), findMany: vi.fn(async () => []) },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(async () => {}),
  } as unknown as PrismaClient;
  return { prisma, calls };
}

describe('stuck-job-watcher reap predicate (#8 watchdog fix)', () => {
  it('queries ONLY running+stale-heartbeat OR queued+abandoned — never queued on the 10-min clock', async () => {
    const { prisma, calls } = makePrisma();
    await handler(prisma);
    const where = calls.where as { OR: Array<Record<string, unknown>> };
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(3);

    const running = where.OR.find((c) => c['state'] === 'running');
    const queued = where.OR.find((c) => c['state'] === 'queued');
    expect(running).toBeDefined();
    expect(queued).toBeDefined();

    // running arm keys on lastHeartbeatAt staleness (~10 min)
    const rhb = (running!['lastHeartbeatAt'] as { lt: Date }).lt.getTime();
    expect(Date.now() - rhb).toBeGreaterThan(9 * 60 * 1000);
    expect(Date.now() - rhb).toBeLessThan(11 * 60 * 1000);

    // queued arm keys on enqueuedAt with the LARGE 2h budget — NOT 10 min (the bug)
    const qen = (queued!['enqueuedAt'] as { lt: Date }).lt.getTime();
    expect(Date.now() - qen).toBeGreaterThan(110 * 60 * 1000);

    // ABSOLUTE lifetime cap (Ryan 2026-06-07): ANY in-flight job older than ~60 min — catches a 'running'
    // job that never heartbeated. Keys on enqueuedAt at 60 min (well above the legit queue wait, so it
    // never reaps a healthy queued job).
    const lifetime = where.OR.find((c) => typeof c['state'] === 'object');
    expect(lifetime).toBeDefined();
    expect((lifetime!['state'] as { in: string[] }).in).toEqual(['queued', 'running']);
    const len = (lifetime!['enqueuedAt'] as { lt: Date }).lt.getTime();
    expect(Date.now() - len).toBeGreaterThan(59 * 60 * 1000);
    expect(Date.now() - len).toBeLessThan(61 * 60 * 1000);

    // The fatal old arm — { lastHeartbeatAt: null, enqueuedAt: <10min> } reaping queued — is gone.
    expect(where.OR.some((c) => c['lastHeartbeatAt'] === null)).toBe(false);
    // And there is no bare top-level state IN ('queued','running') that would catch fresh queued jobs.
    expect((where as Record<string, unknown>)['state']).toBeUndefined();
  });

  it('returns a no-op result when nothing is stale', async () => {
    const { prisma } = makePrisma();
    const r = await handler(prisma);
    expect(r).toMatchObject({ scanned: 0, swept: 0, autoReran: 0 });
  });

  // ADDITION A: a stale 'running' job is swept AND auto-re-run ONCE (bounded). A 'queued' abandoned job
  // is swept but NOT auto-re-run (avoid capacity thrash). The cap uses the activityLog count.
  function makePrismaWithStuck(stuck: Array<Record<string, unknown>>, priorReruns = 0): PrismaClient {
    return {
      // The sweep builds prisma.$transaction([draftJob.update(...), case.update(...), activityLog.create(...)])
      // so every delegate method referenced there must exist (they are evaluated to build the array).
      draftJob: { findMany: vi.fn(async () => stuck), update: vi.fn(() => ({})) },
      case: { update: vi.fn(() => ({})), findMany: vi.fn(async () => []) },
      activityLog: { create: vi.fn(() => ({})), count: vi.fn(async () => priorReruns) },
      $transaction: vi.fn(async () => {}),
    } as unknown as PrismaClient;
  }

  it('auto-re-runs a swept RUNNING job once (under the cap)', async () => {
    rerunMock.mockClear();
    const prisma = makePrismaWithStuck([
      { id: 'j1', caseId: 'c1', version: 3, state: 'running', lastHeartbeatAt: new Date(0), enqueuedAt: new Date(0), currentPhase: 'drafting' },
    ]);
    const r = await handler(prisma);
    expect(r.swept).toBe(1);
    expect(r.autoReran).toBe(1);
    expect(rerunMock).toHaveBeenCalledTimes(1);
    expect(rerunMock).toHaveBeenCalledWith(expect.anything(), 'c1', 3);
  });

  it('does NOT auto-re-run a swept QUEUED (abandoned) job — only running timeouts re-run', async () => {
    rerunMock.mockClear();
    const prisma = makePrismaWithStuck([
      { id: 'j2', caseId: 'c2', version: 1, state: 'queued', lastHeartbeatAt: null, enqueuedAt: new Date(0), currentPhase: null },
    ]);
    const r = await handler(prisma);
    expect(r.swept).toBe(1);
    expect(r.autoReran).toBe(0);
    expect(rerunMock).not.toHaveBeenCalled();
  });

  it('does NOT auto-re-run past the cap (a case that already auto-re-ran once)', async () => {
    rerunMock.mockClear();
    const prisma = makePrismaWithStuck([
      { id: 'j3', caseId: 'c3', version: 5, state: 'running', lastHeartbeatAt: new Date(0), enqueuedAt: new Date(0), currentPhase: 'drafting' },
    ], 1); // one prior auto-re-run in the window → at the cap
    const r = await handler(prisma);
    expect(r.swept).toBe(1);
    expect(r.autoReran).toBe(0);
    expect(rerunMock).not.toHaveBeenCalled();
  });
});

// RECONCILE pass (Bug 1, 2026-06-29): a case stranded at status='drafting' with its newest job already
// terminal (e.g. a pre-fix cancel, or Dick) is invisible to the stale-job sweep, so it read "Drafting"
// forever. The watcher must take it OFF 'drafting' → needs_rn_decision/paused, mirroring the cancel route.
describe('stuck-job-watcher reconcile pass (Bug 1 — stranded drafting cases)', () => {
  // The reconcile findMany now selects the newest draft job (state + completedAt/updatedAt) so the
  // handler can apply the 15-min staleness floor. `terminalMinutesAgo` controls how long the newest
  // job has been terminal — the floor leaves anything fresher than 15 min for the next sweep.
  type StrandedRow = { id: string; version: number; terminalMinutesAgo?: number; veteranId?: string };
  function strandedToRows(stranded: StrandedRow[]): Array<{ id: string; veteranId: string; version: number; draftJobs: Array<{ state: string; completedAt: Date; updatedAt: Date }> }> {
    return stranded.map((s) => {
      const terminalAt = new Date(Date.now() - (s.terminalMinutesAgo ?? 60) * 60 * 1000);
      return { id: s.id, veteranId: s.veteranId ?? `vet-${s.id}`, version: s.version, draftJobs: [{ state: 'failed', completedAt: terminalAt, updatedAt: terminalAt }] };
    });
  }
  function makeReconcilePrisma(stranded: StrandedRow[]): {
    prisma: PrismaClient; caseFindWhere: { value: unknown }; caseUpdate: ReturnType<typeof vi.fn>; logCreate: ReturnType<typeof vi.fn>; noteCreate: ReturnType<typeof vi.fn>;
  } {
    const rows = strandedToRows(stranded);
    const caseFindWhere: { value: unknown } = { value: undefined };
    const caseUpdate = vi.fn(() => ({}));
    const logCreate = vi.fn(() => ({}));
    const noteCreate = vi.fn(() => ({}));
    const prisma = {
      // No STALE in-flight jobs — the reconcile pass must still run off Case.status (Dick has a TERMINAL
      // job, so the stale-job findMany never returns it).
      draftJob: { findMany: vi.fn(async () => []), update: vi.fn(() => ({})) },
      case: {
        update: caseUpdate,
        findMany: vi.fn(async (args: { where: unknown }) => { caseFindWhere.value = args.where; return rows; }),
      },
      activityLog: { create: logCreate, count: vi.fn(async () => 0) },
      // In-chart quick note posted on reconcile (Ryan 2026-07-05) so the RN is notified in the chart.
      chartNote: { create: noteCreate },
      // Array form: prisma.case.update(...) / activityLog.create(...) / chartNote.create(...) are EVALUATED
      // to build the array, so their args are observable even though $transaction itself is stubbed.
      $transaction: vi.fn(async () => {}),
    } as unknown as PrismaClient;
    return { prisma, caseFindWhere, caseUpdate, logCreate, noteCreate };
  }

  it('reconciles a case stranded at drafting with a terminal newest job → needs_rn_decision/paused', async () => {
    const { prisma, caseFindWhere, caseUpdate, logCreate, noteCreate } = makeReconcilePrisma([{ id: 'DICK', version: 26 }]);
    const r = await handler(prisma);

    expect(r.reconciled).toBe(1);
    expect(r.swept).toBe(0);

    // Predicate (Ryan 2026-07-05): drafting + has a job but none queued/running. NO operatorState filter —
    // a PAUSED strand (a failed /complete leaving status='drafting' + operatorState='paused') must ALSO be
    // caught; the 30-min staleness floor keeps that safe from a still-settling callback / just-reaped case.
    const where = caseFindWhere.value as Record<string, unknown>;
    expect(where['status']).toBe('drafting');
    expect(where['operatorState']).toBeUndefined();
    expect(where['draftJobs']).toEqual({ some: {}, none: { state: { in: ['queued', 'running'] } } });

    // Transition mirrors the cancel route exactly.
    expect(caseUpdate).toHaveBeenCalledTimes(1);
    const upd = caseUpdate.mock.calls[0]![0] as { where: { id: string }; data: Record<string, unknown> };
    expect(upd.where).toEqual({ id: 'DICK' });
    expect(upd.data['status']).toBe('needs_rn_decision');
    expect(upd.data['operatorState']).toBe('paused');
    expect(upd.data['runComplete']).toBe(false);
    expect(upd.data['version']).toEqual({ increment: 1 });
    expect(typeof upd.data['operatorMessage']).toBe('string');

    expect(logCreate).toHaveBeenCalledTimes(1);
    const log = logCreate.mock.calls[0]![0] as { data: { action: string } };
    expect(log.data.action).toBe('case_drafting_reconciled');

    // An in-chart quick note is posted so the RN is notified IN the chart (top-of-chart + cases list),
    // keyed by veteranId, not only via the list status flip.
    expect(noteCreate).toHaveBeenCalledTimes(1);
    const note = noteCreate.mock.calls[0]![0] as { data: { isQuickNote: boolean; veteranId: string; body: string } };
    expect(note.data.isQuickNote).toBe(true);
    expect(note.data.veteranId).toBe('vet-DICK');
    expect(note.data.body).toMatch(/attention/i);
  });

  it('no stranded cases → reconciled 0, nothing mutated', async () => {
    const { prisma, caseUpdate } = makeReconcilePrisma([]);
    const r = await handler(prisma);
    expect(r.reconciled).toBe(0);
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  // STALENESS FLOOR (Fix 2026-06-30; raised 15→30 min 2026-07-05 when paused strands were included). The
  // reconcile pass must NOT fire the instant a job goes terminal — it could race a /complete callback that
  // is still settling, or clobber a just-reaped "interrupted" case. Only reconcile when the newest job has
  // been terminal for > 30 min. Guards against a future edit silently dropping the floor.
  it('does NOT reconcile a case whose newest job went terminal within the 30-min floor', async () => {
    const { prisma, caseUpdate } = makeReconcilePrisma([{ id: 'FRESH', version: 2, terminalMinutesAgo: 20 }]);
    const r = await handler(prisma);
    expect(r.reconciled).toBe(0);            // 20 min < 30-min floor — left for the next sweep
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  it('DOES reconcile a case whose newest job has been terminal past the 30-min floor', async () => {
    const { prisma, caseUpdate } = makeReconcilePrisma([{ id: 'STALE', version: 9, terminalMinutesAgo: 35 }]);
    const r = await handler(prisma);
    expect(r.reconciled).toBe(1);            // past the floor — reconciled
    expect(caseUpdate).toHaveBeenCalledTimes(1);
  });

  it('reconcile findMany selects the newest draft job (state + terminal timestamps) for the floor', async () => {
    const { prisma, caseFindWhere } = makeReconcilePrisma([{ id: 'STALE', version: 9, terminalMinutesAgo: 20 }]);
    // Capture the select arg too — the floor cannot work without the newest job's terminal timestamp.
    let selectArg: unknown;
    (prisma.case.findMany as ReturnType<typeof vi.fn>).mockImplementation(async (args: { where: unknown; select: unknown }) => {
      caseFindWhere.value = args.where; selectArg = args.select;
      return strandedToRows([{ id: 'STALE', version: 9, terminalMinutesAgo: 20 }]);
    });
    await handler(prisma);
    const select = selectArg as { draftJobs?: { orderBy?: unknown; take?: number; select?: Record<string, boolean> } };
    expect(select.draftJobs).toBeDefined();
    expect(select.draftJobs!.orderBy).toEqual({ enqueuedAt: 'desc' });
    expect(select.draftJobs!.take).toBe(1);
    expect(select.draftJobs!.select).toMatchObject({ completedAt: true, updatedAt: true });
  });
});
