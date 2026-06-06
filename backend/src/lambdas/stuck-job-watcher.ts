import { PrismaClient } from '@prisma/client';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { DRAFT_JOB_WATCHER_SWEPT_MESSAGE } from '../services/draft-job-constants.js';

/**
 * Architect QA F6: stuck-Fargate-task watcher.
 *
 * Catches DraftJob rows that are stuck in 'queued' or 'running' state because the Fargate
 * task that owned them crashed mid-run. Without this watcher, a crash leaves the job
 * invisible for 45 minutes (SQS visibility timeout) — operators get no signal, the
 * physician inbox stays empty, the veteran gets no letter.
 *
 * Sweep rule (FIXED 2026-06-06, "reaped queued letters" incident):
 *   - state='running'  AND last_heartbeat_at < NOW() - 10min   (a real mid-run task crash)
 *   - state='queued'   AND enqueued_at        < NOW() - 120min (genuinely ABANDONED, backstop only)
 *
 * Why this changed: the old rule reaped ANY 'queued' job whose enqueued_at was >10min old
 * (last_heartbeat_at is NULL until a worker claims it). With maxCapacity scaling, a job that simply
 * WAITS in the FIFO behind a long-running draft (Pryor ran 15.5min) crossed 10min and was killed
 * mid-wait — its letter discarded — even though nothing was wrong. A queued job has no worker yet,
 * so it can't be "stuck mid-run". It either gets picked up when capacity frees, or — if its SQS
 * message truly vanished — the 120min backstop eventually fails it (well past the 45min SQS
 * visibility-timeout redelivery, so normal waits are never touched). Only a job a worker actually
 * CLAIMED (state='running', so it has a heartbeat) can go stale and need reaping.
 *
 * Why 10 min (running): the drafter spine heartbeats every 60s; /progress writes last_heartbeat_at.
 * 10 min of silence on a running job means the wrapper is dead, not slow.
 *
 * Action: flip the DraftJob to state='failed', failureClass='system'. Case.status is NOT
 * mutated — it stays at 'drafting' (the ops queue state), so the operator can retry via a
 * fresh POST /draft.
 *
 * Activity log written for every sweep — audit + operator visibility in CloudWatch.
 *
 * Scheduled by EventBridge every 5 minutes from the WorkersStack rule.
 */

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min — running job, no heartbeat => crashed
const QUEUE_ABANDON_MS = 120 * 60 * 1000; // 2h — queued job that never got claimed (backstop only)
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

export async function handler(injectedPrisma?: PrismaClient): Promise<StuckJobWatcherResult> {
  const now = new Date();
  const staleBoundary = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const queueAbandonBoundary = new Date(now.getTime() - QUEUE_ABANDON_MS);
  const prisma = injectedPrisma ?? getPrisma();

  const stuckJobs = await prisma.draftJob.findMany({
    where: {
      OR: [
        // A RUNNING job whose worker stopped heartbeating > 10 min — a real mid-run crash. A running
        // job always has lastHeartbeatAt set (/progress writes state=running + lastHeartbeatAt
        // atomically), so this one clause covers every claimed-then-died case.
        { state: 'running', lastHeartbeatAt: { lt: staleBoundary } },
        // A QUEUED job that has waited > 2h without ever being claimed — backstop for a truly
        // orphaned job (SQS message gone), NOT a normal queue wait behind other drafts. NEVER reap a
        // queued job on the 10-min clock — that discarded healthy queued letters (2026-06-06).
        { state: 'queued', enqueuedAt: { lt: queueAbandonBoundary } },
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
  // G8: RN-friendly message we set on Case.operatorMessage so the EMR UI can render a clear
  // next-action prompt instead of leaving the RN to interpret "system error". No infra
  // jargon (no "Lambda", "Fargate", "heartbeat" etc.) — just what happened plus what to do.
  const sweptCaseMessage =
    'We had a problem and couldn’t finish drafting this letter. Please click Send to Drafter again. If it keeps failing, flag this case to Dr. Ryan.';

  for (const job of stuckJobs) {
    try {
      await prisma.$transaction([
        prisma.draftJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            failureClass: 'system',
            errorMessage: DRAFT_JOB_WATCHER_SWEPT_MESSAGE,
            completedAt: now,
            lastHeartbeatAt: now,
          },
        }),
        // G8: populate Case.operatorMessage so the RN/physician UI shows the friendly
        // explanation. Also flip Case.operatorState to 'paused' (matches the spine's
        // summarizeForOperator() vocabulary for "we had to stop") so the UI's existing
        // state-driven rendering catches this without special-casing.
        // Architect QA: bump version so TanStack-Query-driven UI (G2 8s polling) and any
        // optimistic-lock consumer detects the watcher's mutation. All other Case writers
        // do this; the watcher must too.
        prisma.case.update({
          where: { id: job.caseId },
          data: {
            operatorState: 'paused',
            operatorMessage: sweptCaseMessage,
            runComplete: false,
            version: { increment: 1 },
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
