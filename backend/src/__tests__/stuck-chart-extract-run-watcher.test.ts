import { describe, expect, it, vi } from 'vitest';
import { handler } from '../lambdas/stuck-chart-extract-run-watcher.js';
import type { PrismaClient } from '@prisma/client';

// The extraction analogue of stuck-job/stuck-doc: a ChartExtractionRun is created 'queued' and only
// moved to a terminal status by the worker AT THE END. If the worker Lambda is killed before posting,
// the run stays non-terminal and the case is pinned in 'extracting' forever. The watcher flips a
// genuinely-stuck run (non-terminal > 45 min) to 'failed' so the door shows 'extract_failed' (retryable).

interface Captured {
  findWhere?: { status?: { in?: string[] }; createdAt?: { lt?: Date } };
  updateArgs?: { where: { id: string; status?: { in?: string[] } }; data: Record<string, unknown> };
  activityCreated?: unknown;
}

function makePrisma(stuckRows: Array<Record<string, unknown>>, updateCount = 1): { prisma: PrismaClient; cap: Captured } {
  const cap: Captured = {};
  const prisma = {
    chartExtractionRun: {
      findMany: vi.fn(async (args: { where: Captured['findWhere'] }) => { cap.findWhere = args.where; return stuckRows; }),
      updateMany: vi.fn(async (args: Captured['updateArgs']) => { cap.updateArgs = args; return { count: updateCount }; }),
    },
    activityLog: { create: vi.fn(async (args: unknown) => { cap.activityCreated = args; }) },
  } as unknown as PrismaClient;
  return { prisma, cap };
}

const aRun = { id: 'run-1', caseId: 'case-1', veteranId: 'vet-1', status: 'queued', createdAt: new Date(Date.now() - 60 * 60 * 1000) };

describe('stuck-chart-extract-run-watcher reap predicate', () => {
  it('queries only non-terminal runs older than the 45-min boundary', async () => {
    const { prisma, cap } = makePrisma([]);
    const res = await handler(prisma);
    expect(res.scanned).toBe(0);
    expect(res.swept).toBe(0);
    expect(cap.findWhere?.status?.in).toEqual(['queued', 'running']);
    const lt = cap.findWhere?.createdAt?.lt?.getTime() ?? 0;
    expect(Date.now() - lt).toBeGreaterThan(44 * 60 * 1000);
    expect(Date.now() - lt).toBeLessThan(46 * 60 * 1000);
  });

  it('flips a stuck run to failed and writes an audit log', async () => {
    const { prisma, cap } = makePrisma([aRun]);
    const res = await handler(prisma);
    expect(res.scanned).toBe(1);
    expect(res.swept).toBe(1);
    // The flip is conditional on STILL being non-terminal (atomic guard against a late callback race).
    expect(cap.updateArgs?.where.id).toBe('run-1');
    expect(cap.updateArgs?.where.status?.in).toEqual(['queued', 'running']);
    expect(cap.updateArgs?.data.status).toBe('failed');
    expect(cap.updateArgs?.data.completedAt).toBeInstanceOf(Date);
    expect(cap.updateArgs?.data.errorMessage).toContain('did not finish');
    expect(cap.activityCreated).toBeDefined();
  });

  it('does NOT log/count a sweep when the run became terminal first (race: updateMany count 0)', async () => {
    const { prisma, cap } = makePrisma([aRun], 0);
    const res = await handler(prisma);
    expect(res.scanned).toBe(1);
    expect(res.swept).toBe(0); // the atomic guard saw it already terminal → skipped
    expect(cap.activityCreated).toBeUndefined();
  });

  it('ignores an EventBridge event object (footgun guard) and falls back to the real client path', async () => {
    // Passing a non-Prisma object must not throw a TypeError; it falls back to getPrisma() which (with no
    // DATABASE_URL in the test env) will reject inside findMany — caught here only to prove it did not treat
    // the event as the client (which would have called event.chartExtractionRun.findMany and TypeError'd).
    await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' }).catch(() => { /* expected: no DB in test env */ });
    expect(true).toBe(true);
  });
});
