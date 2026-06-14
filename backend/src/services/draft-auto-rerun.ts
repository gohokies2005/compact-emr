/**
 * Auto-re-run a timed-out / interrupted draft (ADDITION A of the document auto-recovery loop, 2026-06-14).
 *
 * CONFIRMED: the drafter pipeline CANNOT resume a partial run. A swept job is flipped to 'failed' and the
 * Fargate wrapper spawns a FRESH `run-letter-pipeline.js <caseId>` from scratch — there is no checkpoint
 * or resume-from-partial. So "resume the draft if it times out" is implemented as a bounded AUTO-RE-RUN:
 * a fresh, full draft job (NOT a partial resume). This helper is the single re-enqueue primitive the
 * stuck-job-watcher calls; it mirrors the POST /draft enqueue core (bundle → S3 → queued DraftJob →
 * publish) so a watcher-initiated re-run is byte-identical to an RN click, minus the HTTP concerns.
 *
 * Bounded: the watcher caps auto-re-runs per case (it counts the `draft_job_auto_rerun` markers since the
 * last RN-initiated draft and refuses past the cap) BEFORE calling this — so a chronically-failing case
 * fails to the human last resort (the OpsHeldPanel "click Send to Drafter again") rather than looping
 * cloud spend. This helper itself does ONE re-enqueue per call.
 *
 * acknowledgeMissingDocs is carried TRUE: a job that reached 'running' (the only thing the watcher
 * auto-re-runs) had already cleared the chart-readiness gate, so the re-run must not re-halt on unread
 * files — the KEYSTONE override flows through the bundle exactly as the RN-override path does.
 */

import { randomUUID } from 'node:crypto';
import { buildDrafterBundle, buildJobBundleS3Key, writeBundleToS3 } from './drafter-bundle.js';
import { stampCaseFraming } from './case-framing-stamp.js';
import { caseViabilityEnabled, stampCaseViability } from './case-viability-stamp.js';
import { publishDraftJobQueued } from './draft-job-queue.js';
import { SERVICE_ACTORS } from './service-actors.js';
import type { AppDb } from './db-types.js';

export const DRAFT_AUTO_RERUN_ACTION = 'draft_job_auto_rerun';

export interface DraftAutoRerunResult {
  readonly enqueued: boolean;
  readonly jobId?: string;
  readonly version?: number;
  readonly reason?: string;
}

/**
 * Enqueue a fresh full draft for a case whose prior run timed out. parentVersion = the failed job's
 * version (provenance: "this re-run supersedes vN"). Returns enqueued:false with a reason when it could
 * not (no PHI bucket configured, concurrent re-enqueue lost the in-flight race) — never throws into the
 * watcher loop.
 */
export async function enqueueAutoRerunForCase(
  db: AppDb,
  caseId: string,
  failedVersion: number,
): Promise<DraftAutoRerunResult> {
  const bucket = process.env['PHI_BUCKET_NAME'];
  if (typeof bucket !== 'string' || bucket.length === 0) {
    return { enqueued: false, reason: 'phi_bucket_unconfigured' };
  }

  // Never auto-re-run while a draft for this case is already in flight (a manual re-send beat us, or a
  // prior auto-re-run is still queued/running). The partial-unique in-flight index is the hard backstop;
  // this is the cheap pre-check.
  const inFlight = await db.draftJob.findFirst({ where: { caseId, state: { in: ['queued', 'running'] as const } } });
  if (inFlight !== null) return { enqueued: false, reason: 'already_in_flight' };

  const c = await db.case.findFirst({ where: { id: caseId } });
  if (c === null) return { enqueued: false, reason: 'case_not_found' };

  const maxVersionRow = await db.draftJob.findFirst({ where: { caseId }, orderBy: { version: 'desc' }, select: { version: true } });
  const nextVersion = Math.max(maxVersionRow?.version ?? 0, c.currentVersion ?? 0) + 1;
  const jobId = randomUUID();

  // Build the materialization bundle, carrying the KEYSTONE override (a running job had already cleared
  // the chart-readiness gate, so the re-run must not re-halt on unread files).
  let bundle = await buildDrafterBundle(db, caseId, { acknowledgeMissingDocs: true });
  bundle = await stampCaseFraming(db, caseId, bundle, { persist: true });
  if (caseViabilityEnabled()) {
    bundle = await stampCaseViability(db, caseId, bundle, { persist: true });
  }
  const bundleS3Key = buildJobBundleS3Key(caseId, jobId);
  await writeBundleToS3(bucket, bundleS3Key, bundle, 'job');

  try {
    await db.$transaction(async (tx) => {
      await tx.draftJob.create({
        data: { id: jobId, caseId, version: nextVersion, state: 'queued', bundleS3Key, parentVersion: failedVersion },
      });
      // Mark the case 'drafting' so the UI shows the re-run in progress (matches the POST /draft path).
      await tx.case.update({ where: { id: caseId }, data: { status: 'drafting' } });
      await tx.activityLog.create({
        data: {
          actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
          caseId,
          action: DRAFT_AUTO_RERUN_ACTION,
          detailsJson: {
            jobId,
            version: nextVersion,
            supersedesVersion: failedVersion,
            note: 'A prior draft run timed out / was interrupted. The drafter cannot resume a partial, so the safety watcher auto-RE-RAN a FRESH full draft (bounded once per case).',
          },
        },
      });
    });
  } catch (err) {
    // P2002 = the partial-unique in-flight index fired (a concurrent re-enqueue won the race). Benign:
    // the other enqueue is the live draft; this one no-ops. The orphaned bundle is reaped by S3 lifecycle.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
      return { enqueued: false, reason: 'concurrent_enqueue' };
    }
    throw err;
  }

  await publishDraftJobQueued({ jobId, caseId, version: nextVersion, bundleS3Key, parentVersion: failedVersion });
  return { enqueued: true, jobId, version: nextVersion };
}
