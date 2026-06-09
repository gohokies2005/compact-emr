import type { AppDb, AppDbTransaction } from './db-types.js';
import { STALE_THRESHOLD_MS, MAX_LIFETIME_MS } from './draft-job-constants.js';

/**
 * Draft concurrency / queue-position computed from the DraftJob table ONLY (no ECS / SQS calls).
 *
 * Powers the "Your letter is in line to start" panel: when the drafter is at capacity, a clicked
 * draft QUEUES (cross-case — a case can't queue behind itself; POST /draft 409s same-case). The UI
 * needs an HONEST signal — how many drafters are genuinely busy, and where THIS job sits in line.
 *
 * Why count from the DB and not SQS/ECS: the DraftJob table is the system of record the EMR already
 * polls, it's transactional with the enqueue, and it lets us EXCLUDE zombies precisely. SQS depth /
 * ECS running-task-count would over-count crashed-but-not-yet-reaped work.
 *
 * runningSlots — the LOAD-BEARING part. A naive `count(state='running')` over-reports because a
 * crashed Fargate task leaves its DraftJob reading 'running' until the stuck-job-watcher reaps it
 * (up to 5 min later). If we counted those zombies as live slots, a brand-new queued draft would
 * read "drafter is full" — and stay frozen at "#N in line" — forever, even though a slot is actually
 * free. So runningSlots mirrors the watcher's "this job is alive" definition EXACTLY (same shared
 * constants): a running job counts as a live slot ONLY if it has heartbeated recently AND is within
 * the absolute lifetime cap. The watcher will reap anything that fails those — so the counter and
 * the reaper never disagree.
 */

export interface DraftConcurrency {
  /** Live drafter slots in use right now (zombies excluded). */
  readonly running: number;
  /** The hard ceiling — the Fargate autoscaler maxCapacity, injected as DRAFTER_MAX_CONCURRENCY. */
  readonly max: number;
  /** How many OTHER queued jobs are ahead of this one in the FIFO (older enqueuedAt). */
  readonly queuedAhead: number;
  /** This job's place in line, 1-based (queuedAhead + 1). */
  readonly queuePosition: number;
}

/** The drafter concurrency ceiling. Mirrors the Fargate autoscaler maxCapacity (see infra). */
export function drafterMaxConcurrency(): number {
  return Number(process.env.DRAFTER_MAX_CONCURRENCY) || 6;
}

type DraftJobCounter = Pick<AppDb['draftJob'] | AppDbTransaction['draftJob'], 'count'>;

/**
 * Count live drafter slots — running jobs that the stuck-job-watcher would NOT reap. The three
 * clauses are the zombie exclusion (must match the watcher's reap predicate inverse):
 *   - state = 'running'
 *   - lastHeartbeatAt IS NOT NULL  AND  >= now - STALE_THRESHOLD_MS   (heartbeating, not crashed)
 *   - enqueuedAt >= now - MAX_LIFETIME_MS                            (under the absolute lifetime cap)
 */
export async function countRunningSlots(db: DraftJobCounter, now: Date = new Date()): Promise<number> {
  const staleBoundary = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const lifetimeBoundary = new Date(now.getTime() - MAX_LIFETIME_MS);
  return db.count({
    where: {
      state: 'running',
      lastHeartbeatAt: { not: null, gte: staleBoundary },
      enqueuedAt: { gte: lifetimeBoundary },
    },
  });
}

/**
 * Count queued jobs strictly AHEAD of `enqueuedAt` in the FIFO — i.e. older queued jobs that will
 * be picked up before this one. Bounded by the lifetime cap so a long-abandoned queued straggler
 * (which the watcher will reap) doesn't inflate a fresh job's position.
 */
export async function countQueuedAhead(
  db: DraftJobCounter,
  enqueuedAt: Date,
  now: Date = new Date(),
): Promise<number> {
  const lifetimeBoundary = new Date(now.getTime() - MAX_LIFETIME_MS);
  return db.count({
    where: {
      state: 'queued',
      enqueuedAt: { gte: lifetimeBoundary, lt: enqueuedAt },
    },
  });
}

/**
 * Full concurrency snapshot for a specific (queued or just-enqueued) DraftJob. `enqueuedAt` is that
 * job's own enqueue time — the FIFO anchor for queuedAhead.
 */
export async function getDraftConcurrency(
  db: DraftJobCounter,
  enqueuedAt: Date,
  now: Date = new Date(),
): Promise<DraftConcurrency> {
  const [running, queuedAhead] = await Promise.all([
    countRunningSlots(db, now),
    countQueuedAhead(db, enqueuedAt, now),
  ]);
  return {
    running,
    max: drafterMaxConcurrency(),
    queuedAhead,
    queuePosition: queuedAhead + 1,
  };
}
