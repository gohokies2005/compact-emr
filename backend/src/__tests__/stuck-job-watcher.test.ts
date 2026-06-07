import { describe, expect, it, vi } from 'vitest';
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
    expect(r).toMatchObject({ scanned: 0, swept: 0 });
  });
});
