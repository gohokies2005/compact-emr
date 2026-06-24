import { PrismaClient } from '@prisma/client';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { maybeEnqueueChartExtract } from '../services/chart-extract-trigger.js';
import {
  computeTriggerHash,
  isScreeningSummaryKey,
  TERMINAL_READ_STATUSES,
} from '../services/chart-build-state.js';
import type { AppDb } from '../services/db-types.js';

/**
 * Stuck-CHART-EXTRACTION-RUN watcher (audit 2026-06-13: "no errors, no babysitting, no silent failures").
 *
 * The OCR analogue (stuck-doc-watcher) heals documents that never reach a terminal read-status; the
 * DraftJob analogue (stuck-job-watcher) reaps crashed Fargate draft tasks. This is the missing EXTRACTION
 * analogue: a ChartExtractionRun is created status='queued' and is only ever moved to a terminal status
 * (complete | complete_with_gaps | failed) by the worker AT THE END of its run (postMerge / postFailed).
 * If the worker Lambda is killed abnormally — OOM, a cold-start/init failure before the try-block, an SQS
 * redelivery exhausting maxReceiveCount into the DLQ — NOTHING moves the row off 'queued'. deriveChartBuildState
 * then pins the case in 'extracting' FOREVER, invisibly: no error, no door, no alarm (exactly the Woodley/Lozano
 * OCR failure mode, one layer down the pipeline).
 *
 * The self-budget terminal callback (PR #14) makes a HEALTHY run post a terminal status by ~12.5 min, and one
 * SQS redelivery cycle (23-min visibility) lands a retry terminal by ~35 min. So a run still non-terminal after
 * STUCK_RUN_MS (45 min) has had multiple Lambda attempts all fail to post — it is genuinely dead, not slow.
 *
 * Action: flip status → 'failed' with an actionable errorMessage + completedAt. That is the SAME terminal the
 * worker's own final-attempt postFailed writes, so deriveChartBuildState surfaces 'extract_failed' (a retryable
 * door state the RN sees) instead of a silent permanent 'extracting'. We do NOT auto re-fire extraction (that
 * could double-spend ~$6 against a run that is actually mid-flight) — the run is left RN-visible + retryable via
 * the reprocess path. The idempotency guard (PR #13) protects a late redelivery from re-spending. We do NOT
 * mutate the Case row: the chart-build/door state is DERIVED live in chart-readiness on each poll, so the next
 * poll renders extract_failed with no Case write needed.
 *
 * Scheduled every 5 min from WorkersStack. No injected arg shape that the EventBridge event could be mistaken
 * for (the footgun that silently dead-ed the draft watcher for days).
 */

// 45 min: past a healthy self-budgeted run (~12.5 min) + a full SQS redelivery cycle (~35 min). A run still
// non-terminal here has had every Lambda attempt fail to post a terminal status — genuinely abandoned.
const STUCK_RUN_MS = 45 * 60 * 1000;
const BATCH_LIMIT = 100; // per 5-min invocation; lifecycle: 100 * 12 = 1200/hr max sweep rate
const SWEEP_ERROR_MESSAGE =
  'Chart extraction did not finish (the worker stopped before posting a result). The run was marked failed by the safety watcher so the case is retryable instead of stuck.';

let cachedPrisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (cachedPrisma === null) cachedPrisma = new PrismaClient();
  return cachedPrisma;
}

export interface StuckChartExtractRunWatcherResult {
  scanned: number;
  swept: number;
  errors: number;
  // NEVER-ENQUEUED backstop (document auto-recovery loop, 2026-06-14): cases whose docs are all
  // OCR-terminal but have NO ChartExtractionRun for the current doc-set — the run was never enqueued
  // (the /pages post-commit enqueue is log-only/best-effort + the SQS publish can drop). Without this
  // they pin in 'extracting' forever with no run row for the stuck-run sweep above to even find. This
  // pass enqueues the missing run (idempotent via maybeEnqueueChartExtract's INSERT-as-mutex).
  enqueuedMissing: number;
  ranAt: string;
}

// How far back to look for cases that may be missing their extraction run. A case becomes a candidate
// when a file_read_status row was written recently (OCR just finished) — we then check whether a run
// for the current doc-set exists. 24h is generous headroom over the ~3-min healthy extract window while
// keeping the scan bounded; an older never-enqueued case is the genuine orphan this is meant to catch.
const NEVER_ENQUEUED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const NEVER_ENQUEUED_CASE_LIMIT = 200;
// FIX 5 (AWS review, 2026-06-14): per-INVOCATION cap on how many MISSING-run cases this pass will
// actually process (each is an N+1 of 3 queries + an enqueue). Without a cap, a backlog of run-less
// cases could exceed the 120s Lambda timeout and the sweep would die mid-loop having healed nothing
// deterministic. We stop after enqueueing CAP cases (oldest-first), log that we capped, and let the
// next 5-min tick drain the remainder — a sweep never silently fails to finish. 25 * (12 ticks/hr) =
// 300 cases/hr of genuine backlog drain, far above the realistic never-enqueued rate.
const NEVER_ENQUEUED_PROCESS_CAP = 25;

export async function handler(injected?: unknown): Promise<StuckChartExtractRunWatcherResult> {
  const now = new Date();
  const boundary = new Date(now.getTime() - STUCK_RUN_MS);
  // Footgun guard: EventBridge invokes handler(event). Trust an injected arg ONLY if it carries a Prisma
  // shape (has chartExtractionRun); otherwise (incl. the EventBridge event) fall back to the real client.
  const prisma =
    injected && typeof injected === 'object' && 'chartExtractionRun' in (injected as object)
      ? (injected as PrismaClient)
      : getPrisma();

  // Non-terminal runs older than the boundary. 'queued' is the normal in-flight value (the worker only moves
  // off it at the end); 'running' is included defensively in case a future path sets it mid-run.
  const stuck = await prisma.chartExtractionRun.findMany({
    where: { status: { in: ['queued', 'running'] }, createdAt: { lt: boundary } },
    select: { id: true, caseId: true, veteranId: true, status: true, createdAt: true },
    take: BATCH_LIMIT,
  });

  let swept = 0;
  let errors = 0;
  for (const run of stuck) {
    try {
      // Guard against a race: only flip if it is STILL non-terminal (a late worker callback may have just
      // landed). updateMany with the status filter makes this atomic — count 0 means it already completed.
      const res = await prisma.chartExtractionRun.updateMany({
        where: { id: run.id, status: { in: ['queued', 'running'] } },
        data: { status: 'failed', errorMessage: SWEEP_ERROR_MESSAGE, completedAt: now },
      });
      if (res.count === 0) {
        console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: race — run became terminal, skipped', runId: run.id, caseId: run.caseId }));
        continue;
      }
      await prisma.activityLog.create({
        data: {
          actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
          caseId: run.caseId,
          action: 'chart_extract_run_swept_stale',
          detailsJson: {
            runId: run.id,
            priorStatus: run.status,
            createdAt: run.createdAt.toISOString(),
            stuckThresholdMin: STUCK_RUN_MS / 60000,
          },
        },
      });
      swept += 1;
      console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: swept', runId: run.id, caseId: run.caseId, priorStatus: run.status }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({
        msg: 'stuck-chart-extract-run-watcher: sweep failed',
        runId: run.id,
        caseId: run.caseId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // NEVER-ENQUEUED backstop. Always runs (even when there were no stuck runs) so a case whose extraction
  // run was never created at all is still healed. Defensive: only runs when the client exposes the
  // delegates it needs (the stuck-run unit tests pass a minimal mock without fileReadStatus — skip there).
  let enqueuedMissing = 0;
  const hasNeverEnqueuedDeps =
    typeof (prisma as unknown as { fileReadStatus?: unknown }).fileReadStatus === 'object' &&
    typeof (prisma as unknown as { document?: unknown }).document === 'object';
  if (hasNeverEnqueuedDeps) {
    try {
      enqueuedMissing = await enqueueMissingExtractRuns(prisma, now);
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({
        msg: 'stuck-chart-extract-run-watcher: never-enqueued pass failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const summary = { scanned: stuck.length, swept, errors, enqueuedMissing, ranAt: now.toISOString() };
  console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: summary', ...summary }));
  return summary;
}

/**
 * NEVER-ENQUEUED backstop pass. Finds cases that became OCR-terminal recently but have NO
 * ChartExtractionRun for the current doc-set, and enqueues the missing run via the SAME idempotent
 * primitive the /pages trigger uses (maybeEnqueueChartExtract — INSERT-as-mutex on (caseId,triggerHash)
 * + all-terminal gate + publish). Safe to call broadly: a case mid-OCR returns 'ocr_in_progress' (no-op);
 * a case whose run already exists for the current hash P2002-no-ops; only a genuinely run-less terminal
 * doc-set actually enqueues. Returns the count enqueued.
 */
async function enqueueMissingExtractRuns(prisma: PrismaClient, now: Date): Promise<number> {
  const lookbackBoundary = new Date(now.getTime() - NEVER_ENQUEUED_LOOKBACK_MS);

  // Candidate cases: those with a file_read_status touched within the lookback window (OCR recently
  // settled). Distinct caseIds, bounded. A case with no read-status rows has no OCR-terminal docs to
  // extract; one touched long ago is either healthy (has a run) or a stale orphan outside our scope.
  // Oldest-first (lastCheckedAt asc): a case whose OCR settled longest ago is the most likely genuine
  // never-enqueued orphan AND the one a veteran has waited longest on — drain those first under the cap.
  const recentStatuses = await prisma.fileReadStatus.findMany({
    where: { lastCheckedAt: { gt: lookbackBoundary } },
    select: { caseId: true },
    orderBy: { lastCheckedAt: 'asc' },
    take: NEVER_ENQUEUED_CASE_LIMIT * 20, // headroom: many rows per case collapse to few caseIds
  });
  // ALSO catch cases whose doc-set CHANGED via a delete. Deleting a file changes the chart fingerprint,
  // so the last successful run no longer matches and the case shows "extracting" with no run behind it —
  // but an OLD case's fileReadStatus rows sit outside the lookback window, so the read-status source above
  // misses it entirely (Enoch CLM-76E3584247, 2026-06-24: OCR'd 5 days ago, a file deleted today, pinned
  // in a phantom "extracting" with no recovery). A 'document_deleted' activity within the window pulls the
  // case back into scope; the per-case gate below is the SAME idempotent all-terminal/no-current-run check,
  // so a delete that needs no re-extract (mid-OCR, or a run already matches) is just a cheap skip.
  const recentDeletes = await prisma.activityLog.findMany({
    where: { action: 'document_deleted', ts: { gt: lookbackBoundary }, caseId: { not: null } },
    select: { caseId: true },
    orderBy: { ts: 'asc' },
    take: NEVER_ENQUEUED_CASE_LIMIT * 5,
  });
  // Preserve oldest-first order while de-duplicating caseIds (Set preserves insertion order).
  const caseIds = [...new Set([
    ...recentStatuses.map((r) => r.caseId),
    ...recentDeletes.map((r) => r.caseId).filter((c): c is string => typeof c === 'string'),
  ])].slice(0, NEVER_ENQUEUED_CASE_LIMIT);
  if (caseIds.length === 0) return 0;

  let enqueued = 0;
  let capped = false;
  for (const caseId of caseIds) {
    // FIX 5: stop after enqueueing CAP genuine missing-run cases this tick so the N+1 scan can never
    // run past the Lambda timeout. The remainder drains on the next 5-min tick (the candidate set is
    // oldest-first + stable). Cases that need NO enqueue (mid-OCR, already-has-run) don't count toward
    // the cap — they're cheap skips — so a tick that finds nothing missing still scans the full window.
    if (enqueued >= NEVER_ENQUEUED_PROCESS_CAP) { capped = true; break; }
    try {
      // Compute the current doc-set + whether all OCR-terminal + the case's RECENT runs (not just the latest).
      const [docsRaw, statuses, recentRuns] = await Promise.all([
        prisma.document.findMany({ where: { caseId }, select: { id: true, s3Key: true } }),
        prisma.fileReadStatus.findMany({ where: { caseId }, select: { filePath: true, terminalStatus: true } }),
        prisma.chartExtractionRun.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' }, take: 20, select: { status: true } }),
      ]);
      const docs = docsRaw.filter((d) => !isScreeningSummaryKey(d.s3Key));
      if (docs.length === 0) continue; // nothing to extract
      const terminalKeys = new Set(
        statuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath),
      );
      const allTerminal = docs.every((d) => terminalKeys.has(d.s3Key));
      if (!allTerminal) continue; // still OCR'ing — the /pages completion will enqueue naturally

      const currentHash = computeTriggerHash(docs, statuses);
      // STICKY anti-phantom (Dorf CLM-CA36097BA6, 2026-06-24). The old check looked ONLY at the LATEST run's
      // triggerHash, so when a COMPLETED run's stored hash drifted from the live recompute (read-status timing —
      // the #81 hash-instability), the watcher manufactured a phantom DUPLICATE run on an ALREADY-COMPLETE chart →
      // the recurring false "Chart analysis didn't finish — retry" the RN had to reprocess away (~half of cases in
      // 48h). Mirror deriveChartBuildState's stickiness (Ewell precedent): NEVER re-enqueue when ANY recent run is
      // complete/complete_with_gaps (the chart IS extracted, even if a later hash drifted) OR queued/running (a run
      // is already in flight — the primary upload/pages/delete path enqueued it). Only a case with NO complete and
      // NO in-flight run is a genuine never-enqueued orphan worth this backstop. A genuine doc-set CHANGE is handled
      // by the primary enqueue path (upload/pages/delete), not this backstop.
      const extractedOrInFlight = recentRuns.some((r) =>
        r.status === 'complete' || r.status === 'complete_with_gaps' || r.status === 'queued' || r.status === 'running');
      if (extractedOrInFlight) continue;

      // Missing run for an all-terminal doc-set → enqueue it (idempotent; P2002-safe under a race).
      const res = await maybeEnqueueChartExtract(prisma as unknown as AppDb, caseId);
      if (res.enqueued) {
        enqueued += 1;
        await prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId,
            action: 'chart_extract_run_enqueued_missing',
            detailsJson: { triggerHash: currentHash, note: 'All docs OCR-terminal but no extraction run existed for this doc-set; the safety watcher enqueued it.' },
          },
        });
        console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: enqueued missing run', caseId, triggerHash: currentHash }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        msg: 'stuck-chart-extract-run-watcher: never-enqueued per-case failed',
        caseId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  if (capped) {
    // The cap was hit — there is more backlog than one tick processes. Log LOUD (not silent) so the
    // remainder draining on the next tick is observable, never a sweep that quietly didn't finish.
    console.warn(JSON.stringify({
      msg: 'stuck-chart-extract-run-watcher: never-enqueued pass CAPPED — remainder drains next tick',
      enqueued,
      cap: NEVER_ENQUEUED_PROCESS_CAP,
      candidatesScanned: caseIds.length,
    }));
  }
  return enqueued;
}
