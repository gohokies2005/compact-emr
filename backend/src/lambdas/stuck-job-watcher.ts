import { PrismaClient, Prisma } from '@prisma/client';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import {
  DRAFT_JOB_WATCHER_SWEPT_MESSAGE,
  STALE_THRESHOLD_MS,
  MAX_LIFETIME_MS,
} from '../services/draft-job-constants.js';
import { enqueueAutoRerunForCase, DRAFT_AUTO_RERUN_ACTION } from '../services/draft-auto-rerun.js';
import type { AppDb } from '../services/db-types.js';

// ADDITION A (document auto-recovery loop, 2026-06-14): a timed-out/interrupted draft cannot be resumed
// from a partial (the drafter spawns a fresh pipeline from scratch), so we AUTO-RE-RUN a fresh full draft
// ONCE per case instead of leaving the manual "click Send to Drafter again" dead-end. Bounded: at most
// MAX_AUTO_RERUNS auto-re-runs per case in the lookback window — past that, fall to the human last resort
// (the OpsHeldPanel) rather than loop ~$15 cloud spend on a chronically-failing case.
const MAX_AUTO_RERUNS = 1;
const AUTO_RERUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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

// STALE_THRESHOLD_MS (running job, no heartbeat => crashed) and MAX_LIFETIME_MS (absolute in-flight
// lifetime cap) are now imported from draft-job-constants.ts — the SINGLE source shared with the
// draft-concurrency count so the reaper and the slot-counter agree on what "stale" means.
const QUEUE_ABANDON_MS = 120 * 60 * 1000; // 2h — queued job that never got claimed (backstop only)
const BATCH_LIMIT = 100; // per invocation; lifecycle: 100 * (60/5) = 1200/hr max sweep rate

// RECONCILE staleness floor (Fix, 2026-06-30). The reconcile pass takes a case OFF a stranded
// status='drafting' once its NEWEST draft job is terminal. Without a time floor it fires on the first
// sweep after the job goes terminal — safe TODAY only by the cross-repo convention that every failed
// /complete also sets operatorState='paused' (which the pass excludes). That convention is the only
// thing standing between this pass and a draft whose /complete callback is still settling. The floor
// makes the liveness-recompute self-safe: only reconcile a case whose newest job has been terminal for
// LONGER than this — comfortably past STALE_THRESHOLD_MS (10min). Dick-class strands are long-stuck, so
// the delay costs nothing. (This is the recurring hash-drift / recompute-liveness class — never let a
// recompute race a still-settling producer.)
// 30 min (Ryan 2026-07-05): flip a stranded 'drafting' case (newest job terminal, no letter) to
// "needs RN attention" after this delay + post an in-chart note. Raised 15→30 so it comfortably clears any
// still-settling /complete callback AND lets us safely INCLUDE operatorState='paused' strands (below) — a
// genuinely-paused case still 'drafting' after 30 min is the failed-/complete strand (Scott/migraine), which
// needs the RN, while a just-reaped "interrupted" case is <30 min old and is left for the resume affordance.
const RECONCILE_TERMINAL_FLOOR_MS = 30 * 60 * 1000;

let cachedPrisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (cachedPrisma !== null) return cachedPrisma;
  cachedPrisma = new PrismaClient();
  return cachedPrisma;
}

export interface StuckJobWatcherResult {
  scanned: number;
  swept: number;
  // ADDITION A: count of swept 'running' jobs that were auto-RE-RUN (a fresh full draft, bounded once
  // per case) instead of left at the manual dead-end.
  autoReran: number;
  // RECONCILE pass (Bug 1, 2026-06-29): count of cases stranded at status='drafting' with NO in-flight
  // job (newest job terminal) that were taken OFF 'drafting' (→ needs_rn_decision/paused). Heals Dick +
  // any pre-fix cancels whose terminal job the stale-job sweep never sees.
  reconciled: number;
  ranAt: string;
}

export async function handler(injectedPrisma?: PrismaClient): Promise<StuckJobWatcherResult> {
  const now = new Date();
  const staleBoundary = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const queueAbandonBoundary = new Date(now.getTime() - QUEUE_ABANDON_MS);
  const lifetimeBoundary = new Date(now.getTime() - MAX_LIFETIME_MS);
  // Only reconcile a stranded drafting case whose NEWEST job has been terminal since before this.
  const reconcileTerminalBoundary = new Date(now.getTime() - RECONCILE_TERMINAL_FLOOR_MS);
  // The Lambda runtime passes the EVENT as the first arg, so injectedPrisma is the event object (truthy,
  // so `?? getPrisma()` wrongly kept it → `event.draftJob` undefined → crash on every scheduled run, the
  // safety net silently dead since 2026-06-06). Only use it if it's an actual PrismaClient (has draftJob).
  const prisma = injectedPrisma && 'draftJob' in (injectedPrisma as object) ? injectedPrisma : getPrisma();

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
        // ABSOLUTE lifetime cap — ANY in-flight job (queued OR running) older than 60 min is dead. Catches
        // a 'running' job that never heartbeated (NULL lastHeartbeatAt, which the clause above misses).
        { state: { in: ['queued', 'running'] }, enqueuedAt: { lt: lifetimeBoundary } },
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
    // No STALE in-flight job to reap — but still fall through to the RECONCILE pass below: a case can
    // be stranded at status='drafting' with NO in-flight job (its newest job already went terminal),
    // which the stale-job sweep never sees. (Bug 1 / Dick: a cancelled job ended terminal but the case
    // was never taken off 'drafting'.)
    console.log(JSON.stringify({ msg: 'stuck-job-watcher: no stale jobs', scanned: 0, swept: 0, ranAt: now.toISOString() }));
  }

  let swept = 0;
  let autoReran = 0;
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

      // ADDITION A — bounded AUTO-RE-RUN. A 'running' job that went stale is a genuine mid-run timeout
      // (it had a worker + heartbeats), which is exactly the "resume on timeout" case. The drafter cannot
      // resume a partial, so we enqueue a FRESH full draft ONCE. A 'queued' job that was abandoned (never
      // claimed) is NOT auto-re-run here — re-enqueuing an unclaimed job risks a capacity-thrash loop; the
      // RN re-sends it. Count prior auto-re-runs in the lookback window to enforce the cap; past it, leave
      // the human last resort (OpsHeldPanel) so a chronically-failing case never loops cloud spend.
      if (job.state === 'running') {
        try {
          const priorReruns = await prisma.activityLog.count({
            where: { caseId: job.caseId, action: DRAFT_AUTO_RERUN_ACTION, createdAt: { gt: new Date(now.getTime() - AUTO_RERUN_LOOKBACK_MS) } },
          });
          if (priorReruns < MAX_AUTO_RERUNS) {
            const rerun = await enqueueAutoRerunForCase(prisma as unknown as AppDb, job.caseId, job.version);
            if (rerun.enqueued) {
              autoReran += 1;
              console.log(JSON.stringify({ msg: 'stuck-job-watcher: auto-re-ran', caseId: job.caseId, supersedesVersion: job.version, newJobId: rerun.jobId, newVersion: rerun.version }));
            } else {
              console.log(JSON.stringify({ msg: 'stuck-job-watcher: auto-re-run skipped', caseId: job.caseId, reason: rerun.reason }));
            }
          } else {
            console.log(JSON.stringify({ msg: 'stuck-job-watcher: auto-re-run cap reached; leaving for manual re-send', caseId: job.caseId, priorReruns }));
          }
        } catch (rerunErr) {
          // Auto-re-run failure must never undo a completed sweep — log + continue (the case is still
          // safely 'failed'/paused with the manual re-send affordance).
          console.error(JSON.stringify({ msg: 'stuck-job-watcher: auto-re-run failed', caseId: job.caseId, error: rerunErr instanceof Error ? rerunErr.message : String(rerunErr) }));
        }
      }
    } catch (err) {
      // Don't fail the whole invocation on one row — log and continue.
      console.error(JSON.stringify({
        msg: 'stuck-job-watcher: sweep failed',
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // RECONCILE pass (Bug 1, 2026-06-29). A case can be stranded at status='drafting' with NO in-flight
  // job — the cancel route (pre-fix) flipped its job terminal but never took the case off 'drafting',
  // so the Cases list read "Drafting" forever (Dick). The stale-job sweep above never sees these (the
  // job is already terminal, not stale), so we reconcile them here directly off Case.status.
  //
  // Predicate: status='drafting' AND it HAS a draft job AND none of them is queued|running (newest job
  // terminal). This now INCLUDES operatorState='paused' strands (Ryan 2026-07-05): a failed /complete
  // (drafter.ts:1516) leaves a dead case at status='drafting' + operatorState='paused', which the old
  // `{ not: 'paused' }` exclusion skipped forever → the RN saw a phantom "Drafting" spinner they couldn't
  // act on (Scott CLM-5D723B7926 19h, migraine CLM-759FB593C7 3.5 days). Safe to include because the 30-min
  // staleness floor below leaves a JUST-reaped "interrupted" case (<30 min) untouched for its resume
  // affordance; only a genuinely-stranded case (terminal >30 min) is healed. status='drafting' already
  // scopes us to strands — a properly-parked case is needs_rn_decision and never matches.
  //
  // Transition → needs_rn_decision/paused (mirrors the cancel + halt routes) + a chart-visible quick note so
  // the RN is notified in the chart, not just the list. Idempotent: once moved off 'drafting' the row no
  // longer matches, so a re-run never re-touches it (no loop, no duplicate note).
  const reconcileMessage =
    'This draft didn’t finish and needs your attention. Click Send to Drafter to start a new draft when ready.';
  const stuckChartNoteBody =
    '⚠️ Needs RN attention: a drafting run for this case stopped without producing a letter. Open the case to review the hold reason, then click Send to Drafter to start a fresh draft when ready.';
  let reconciled = 0;
  try {
    const strandedDrafting = await prisma.case.findMany({
      where: {
        status: 'drafting',
        draftJobs: { some: {}, none: { state: { in: ['queued', 'running'] } } },
      },
      select: {
        id: true,
        veteranId: true,
        version: true,
        // The NEWEST job (enqueuedAt DESC, take:1). `none queued/running` above guarantees every job is
        // terminal, so this is the most-recent terminal job; its completedAt (fallback updatedAt) is when
        // the case actually went idle — what the staleness floor measures against.
        draftJobs: {
          orderBy: { enqueuedAt: 'desc' },
          take: 1,
          select: { state: true, completedAt: true, updatedAt: true },
        },
      },
      take: BATCH_LIMIT,
    });
    // STALENESS FLOOR (Fix, 2026-06-30): only reconcile a case whose newest job has been terminal for
    // longer than RECONCILE_TERMINAL_FLOOR_MS (15min). A case whose newest job JUST went terminal is left
    // for the next sweep so this pass can never reconcile a draft whose /complete callback is still
    // settling — relying on the cross-repo paused-on-failure convention alone is the corner this closes.
    const reconcileTargets = strandedDrafting.filter((c) => {
      const newest = c.draftJobs[0];
      if (newest === undefined) return false; // some:{} guarantees a job exists, but stay defensive
      const terminalAt = newest.completedAt ?? newest.updatedAt;
      return terminalAt.getTime() <= reconcileTerminalBoundary.getTime();
    });
    for (const c of reconcileTargets) {
      try {
        const ops: Prisma.PrismaPromise<unknown>[] = [
          prisma.case.update({
            where: { id: c.id },
            data: {
              status: 'needs_rn_decision',
              operatorState: 'paused',
              operatorMessage: reconcileMessage,
              runComplete: false,
              version: { increment: 1 },
            },
          }),
          prisma.activityLog.create({
            data: {
              actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
              caseId: c.id,
              action: 'case_drafting_reconciled',
              detailsJson: { reason: 'no_in_flight_job', priorStatus: 'drafting' },
            },
          }),
        ];
        // In-chart notification (Ryan 2026-07-05): a quick note so the RN is told IN THE CHART (top-of-chart
        // + cases-list at-a-glance), not only via the list status. Atomic with the flip; keyed by veteranId.
        // Idempotent by construction — the case leaves 'drafting' in the same txn, so it never re-fires.
        if (c.veteranId) {
          ops.push(prisma.chartNote.create({
            data: {
              veteranId: c.veteranId,
              body: stuckChartNoteBody,
              createdBy: SERVICE_ACTORS.STUCK_JOB_WATCHER,
              isQuickNote: true,
            },
          }));
        }
        await prisma.$transaction(ops);
        reconciled += 1;
        console.log(JSON.stringify({ msg: 'stuck-job-watcher: reconciled stranded drafting case', caseId: c.id }));
      } catch (err) {
        console.error(JSON.stringify({
          msg: 'stuck-job-watcher: reconcile failed',
          caseId: c.id,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  } catch (err) {
    // A reconcile-query failure must never fail the whole invocation (the sweep above already succeeded).
    console.error(JSON.stringify({
      msg: 'stuck-job-watcher: reconcile query failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  const summary = { scanned: stuckJobs.length, swept, autoReran, reconciled, ranAt: now.toISOString() };
  console.log(JSON.stringify({ msg: 'stuck-job-watcher: summary', ...summary }));
  return summary;
}
