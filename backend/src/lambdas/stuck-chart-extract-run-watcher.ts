import { PrismaClient } from '@prisma/client';
import { SERVICE_ACTORS } from '../services/service-actors.js';

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
  ranAt: string;
}

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

  if (stuck.length === 0) {
    console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: none', scanned: 0, swept: 0, ranAt: now.toISOString() }));
    return { scanned: 0, swept: 0, errors: 0, ranAt: now.toISOString() };
  }

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

  const summary = { scanned: stuck.length, swept, errors, ranAt: now.toISOString() };
  console.log(JSON.stringify({ msg: 'stuck-chart-extract-run-watcher: summary', ...summary }));
  return summary;
}
