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
    case: { update: vi.fn() },
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
      case: { update: vi.fn(() => ({})) },
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
