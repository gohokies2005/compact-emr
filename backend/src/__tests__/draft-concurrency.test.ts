import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countRunningSlots,
  countQueuedAhead,
  getDraftConcurrency,
  drafterMaxConcurrency,
} from '../services/draft-concurrency.js';
import { STALE_THRESHOLD_MS, MAX_LIFETIME_MS } from '../services/draft-job-constants.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');

// A minimal draftJob delegate whose count() records the `where` it was called with so we can assert
// the zombie-exclusion clauses precisely. Returns whatever the test queues up.
function makeCounter(returns: number[] = []) {
  const wheres: Array<Record<string, unknown>> = [];
  const queue = [...returns];
  const count = vi.fn(async (args: { where: Record<string, unknown> }) => {
    wheres.push(args.where);
    return queue.length > 0 ? queue.shift()! : 0;
  });
  return { db: { count } as unknown as { count(args: unknown): Promise<number> }, wheres, count };
}

describe('draft-concurrency: drafterMaxConcurrency', () => {
  const prev = process.env.DRAFTER_MAX_CONCURRENCY;
  afterEach(() => { if (prev === undefined) delete process.env.DRAFTER_MAX_CONCURRENCY; else process.env.DRAFTER_MAX_CONCURRENCY = prev; });

  it('reads DRAFTER_MAX_CONCURRENCY from env', () => {
    process.env.DRAFTER_MAX_CONCURRENCY = '8';
    expect(drafterMaxConcurrency()).toBe(8);
  });

  it('falls back to 6 when env is unset or non-numeric', () => {
    delete process.env.DRAFTER_MAX_CONCURRENCY;
    expect(drafterMaxConcurrency()).toBe(6);
    process.env.DRAFTER_MAX_CONCURRENCY = 'nonsense';
    expect(drafterMaxConcurrency()).toBe(6);
  });
});

describe('draft-concurrency: countRunningSlots (zombie exclusion)', () => {
  it('counts ONLY running jobs that heartbeated recently AND are within the lifetime cap', async () => {
    const { db, wheres } = makeCounter([3]);
    const running = await countRunningSlots(db, NOW);
    expect(running).toBe(3);

    const w = wheres[0];
    // state must be exactly 'running' — a queued/halted/done/failed job is never a live slot.
    expect(w.state).toBe('running');

    // EXCLUDES a stale-or-NULL heartbeat: lastHeartbeatAt must be NON-null AND within STALE_THRESHOLD_MS.
    const hb = w.lastHeartbeatAt as { not: null; gte: Date };
    expect(hb.not).toBeNull(); // not: null  ⇒  IS NOT NULL  ⇒  a NULL-heartbeat zombie is excluded
    expect(NOW.getTime() - (hb.gte as Date).getTime()).toBe(STALE_THRESHOLD_MS);

    // EXCLUDES a job past the absolute lifetime cap (a 'running' job that never heartbeated and slipped
    // the stale clause — its enqueuedAt is older than MAX_LIFETIME_MS).
    const en = w.enqueuedAt as { gte: Date };
    expect(NOW.getTime() - (en.gte as Date).getTime()).toBe(MAX_LIFETIME_MS);
  });
});

describe('draft-concurrency: countQueuedAhead (FIFO ordering)', () => {
  it('counts queued jobs strictly OLDER than this job, bounded by the lifetime cap', async () => {
    const enqueuedAt = new Date('2026-06-08T11:55:00.000Z');
    const { db, wheres } = makeCounter([2]);
    const ahead = await countQueuedAhead(db, enqueuedAt, NOW);
    expect(ahead).toBe(2);

    const w = wheres[0];
    expect(w.state).toBe('queued');
    const en = w.enqueuedAt as { gte: Date; lt: Date };
    // lt = THIS job's enqueuedAt → only strictly-earlier queued jobs are "ahead" ( orders by enqueuedAt).
    expect(en.lt.getTime()).toBe(enqueuedAt.getTime());
    // gte = lifetime boundary → an abandoned queued straggler (which the watcher will reap) is excluded.
    expect(NOW.getTime() - en.gte.getTime()).toBe(MAX_LIFETIME_MS);
  });
});

describe('draft-concurrency: getDraftConcurrency snapshot', () => {
  beforeEach(() => { process.env.DRAFTER_MAX_CONCURRENCY = '6'; });
  afterEach(() => { delete process.env.DRAFTER_MAX_CONCURRENCY; });

  it('returns {running, max from env, queuedAhead, queuePosition = queuedAhead + 1}', async () => {
    // First count() → runningSlots (6), second → queuedAhead (2).
    const { db } = makeCounter([6, 2]);
    const snap = await getDraftConcurrency(db, new Date('2026-06-08T11:55:00.000Z'), NOW);
    expect(snap).toEqual({ running: 6, max: 6, queuedAhead: 2, queuePosition: 3 });
  });

  it('queuePosition is 1 when nothing is ahead', async () => {
    const { db } = makeCounter([6, 0]);
    const snap = await getDraftConcurrency(db, new Date('2026-06-08T11:55:00.000Z'), NOW);
    expect(snap.queuePosition).toBe(1);
    expect(snap.queuedAhead).toBe(0);
  });

  it('max comes from DRAFTER_MAX_CONCURRENCY (not hardcoded)', async () => {
    process.env.DRAFTER_MAX_CONCURRENCY = '4';
    const { db } = makeCounter([4, 1]);
    const snap = await getDraftConcurrency(db, new Date('2026-06-08T11:55:00.000Z'), NOW);
    expect(snap.max).toBe(4);
  });
});
