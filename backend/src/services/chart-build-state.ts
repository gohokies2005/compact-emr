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
]);

export interface DocRef {
  id: string;
  s3Key: string;
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
 */
export function computeTriggerHash(documents: readonly DocRef[], readStatuses: readonly ReadStatusRef[]): string {
  const statusByKey = new Map(readStatuses.map((r) => [r.filePath, r.terminalStatus]));
  const pairs = documents.map((d) => `${d.id}:${statusByKey.get(d.s3Key) ?? 'none'}`).sort();
  return createHash('sha256').update(pairs.join('|')).digest('hex');
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
 * Derive where the chart-build pipeline is for a case from documents + read statuses + the latest
 * extraction run. The door uses this: only `chart_ready` evaluates real missing-docs; the other
 * states are "still building" (or a surfaced failure), never a false "documents missing".
 */
export function deriveChartBuildState(
  documents: readonly DocRef[],
  readStatuses: readonly ReadStatusRef[],
  latestRun: ExtractionRunRef | null,
): ChartBuildStatus {
  if (documents.length === 0) return { state: 'no_documents', currentHash: '' };

  const terminalKeys = new Set(
    readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath),
  );
  const allTerminal = documents.every((d) => terminalKeys.has(d.s3Key));
  const currentHash = computeTriggerHash(documents, readStatuses);

  if (!allTerminal) return { state: 'ocr_in_progress', currentHash };

  // All docs are OCR-terminal. Has extraction for THIS exact doc set finished?
  if (latestRun && latestRun.triggerHash === currentHash) {
    if (latestRun.status === 'complete') return { state: 'chart_ready', currentHash };
    if (latestRun.status === 'failed') return { state: 'extract_failed', currentHash };
    return { state: 'extracting', currentHash }; // queued | running
  }
  // No run yet for the current doc set (it just became terminal, or a new upload changed the hash):
  // a run is about to be / was just enqueued. Treat as still-building, not chart_ready.
  return { state: 'extracting', currentHash };
}
