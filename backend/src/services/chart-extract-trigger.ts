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
import { computeTriggerHash, TERMINAL_READ_STATUSES } from './chart-build-state.js';
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

export async function maybeEnqueueChartExtract(db: AppDb, caseId: string, opts: ChartExtractTriggerOptions = {}): Promise<{ enqueued: boolean; reason?: string }> {
  const c = (await db.case.findFirst({ where: { id: caseId } })) as { veteranId: string } | null;
  if (c === null) return { enqueued: false, reason: 'case_not_found' };

  const docs = await (db as unknown as {
    document: { findMany: (args: { where: { caseId: string }; select: { id: true; s3Key: true } }) => Promise<{ id: string; s3Key: string }[]> };
  }).document.findMany({ where: { caseId }, select: { id: true, s3Key: true } });
  if (docs.length === 0) return { enqueued: false, reason: 'no_documents' };

  const readStatuses = (await db.fileReadStatus.findMany({ where: { caseId } })) as unknown as { filePath: string; terminalStatus: string }[];
  const terminalKeys = new Set(readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath));
  const allTerminal = docs.every((d) => terminalKeys.has(d.s3Key));
  if (!allTerminal) return { enqueued: false, reason: 'ocr_in_progress' };

  const triggerHash = computeTriggerHash(docs, readStatuses, opts.forceSalt);
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
  return { enqueued: true };
}
