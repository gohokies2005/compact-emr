/**
 * Chart-build pipeline state + the shared trigger hash. This is the spine that makes the draft
 * "door" correct: it distinguishes "the chart is still being built from the records" from
 * "essential documents are missing", so the RN is never falsely told to upload something while
 * OCR/extraction are still running (Ryan 2026-06-03 — "how is she stopped at the door if the PDFs
 * aren't parsed yet?").
 *
 * Pure module. Imported by BOTH the /pages trigger (idempotency latch) and getDraftReadiness
 * (staleness + door state). computeTriggerHash MUST NOT be reimplemented anywhere else.
 */

import { createHash } from 'node:crypto';

/**
 * The provenance `source` value the auto-extractor's merge writes. The schema default stays
 * 'manual', so this is the ONLY non-manual value — making 'manual' rows immutable to the extractor.
 * Single source of truth: schema, worker, merge endpoint, and readiness all import this.
 */
export const EXTRACTED_SOURCE = 'extracted';

/**
 * file_read_status.terminalStatus values that mean a document is DONE being read — success,
 * RN-resolved, or failed-needs-manual-summary. All are terminal: extraction proceeds on whatever
 * was readable, and a single un-OCR-able file never strands the case in "still building".
 */
export const TERMINAL_READ_STATUSES: ReadonlySet<string> = new Set([
  'read',
  'manual_summary_provided',
  'manual_summary_required',
  // 'auto_skipped' (document auto-recovery loop, 2026-06-14): a genuinely empty/invalid file the
  // system auto-skipped. It is DONE being read (terminal), so it must count toward all-terminal here
  // exactly like manual_summary_required — otherwise an auto-skipped file would wedge the build in
  // 'ocr_in_progress' forever (it never reaches 'read').
  'auto_skipped',
]);

export interface DocRef {
  id: string;
  s3Key: string;
}

// The auto-generated screening-summary file is an extraction OUTPUT, not an input. It has a stable
// s3Key marker (cases/<id>/00000000-screening-summary.txt) recognized here so the build-state +
// trigger-hash IGNORE it everywhere in ONE place (every caller already passes s3Key): it carries no
// OCR file_read_status (would stall allTerminal) and must not change the trigger hash (would
// re-trigger extraction in a loop). Keep this marker in sync with the screening-summary writer.
export const SCREENING_SUMMARY_KEY_MARKER = '00000000-screening-summary.txt';
export function isScreeningSummaryKey(s3Key: string): boolean {
  return s3Key.endsWith(SCREENING_SUMMARY_KEY_MARKER);
}
export interface ReadStatusRef {
  filePath: string;
  terminalStatus: string;
}
export interface ExtractionRunRef {
  triggerHash: string;
  status: string;
}

/**
 * Deterministic hash of the case's (documentId, terminalStatus) set. Same documents + same read
 * outcomes → same hash → the idempotency latch treats it as one run. A new upload, or a file's
 * read outcome changing, → a new hash → a fresh extraction run (which re-merges and clears gaps).
 *
 * `salt` (keystone 4b, the FORCED-reprocess path): when provided, the stored value becomes
 * `<sha256>:<salt>` — the base hash stays a recoverable PREFIX, so deriveChartBuildState can tie a
 * forced run back to the doc set it re-extracted (a plain re-hash would orphan the run and wedge
 * the door in 'extracting'). No salt → byte-identical to the historical hash (locked by test);
 * every non-force caller is unchanged. Salt format used by the reprocess route:
 * `manual:<requestId>` — deterministic within one request, unique across requests, so the
 * (caseId, triggerHash) INSERT-as-mutex dedups a same-request retry via P2002 but a NEW reprocess
 * always creates a fresh run.
 */
export function computeTriggerHash(documents: readonly DocRef[], readStatuses: readonly ReadStatusRef[], salt?: string): string {
  const inputs = documents.filter((d) => !isScreeningSummaryKey(d.s3Key)); // exclude the extraction OUTPUT file
  const statusByKey = new Map(readStatuses.map((r) => [r.filePath, r.terminalStatus]));
  const pairs = inputs.map((d) => `${d.id}:${statusByKey.get(d.s3Key) ?? 'none'}`).sort();
  const base = createHash('sha256').update(pairs.join('|')).digest('hex');
  return salt !== undefined && salt.length > 0 ? `${base}:${salt}` : base;
}

/**
 * Does a run's stored triggerHash belong to the doc set hashed as `currentHash`? Exact match
 * (normal runs) OR salted-prefix match (`<currentHash>:manual:<requestId>` — forced reprocess
 * runs, keystone 4b). The ':' separator can never appear in a bare sha256 hex, so a prefix match
 * is unambiguous.
 */
export function runMatchesHash(runTriggerHash: string, currentHash: string): boolean {
  return runTriggerHash === currentHash || runTriggerHash.startsWith(`${currentHash}:`);
}

export type ChartBuildState =
  | 'no_documents'
  | 'ocr_in_progress'
  | 'extracting'
  | 'chart_ready'
  | 'extract_failed';

export interface ChartBuildStatus {
  state: ChartBuildState;
  currentHash: string;
}

/**
 * Derive where the chart-build pipeline is for a case from documents + read statuses + the case's
 * recent extraction runs. The door uses this: only `chart_ready` evaluates real missing-docs; the
 * other states are "still building" (or a surfaced failure), never a false "documents missing".
 *
 * STICKINESS (Ewell CLM-A867B8C128, 2026-06-14): a completed extraction is STICKY. Keying only on
 * the LATEST run mis-fired live: the chart extracted successfully (195 facts, 100% coverage), but a
 * DUPLICATE run was then enqueued ('queued') — so latest-run logic returned 'extracting' and froze
 * the Send-to-Drafter door; the stuck-run watcher then swept that duplicate to 'failed', flipping
 * the door to 'extract_failed' — all while a PRIOR run for the SAME doc set had already COMPLETED.
 * Fix: consider ALL recent runs and let ANY completed run matching the current doc set win. A later
 * duplicate (queued/running/failed) can never un-ready a chart that already extracted. Precedence
 * among runs matching the current hash: complete(+gaps) > queued/running > failed > none.
 */
export function deriveChartBuildState(
  documents: readonly DocRef[],
  readStatuses: readonly ReadStatusRef[],
  runs: readonly ExtractionRunRef[],
): ChartBuildStatus {
  // Exclude the extraction OUTPUT (screening-summary file): it has no OCR status and would both stall
  // allTerminal and (via computeTriggerHash) churn the hash. computeTriggerHash filters it too.
  const inputs = documents.filter((d) => !isScreeningSummaryKey(d.s3Key));
  if (inputs.length === 0) return { state: 'no_documents', currentHash: '' };

  const terminalKeys = new Set(
    readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath),
  );
  const allTerminal = inputs.every((d) => terminalKeys.has(d.s3Key));
  const currentHash = computeTriggerHash(documents, readStatuses);

  if (!allTerminal) return { state: 'ocr_in_progress', currentHash };

  // All docs are OCR-terminal. Among the runs that belong to THIS exact doc set — exact hash match,
  // or salted-prefix match for a FORCED reprocess run (keystone 4b) — apply sticky precedence:
  //   • ANY complete / complete_with_gaps → chart_ready (STICKY: wins over a later duplicate run).
  //   • else ANY queued / running        → extracting.
  //   • else ANY failed                  → extract_failed.
  // ('complete_with_gaps', audit 2026-06-13: door still OPENS — a 3-page gap on a 2,000-page bundle
  // shouldn't block; the RN is flagged via the gaps surfaced on the readiness response.)
  const matching = runs.filter((r) => runMatchesHash(r.triggerHash, currentHash));
  if (matching.some((r) => r.status === 'complete' || r.status === 'complete_with_gaps')) {
    return { state: 'chart_ready', currentHash };
  }
  if (matching.some((r) => r.status === 'queued' || r.status === 'running')) {
    return { state: 'extracting', currentHash };
  }
  if (matching.some((r) => r.status === 'failed')) {
    return { state: 'extract_failed', currentHash };
  }
  // No run yet for the current doc set (it just became terminal, or a new upload changed the hash):
  // a run is about to be / was just enqueued. Treat as still-building, not chart_ready.
  return { state: 'extracting', currentHash };
}
