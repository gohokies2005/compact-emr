/**
 * Auto-remediate-on-draft — the THIN fallback rung of the document auto-recovery loop (2026-06-14).
 *
 * Architecture decision (honored): remediate-on-UPLOAD is the PRIMARY healing path; this is the THIN
 * fallback for the case that still arrives at the draft door with unread files. It REUSES the existing
 * reprocess primitive (nudgeDocumentReocr + maybeEnqueueChartExtract with a forceSalt) and the EXISTING
 * extractionState ('extracting') + the frontend's 8s readiness poll as the "held, auto-resuming" model —
 * it deliberately adds NO new case state (a parallel state is the divergence class this project keeps
 * getting bitten by).
 *
 * The RN clicks "Send to Drafter" ONCE and walks away: when the chart isn't ready AND there is no
 * override/rnDecision, the /draft route calls this instead of dead-ending to a 409. It:
 *   1. If a remediation/extraction is ALREADY in flight (build-state extracting | ocr_in_progress),
 *      returns 'preparing' WITHOUT re-firing — so a retried/polled draft never re-triggers (no loop).
 *   2. Else, if we have ALREADY auto-remediated for THIS exact doc-set (a `case_auto_remediated`
 *      activity-log marker whose triggerHash matches the current doc-set), auto-recovery is EXHAUSTED:
 *      returns 'exhausted' so the route surfaces the overridable 409 + the last-resort banner. We do
 *      NOT loop forever re-reading files that already failed.
 *   3. Else fires the reprocess primitive ONCE (re-OCR every non-terminal doc + force a fresh extract),
 *      writes the `case_auto_remediated` marker keyed on the current triggerHash, returns 'preparing'.
 *
 * Bounded: AT MOST ONCE per draft click per doc-set. The forceSalt is DETERMINISTIC — derived from the
 * current doc-set triggerHash (FIX 4, 2026-06-14) — so two concurrent draft POSTs for the SAME doc-set
 * compute the SAME salted hash and the second collapses to P2002 → 'already_enqueued' (a random salt
 * defeated this, double-spending). The triggerHash marker also dedups across the poll loop; a new upload
 * changes the triggerHash (and thus the salt) so a genuinely-changed chart can remediate again (new work).
 */

import { S3Client } from '@aws-sdk/client-s3';
import {
  computeTriggerHash,
  deriveChartBuildState,
  isScreeningSummaryKey,
  runMatchesHash,
  TERMINAL_READ_STATUSES,
} from './chart-build-state.js';
import { maybeEnqueueChartExtract } from './chart-extract-trigger.js';
import { nudgeDocumentReocr } from './document-reocr.js';
import type { AppDb } from './db-types.js';

export type ChartAutoRemediateOutcome =
  // A remediation is now running (just fired, or was already in flight) — the route returns a 202-style
  // "preparing" response and the frontend's 8s poll holds + auto-resumes when extractionState===chart_ready.
  | { readonly state: 'preparing'; readonly remediated: boolean; readonly reocrQueued: number; readonly triggerHash: string }
  // Auto-recovery already ran for this exact doc-set and the chart is still blocked — the human last
  // resort: the route surfaces the overridable 409 + the persistent banner.
  | { readonly state: 'exhausted'; readonly triggerHash: string };

let cachedS3: S3Client | null = null;
function getS3(): S3Client {
  if (cachedS3 === null) cachedS3 = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' });
  return cachedS3;
}

// The activity-log action that marks an auto-remediation. Keyed (in detailsJson) on the triggerHash so
// the once-per-doc-set guard can tell "we already tried THIS doc-set" from "the chart changed since".
export const AUTO_REMEDIATE_ACTION = 'case_auto_remediated';

interface ChartAutoRemediateDeps {
  readonly s3?: S3Client;
  readonly bucketName?: string;
}

/**
 * Run the bounded auto-remediation for a case whose chart is not ready at the draft door. Pure of HTTP
 * concerns; the route maps the outcome to a 202 ('preparing') or the overridable 409 ('exhausted').
 */
export async function autoRemediateChartForDraft(
  db: AppDb,
  caseId: string,
  actorUserId: string,
  deps: ChartAutoRemediateDeps = {},
): Promise<ChartAutoRemediateOutcome> {
  const bucketName = deps.bucketName ?? process.env['PHI_BUCKET_NAME'];
  const s3 = deps.s3 ?? getS3();

  // Pull the case's documents + read-statuses to compute the CURRENT doc-set triggerHash + build-state.
  const allDocs = (await (db as unknown as {
    document: { findMany: (a: { where: { caseId: string }; select: { id: true; s3Key: true; contentType: true } }) => Promise<{ id: string; s3Key: string; contentType: string | null }[]> };
  }).document.findMany({ where: { caseId }, select: { id: true, s3Key: true, contentType: true } }));
  const readStatuses = (await db.fileReadStatus.findMany({ where: { caseId } })) as unknown as { filePath: string; terminalStatus: string }[];

  // Build-state inputs exclude the screening-summary OUTPUT (same as every other consumer).
  const buildDocs = allDocs.filter((d) => !isScreeningSummaryKey(d.s3Key)).map((d) => ({ id: d.id, s3Key: d.s3Key }));
  const latestRun = await (db as unknown as {
    chartExtractionRun: { findFirst: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { triggerHash: true; status: true } }) => Promise<{ triggerHash: string; status: string } | null> };
  }).chartExtractionRun.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { triggerHash: true, status: true } });
  const build = deriveChartBuildState(
    buildDocs,
    readStatuses.map((r) => ({ filePath: r.filePath, terminalStatus: r.terminalStatus })),
    latestRun,
  );
  const triggerHash = computeTriggerHash(buildDocs, readStatuses);

  // (1) Already building — a remediation/extraction is in flight. Return 'preparing' and DO NOT re-fire,
  // so a retried/polled draft click cannot loop the reprocess primitive (Ryan: never on every poll).
  if (build.state === 'extracting' || build.state === 'ocr_in_progress') {
    return { state: 'preparing', remediated: false, reocrQueued: 0, triggerHash };
  }

  // (2) Already auto-remediated for THIS exact doc-set? Then re-reading the same files will not help —
  // auto-recovery is exhausted; surface the overridable 409 + the banner. The marker carries the
  // triggerHash so a NEW upload (new hash) is NOT mistaken for the same exhausted doc-set.
  // activityLog's typed delegate exposes only create(); read prior markers through an untyped cast (the
  // same off-surface-delegate pattern used across this codebase). detailsJson carries the triggerHash.
  const priorMarkers = await (db as unknown as {
    activityLog: { findMany: (a: { where: { caseId: string; action: string } }) => Promise<{ detailsJson?: { triggerHash?: unknown } | null }[]> };
  }).activityLog.findMany({ where: { caseId, action: AUTO_REMEDIATE_ACTION } });
  const alreadyRemediatedThisDocSet = priorMarkers.some((m) => {
    const h = m.detailsJson && typeof m.detailsJson === 'object' ? (m.detailsJson as { triggerHash?: unknown }).triggerHash : undefined;
    return typeof h === 'string' && runMatchesHash(h, triggerHash);
  });
  if (alreadyRemediatedThisDocSet) {
    return { state: 'exhausted', triggerHash };
  }

  // (3) Fire the reprocess primitive ONCE: re-OCR every doc with no terminal read outcome, then force a
  // fresh extract (salted hash). Reuses the EXACT primitives POST /cases/:id/reprocess uses (one copy).
  const terminalKeys = new Set(
    readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath),
  );
  let reocrQueued = 0;
  if (typeof bucketName === 'string' && bucketName.length > 0) {
    for (const doc of allDocs) {
      if (terminalKeys.has(doc.s3Key)) continue;
      if (isScreeningSummaryKey(doc.s3Key)) continue;
      try {
        await nudgeDocumentReocr(s3, bucketName, { s3Key: doc.s3Key, contentType: doc.contentType });
        reocrQueued += 1;
      } catch {
        // Per-file nudge failure is non-fatal — the force-extract below still rides the existing trigger,
        // and the marker prevents a re-fire loop. (A bucket misconfig surfaces via the 'exhausted' path.)
      }
    }
  }
  // DETERMINISTIC remediation salt (FIX 4, 2026-06-14). A RANDOM salt (was: a fresh randomUUID per call)
  // DEFEATED the (caseId, triggerHash) INSERT-as-mutex: two near-simultaneous draft POSTs that BOTH
  // pass the in-flight guard (1) and the no-prior-marker guard (2) each minted a different random salt
  // → two distinct triggerHashes → two ChartExtractionRun rows → double LLM spend (~$6 each). The salt
  // is now derived from the case + the CURRENT doc-set fingerprint (the unsalted triggerHash), so two
  // remediations for the SAME unchanged doc-set produce the SAME salted hash → the second hits P2002 and
  // collapses to 'already_enqueued' (dedup holds). A NEW upload changes the base triggerHash → a
  // different salt → re-arms remediation (correct: genuinely new work). `manual:` prefix preserved so
  // the forceSalt format (`manual:<token>`) the trigger documents is unchanged.
  const forceSalt = `manual:remediate:${triggerHash}`;
  await maybeEnqueueChartExtract(db, caseId, { forceSalt });

  // Write the once-per-doc-set marker (keyed on triggerHash) BEFORE returning so a concurrent/retried
  // draft in the same window sees it and does not double-fire. detailsJson carries the hash + counts.
  await db.activityLog.create({
    data: {
      actorUserId,
      caseId,
      action: AUTO_REMEDIATE_ACTION,
      detailsJson: { triggerHash, reocrQueued, forceSalt, trigger: 'send_to_drafter_auto_recovery' },
    },
  });

  return { state: 'preparing', remediated: true, reocrQueued, triggerHash };
}
