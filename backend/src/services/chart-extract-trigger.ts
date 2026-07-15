/**
 * Chart auto-extract trigger. Called AFTER the /pages $transaction commits (in a log-only
 * try/catch), so an enqueue failure can never roll back or affect the OCR page write — the live
 * critical path is fully protected.
 *
 * Fires exactly once per (case, doc-set): when every document for the case is OCR-terminal, it
 * inserts a ChartExtractionRun keyed by the unique (caseId, triggerHash) — an INSERT-AS-MUTEX.
 * A concurrent doc-completion that also sees "all terminal" hits the unique violation (P2002) and
 * silently no-ops, so the staggered-completion race resolves to a single run. A new upload changes
 * the triggerHash → a fresh run (re-extract), with no duplicate of the prior one.
 */

import { randomUUID } from 'node:crypto';
import { computeTriggerHash, TERMINAL_READ_STATUSES, isScreeningSummaryKey } from './chart-build-state.js';
import { publishChartExtractQueued } from './chart-extract-queue.js';
import type { AppDb } from './db-types.js';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export interface ChartExtractTriggerOptions {
  /**
   * Keystone 4b (reprocess endpoint): salt for a FORCED re-extract. The stored triggerHash becomes
   * `<baseHash>:<salt>` (salt format `manual:<requestId>`), so the INSERT-as-mutex creates a FRESH
   * run where the unsalted hash would P2002-no-op against a prior run of the same doc set. The
   * all-terminal gate still applies — when docs are mid-OCR the force returns 'ocr_in_progress'
   * and the next /pages completion re-triggers naturally (the force "rides the existing trigger").
   */
  readonly forceSalt?: string;
}

// RUNAWAY GUARD (Ryan 2026-06-20 — CLM-CCFDA1BCC3 re-extracted every ~2 min, ~$34/hr, silently). A
// forceSalt enqueue mints a fresh triggerHash every call, so a client/automation hammering reprocess
// or force-extract creates unbounded paid runs. Cap a case to ONE extraction per window: if a run was
// created within RATE_WINDOW_MS and isn't failed, refuse. Legit re-extracts (new upload, a fix-driven
// reprocess) are minutes/hours/days apart, so they pass; only rapid repeats are blocked. A FAILED run
// is exempt so failure-recovery can retry immediately.
const RATE_WINDOW_MS = 5 * 60 * 1000;

// HARD PER-CASE BUDGET (Ryan 2026-07-14 — "$146 in silent duplicate extractions; we need a real stop,
// not an email"). The scoped rate guard above blocks same-hash hammers, but any producer that GROWS the
// doc set per call (the assign loop pre-barrier; a future sweep/watcher bug) mints a fresh hash each
// time and sails past it — 68 paid runs in 18h. This is the loop-shape-agnostic backstop: more than
// MAX_RUNS_PER_BUDGET_WINDOW runs created for one case inside BUDGET_WINDOW_MS is not a workflow, it is
// a runaway. Refuse NON-FORCED enqueues past the cap (loud log line feeds the runs-per-case alarm); a
// FORCED re-extract (an explicit human action) passes the cap but still logs. Legit ceiling for real
// work is ~2-3 runs/hr (initial + a late upload + a manual re-run) — 6 leaves generous headroom.
const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const MAX_RUNS_PER_BUDGET_WINDOW = 6;

export async function maybeEnqueueChartExtract(db: AppDb, caseId: string, opts: ChartExtractTriggerOptions = {}): Promise<{ enqueued: boolean; reason?: string }> {
  const c = (await db.case.findFirst({ where: { id: caseId } })) as { veteranId: string } | null;
  if (c === null) return { enqueued: false, reason: 'case_not_found' };

  // Gather the doc set + OCR statuses and compute the incoming triggerHash FIRST, so the runaway guard
  // below can be scoped to the SAME doc set (or a forced repeat) rather than blocking a genuinely-grown
  // one — the staggered-upload WEDGE (Jericho CLM-E22AE69A8C, 2026-07-12): the first run fired over a
  // PARTIAL doc set, then every "docs grew → re-extract the full set" enqueue was rate-refused, orphaning
  // the partial run and wedging the chart at build-state=extracting until an expensive on-open self-heal.
  const allDocs = await (db as unknown as {
    document: { findMany: (args: { where: { caseId: string }; select: { id: true; s3Key: true } }) => Promise<{ id: string; s3Key: string }[]> };
  }).document.findMany({ where: { caseId }, select: { id: true, s3Key: true } });
  // Exclude the auto-generated screening-summary OUTPUT file (cases/<id>/00000000-screening-summary.txt):
  // it is NOT an OCR input — ocr-start skips it, so it NEVER gets a terminal FileReadStatus. Counting it
  // in the all-terminal gate made every RE-extract (and the forced reprocess) wedge at 'ocr_in_progress'
  // FOREVER once the first extraction created the summary — the bug Ryan caught on Jamarious 2026-06-13.
  // computeTriggerHash + deriveChartBuildState already exclude it via the same marker; this gate must too.
  const docs = allDocs.filter((d) => !isScreeningSummaryKey(d.s3Key));
  if (docs.length === 0) return { enqueued: false, reason: 'no_documents' };

  const readStatuses = (await db.fileReadStatus.findMany({ where: { caseId } })) as unknown as { filePath: string; terminalStatus: string }[];
  const terminalKeys = new Set(readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath));
  const allTerminal = docs.every((d) => terminalKeys.has(d.s3Key));
  if (!allTerminal) return { enqueued: false, reason: 'ocr_in_progress' };

  const triggerHash = computeTriggerHash(docs, readStatuses, opts.forceSalt);

  // RUNAWAY GUARD (Ryan 2026-06-20 — CLM-CCFDA1BCC3 re-extracted every ~2 min, ~$34/hr), SCOPED
  // (2026-07-12): refuse a re-enqueue within the window ONLY when it is the SAME doc set (same
  // triggerHash — a genuine hammer, which the (caseId,triggerHash) mutex would also P2002-dedup) OR a
  // FORCED re-extract (forceSalt mints a fresh hash every call, bypassing the mutex → the exact runaway
  // this guard exists for). A NON-forced enqueue whose doc set GREW (a DIFFERENT hash) is a legitimate
  // re-extract and MUST pass — blocking it is what orphaned the partial run and wedged the chart.
  const recentRun = await (db as unknown as {
    chartExtractionRun: { findFirst: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { createdAt: true; status: true; triggerHash: true } }) => Promise<{ createdAt: Date; status: string; triggerHash: string } | null> };
  }).chartExtractionRun.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, status: true, triggerHash: true } });
  if (recentRun && recentRun.status !== 'failed') {
    const ageMs = Date.now() - new Date(recentRun.createdAt).getTime();
    const sameDocSetOrForced = opts.forceSalt !== undefined || recentRun.triggerHash === triggerHash;
    if (ageMs >= 0 && ageMs < RATE_WINDOW_MS && sameDocSetOrForced) {
      console.warn(JSON.stringify({ event: 'chart_extract_rate_limited', caseId, lastRunAgeMs: ageMs, lastStatus: recentRun.status, windowMs: RATE_WINDOW_MS, forced: opts.forceSalt !== undefined }));
      return { enqueued: false, reason: 'rate_limited_recent_run' };
    }
  }

  // HARD PER-CASE BUDGET — the loop-shape-agnostic runaway stop (see constant docs above).
  const budgetWindowStart = new Date(Date.now() - BUDGET_WINDOW_MS);
  const runsInWindow = await (db as unknown as {
    chartExtractionRun: { count: (a: { where: { caseId: string; createdAt: { gte: Date } } }) => Promise<number> };
  }).chartExtractionRun.count({ where: { caseId, createdAt: { gte: budgetWindowStart } } });
  if (runsInWindow >= MAX_RUNS_PER_BUDGET_WINDOW) {
    if (opts.forceSalt === undefined) {
      console.error(JSON.stringify({ event: 'chart_extract_budget_refused', caseId, runsInWindow, windowMs: BUDGET_WINDOW_MS, cap: MAX_RUNS_PER_BUDGET_WINDOW }));
      return { enqueued: false, reason: 'budget_refused_runaway' };
    }
    console.warn(JSON.stringify({ event: 'chart_extract_budget_forced_past_cap', caseId, runsInWindow, windowMs: BUDGET_WINDOW_MS, cap: MAX_RUNS_PER_BUDGET_WINDOW }));
  }

  const runId = randomUUID();

  // INSERT-AS-MUTEX on the unique (caseId, triggerHash). P2002 → another doc-completion already
  // enqueued this exact run; benign no-op.
  try {
    await (db as unknown as {
      chartExtractionRun: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    }).chartExtractionRun.create({
      data: { id: runId, caseId, veteranId: c.veteranId, triggerHash, status: 'queued' },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { enqueued: false, reason: 'already_enqueued' };
    throw err;
  }

  try {
    await publishChartExtractQueued({ runId, caseId, veteranId: c.veteranId, triggerHash });
  } catch (err) {
    // The run row committed but no message reached the queue. Don't leave it 'queued' forever —
    // the build-state door would show "still building" with no recovery (a silent dead-end that
    // violates RN-self-service). DELETE the row so the NEXT /pages callback for this same doc-set
    // (triggerHash is stable) re-inserts + re-publishes cleanly. The stuck-run watcher is the
    // durable backstop (follow-up, mirrors the DoctorPack/DraftJob watchers). (architect M1, 2026-06-03)
    await (db as unknown as { chartExtractionRun: { delete: (a: { where: { id: string } }) => Promise<unknown> } })
      .chartExtractionRun.delete({ where: { id: runId } }).catch(() => { /* best-effort */ });
    throw err;
  }
  // Fail-LOUD on SUCCESS too (the agent's finding: a successful enqueue logged nothing, so a runaway
  // producer was invisible). Now every enqueue leaves a line — feeds a runs-per-case alarm.
  console.warn(JSON.stringify({ event: 'chart_extract_enqueued', caseId, runId, forced: opts.forceSalt !== undefined }));
  return { enqueued: true };
}
