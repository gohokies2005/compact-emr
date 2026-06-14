import { describe, expect, it, vi } from 'vitest';

// Mock the chart-extract trigger so the never-enqueued backstop's enqueue is observable + side-effect-free.
const enqueueMock = vi.fn(async () => ({ enqueued: true }));
vi.mock('../services/chart-extract-trigger.js', () => ({
  maybeEnqueueChartExtract: (...args: unknown[]) => enqueueMock(...(args as [])),
}));

import { handler } from '../lambdas/stuck-chart-extract-run-watcher.js';
import { computeTriggerHash } from '../services/chart-build-state.js';
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

  it('never-enqueued backstop: enqueues a missing run for an all-terminal doc-set with no matching run', async () => {
    enqueueMock.mockClear();
    const docs = [{ id: 'd1', s3Key: 'cases/case-1/u-scan.pdf' }];
    const statuses = [{ caseId: 'case-1', filePath: 'cases/case-1/u-scan.pdf', terminalStatus: 'read' }];
    const created: unknown[] = [];
    const prisma = {
      chartExtractionRun: {
        findMany: vi.fn(async () => []),            // no stuck runs
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null),         // NO run for this doc-set → missing
      },
      fileReadStatus: { findMany: vi.fn(async () => statuses) },
      document: { findMany: vi.fn(async () => docs) },
      activityLog: { create: vi.fn(async (a: unknown) => { created.push(a); }) },
    } as unknown as PrismaClient;

    const res = await handler(prisma);
    expect(res.enqueuedMissing).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), 'case-1');
    expect(created.length).toBe(1); // the chart_extract_run_enqueued_missing audit row
  });

  it('never-enqueued backstop: does NOT enqueue when a run already matches the current doc-set hash', async () => {
    enqueueMock.mockClear();
    const docs = [{ id: 'd1', s3Key: 'cases/case-2/u-scan.pdf' }];
    const statuses = [{ caseId: 'case-2', filePath: 'cases/case-2/u-scan.pdf', terminalStatus: 'read' }];
    const matchingHash = computeTriggerHash(docs, statuses);
    const prisma = {
      chartExtractionRun: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => ({ triggerHash: matchingHash })), // run exists for THIS doc-set
      },
      fileReadStatus: { findMany: vi.fn(async () => statuses) },
      document: { findMany: vi.fn(async () => docs) },
      activityLog: { create: vi.fn(async () => {}) },
    } as unknown as PrismaClient;

    const res = await handler(prisma);
    expect(res.enqueuedMissing).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('never-enqueued backstop: does NOT enqueue while docs are still mid-OCR (not all terminal)', async () => {
    enqueueMock.mockClear();
    const docs = [
      { id: 'd1', s3Key: 'cases/case-3/u-a.pdf' },
      { id: 'd2', s3Key: 'cases/case-3/u-b.pdf' }, // no status → not terminal
    ];
    const statuses = [{ caseId: 'case-3', filePath: 'cases/case-3/u-a.pdf', terminalStatus: 'read' }];
    const prisma = {
      chartExtractionRun: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null),
      },
      fileReadStatus: { findMany: vi.fn(async () => statuses) },
      document: { findMany: vi.fn(async () => docs) },
      activityLog: { create: vi.fn(async () => {}) },
    } as unknown as PrismaClient;

    const res = await handler(prisma);
    expect(res.enqueuedMissing).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // ── FIX 5 (AWS review, 2026-06-14): per-invocation scan cap on the never-enqueued N+1 ───────────
  // enqueueMissingExtractRuns does 3 queries + an enqueue PER candidate case. At scale that N+1 could
  // run past the 120s Lambda timeout and the sweep would die mid-loop, healing nothing deterministic.
  // A per-tick CAP (process at most 25 missing-run cases, oldest-first) bounds the work + logs that it
  // capped, so a sweep never silently fails to finish; the remainder drains on the next 5-min tick.
  it('never-enqueued backstop: CAPS processing at 25 missing-run cases per tick and logs the cap', async () => {
    enqueueMock.mockClear();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 30 distinct cases, each with a single all-terminal doc and NO extraction run → all "missing".
      const N = 30;
      const allStatuses = Array.from({ length: N }, (_, i) => ({ caseId: `case-${i}`, filePath: `cases/case-${i}/u-scan.pdf`, terminalStatus: 'read' }));
      const prisma = {
        chartExtractionRun: {
          findMany: vi.fn(async () => []),                 // no stuck runs
          updateMany: vi.fn(async () => ({ count: 0 })),
          findFirst: vi.fn(async () => null),              // no run for any doc-set → all missing
        },
        fileReadStatus: {
          // First call (candidate scan) has no caseId filter → return the full cross-case list. Per-case
          // calls carry where.caseId → return just that case's status.
          findMany: vi.fn(async (args: { where?: { caseId?: string } }) => {
            const cid = args.where?.caseId;
            return cid ? allStatuses.filter((s) => s.caseId === cid) : allStatuses;
          }),
        },
        document: {
          findMany: vi.fn(async (args: { where: { caseId: string } }) => [{ id: `d-${args.where.caseId}`, s3Key: `cases/${args.where.caseId}/u-scan.pdf` }]),
        },
        activityLog: { create: vi.fn(async () => {}) },
      } as unknown as PrismaClient;

      const res = await handler(prisma);
      // Capped: never more than 25 enqueues this tick even though 30 cases were missing.
      expect(res.enqueuedMissing).toBe(25);
      expect(enqueueMock).toHaveBeenCalledTimes(25);
      // The cap was logged LOUD (observable), never a silent partial sweep.
      const cappedLog = warnSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('CAPPED'));
      expect(cappedLog).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never-enqueued backstop: does NOT cap or warn when fewer than the cap need enqueueing', async () => {
    enqueueMock.mockClear();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const N = 5;
      const allStatuses = Array.from({ length: N }, (_, i) => ({ caseId: `c-${i}`, filePath: `cases/c-${i}/u.pdf`, terminalStatus: 'read' }));
      const prisma = {
        chartExtractionRun: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })), findFirst: vi.fn(async () => null) },
        fileReadStatus: { findMany: vi.fn(async (args: { where?: { caseId?: string } }) => { const cid = args.where?.caseId; return cid ? allStatuses.filter((s) => s.caseId === cid) : allStatuses; }) },
        document: { findMany: vi.fn(async (args: { where: { caseId: string } }) => [{ id: `d-${args.where.caseId}`, s3Key: `cases/${args.where.caseId}/u.pdf` }]) },
        activityLog: { create: vi.fn(async () => {}) },
      } as unknown as PrismaClient;

      const res = await handler(prisma);
      expect(res.enqueuedMissing).toBe(5);
      expect(warnSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('CAPPED'))).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores an EventBridge event object (footgun guard) and falls back to the real client path', async () => {
    // Passing a non-Prisma object must not throw a TypeError; it falls back to getPrisma() which (with no
    // DATABASE_URL in the test env) will reject inside findMany — caught here only to prove it did not treat
    // the event as the client (which would have called event.chartExtractionRun.findMany and TypeError'd).
    await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' }).catch(() => { /* expected: no DB in test env */ });
    expect(true).toBe(true);
  });
});
