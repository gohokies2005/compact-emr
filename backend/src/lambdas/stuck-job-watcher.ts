import { PrismaClient } from '@prisma/client';
import { SERVICE_ACTORS } from '../services/service-actors.js';

/**
 * Architect QA F6: stuck-Fargate-task watcher.
 *
 * Catches DraftJob rows that are stuck in 'queued' or 'running' state because the Fargate
 * task that owned them crashed mid-run. Without this watcher, a crash leaves the job
 * invisible for 45 minutes (SQS visibility timeout) — operators get no signal, the
 * physician inbox stays empty, the veteran gets no letter.
 *
 * Sweep rule: state IN ('queued','running') AND
 *   (last_heartbeat_at IS NULL AND enqueued_at < NOW() - 10min)
 *   OR (last_heartbeat_at < NOW() - 10min)
 *
 * Why 10 min: the drafter spine heartbeats once per phase transition. Phases take 1-3 min
 * each; 10 min of silence means the wrapper is dead, not slow. False positives would be
 * worse than late detection — but the SQS visibility timeout of 45 min means a redelivered
 * stuck message would just re-enqueue and the new run would proceed normally.
 *
 * Action: flip the DraftJob to state='failed', failureClass='system'. Case.status is NOT
 * mutated — it stays at 'drafting' (the ops queue state), so the operator can retry via a
 * fresh POST /draft.
 *
 * Activity log written for every sweep — audit + operator visibility in CloudWatch.
 *
 * Scheduled by EventBridge every 5 minutes from the WorkersStack rule.
 */

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min
const BATCH_LIMIT = 100; // per invocation; lifecycle: 100 * (60/5) = 1200/hr max sweep rate

let cachedPrisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (cachedPrisma !== null) return cachedPrisma;
  cachedPrisma = new PrismaClient();
  return cachedPrisma;
}

export interface StuckJobWatcherResult {
  scanned: number;
  swept: number;
  ranAt: string;
}

export async function handler(): Promise<StuckJobWatcherResult> {
  const now = new Date();
  const staleBoundary = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const prisma = getPrisma();

  // Two stale conditions in one query — Prisma OR clause.
  const stuckJobs = await prisma.draftJob.findMany({
    where: {
      state: { in: ['queued', 'running'] },
      OR: [
        // Never heartbeated, and was enqueued > 10 min ago. Covers a wrapper that died
        // before its first /progress call.
        { lastHeartbeatAt: null, enqueuedAt: { lt: staleBoundary } },
        // Heartbeated once, then silence > 10 min. Covers a mid-run crash.
        { lastHeartbeatAt: { lt: staleBoundary } },
      ],
    },
    select: {
      id: true,
      caseId: true,
      version: true,
      state: true,
      lastHeartbeatAt: true,
      enqueuedAt: true,
      currentPhase: true,
    },
    take: BATCH_LIMIT,
  });

  if (stuckJobs.length === 0) {
    console.log(JSON.stringify({ msg: 'stuck-job-watcher: no stale jobs', scanned: 0, swept: 0, ranAt: now.toISOString() }));
    return { scanned: 0, swept: 0, ranAt: now.toISOString() };
  }

  let swept = 0;
  for (const job of stuckJobs) {
    try {
      await prisma.$transaction([
        prisma.draftJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            failureClass: 'system',
            errorMessage: 'Heartbeat stale; Fargate task assumed crashed. Watcher swept.',
            completedAt: now,
            lastHeartbeatAt: now,
          },
        }),
        prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId: job.caseId,
            action: 'draft_job_swept_stale',
            detailsJson: {
              jobId: job.id,
              version: job.version,
              priorState: job.state,
              priorPhase: job.currentPhase,
              lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() ?? null,
              enqueuedAt: job.enqueuedAt.toISOString(),
              staleThresholdMin: 10,
            },
          },
        }),
      ]);
      swept += 1;
      console.log(JSON.stringify({ msg: 'stuck-job-watcher: swept', jobId: job.id, caseId: job.caseId, priorState: job.state }));
    } catch (err) {
      // Don't fail the whole invocation on one row — log and continue.
      console.error(JSON.stringify({
        msg: 'stuck-job-watcher: sweep failed',
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const summary = { scanned: stuckJobs.length, swept, ranAt: now.toISOString() };
  console.log(JSON.stringify({ msg: 'stuck-job-watcher: summary', ...summary }));
  return summary;
}
