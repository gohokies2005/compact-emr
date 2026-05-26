import { PrismaClient } from '@prisma/client';
import { publishDoctorPackQueued } from '../services/doctor-pack-queue.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';

/**
 * Architect audit G1 + G6: stuck-DoctorPack watcher.
 *
 * Two stuck states the existing pipeline doesn't recover from on its own — both leave the
 * RN looking at a "queued" or "generating" status forever with no path to retry:
 *
 *   QUEUED stuck (G6): POST /cases/:id/doctor-pack/generate creates the row, then tries to
 *     publish to SQS. If publish fails (queue URL misconfigured, throttled, transient
 *     network), the catch logs a warning and returns 201 — but the SQS message never
 *     arrived. Row sits in 'queued' indefinitely with no consumer.
 *
 *   GENERATING stuck (G1): SQS message reached the assembler, the assembler PATCHed the
 *     row to 'generating', then crashed (OOM on large case, WeasyPrint segfault, container
 *     evict). Row stays 'generating' indefinitely. The Lambda SQS event source has its own
 *     visibility timeout + DLQ for redelivery, but the DOM mutation on the row is what
 *     blocks the RN; the assembler doesn't reset state on retry.
 *
 * Sweep policy:
 *   - QUEUED + createdAt < NOW - 5 min  -> re-publish to SQS (idempotent: dedup key on
 *     content), bump updatedAt so the next sweep doesn't re-trigger immediately
 *   - GENERATING + updatedAt < NOW - 15 min -> flip state='failed' with an RN-friendly
 *     errorMessage. The activity_log records the sweep. The /cases/:id/doctor-pack/latest
 *     query already returns the failed row, so the RN can re-click Generate from the UI.
 *
 * Scheduled every 5 min via EventBridge from WorkersStack.
 */

const QUEUED_STALE_MS = 5 * 60 * 1000;
// 20 min instead of 15: the assembler Lambda timeout is exactly 15 min, so a strict 15-min
// boundary would race with a legitimate long-running assembly. 5 min of cushion gives
// borderline cases room to finish their final PATCH.
const GENERATING_STALE_MS = 20 * 60 * 1000;
const BATCH_LIMIT = 50;

let cachedPrisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (cachedPrisma !== null) return cachedPrisma;
  cachedPrisma = new PrismaClient();
  return cachedPrisma;
}

export interface StuckDoctorPackWatcherResult {
  ranAt: string;
  queuedRepublished: number;
  generatingFailed: number;
  errors: number;
}

/**
 * RN-friendly fail message. No infra jargon (no "Lambda", "WeasyPrint", "Fargate" etc.) —
 * just what the RN needs to know plus what to do.
 */
const GENERATING_TIMEOUT_MESSAGE =
  'We had a problem putting together this Doctor Pack and gave up after 15 minutes. Click Generate to try again. If it keeps failing, please flag this case to Dr. Ryan.';

export async function handler(): Promise<StuckDoctorPackWatcherResult> {
  const now = new Date();
  const queuedBoundary = new Date(now.getTime() - QUEUED_STALE_MS);
  const generatingBoundary = new Date(now.getTime() - GENERATING_STALE_MS);
  const prisma = getPrisma();

  let queuedRepublished = 0;
  let generatingFailed = 0;
  let errors = 0;

  // ===== G6: re-publish stale queued rows =====
  // Filter on updatedAt (NOT createdAt) so that once a sweep bumps updatedAt, the next
  // run waits 5 min before re-attempting. Mirrors the generating-sweep pattern and avoids
  // a thundering-herd if DOCTOR_PACK_QUEUE_URL is genuinely misconfigured (we don't burn
  // through every queued row every 5 min in that case).
  const staleQueued = await prisma.doctorPack.findMany({
    where: { state: 'queued', updatedAt: { lt: queuedBoundary } },
    take: BATCH_LIMIT,
  });

  for (const row of staleQueued) {
    try {
      const pdfS3Key = row.pdfS3Key;
      if (pdfS3Key === null || pdfS3Key.length === 0) {
        console.error(JSON.stringify({
          msg: 'stuck-doctor-pack-watcher: queued row has no pdfS3Key, skipping',
          doctorPackId: row.id,
          caseId: row.caseId,
        }));
        errors += 1;
        continue;
      }
      // publishDoctorPackQueued uses MessageDeduplicationId=doctorPackId, so re-publish is
      // safe — SQS will dedup if the original was already in flight; if it was dropped
      // (the G6 scenario), this delivers it.
      const publishResult = await publishDoctorPackQueued({
        doctorPackId: row.id,
        caseId: row.caseId,
        pdfS3Key,
        manifest: row.manifestJson,
      });
      // Architect QA: if the helper skipped (queueUrl unset/test mode), don't count as a
      // successful republish — that's a misconfig signal, not a recovery.
      if (publishResult.skipped) {
        errors += 1;
        console.error(JSON.stringify({
          msg: 'stuck-doctor-pack-watcher: republish skipped (queue misconfigured?)',
          doctorPackId: row.id,
          caseId: row.caseId,
          reason: publishResult.reason ?? 'unknown',
        }));
        continue;
      }
      // Bump updatedAt so the next 5-min sweep doesn't immediately re-trigger.
      await prisma.$transaction([
        prisma.doctorPack.update({
          where: { id: row.id },
          data: { updatedAt: now, version: { increment: 1 } },
        }),
        prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId: row.caseId,
            action: 'doctor_pack_sqs_republished',
            detailsJson: {
              doctorPackId: row.id,
              caseId: row.caseId,
              createdAt: row.createdAt.toISOString(),
              staleThresholdMin: 5,
            },
          },
        }),
      ]);
      queuedRepublished += 1;
      console.log(JSON.stringify({
        msg: 'stuck-doctor-pack-watcher: republished queued row',
        doctorPackId: row.id,
        caseId: row.caseId,
      }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({
        msg: 'stuck-doctor-pack-watcher: republish failed',
        doctorPackId: row.id,
        caseId: row.caseId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // ===== G1: fail stale generating rows =====
  const staleGenerating = await prisma.doctorPack.findMany({
    where: { state: 'generating', updatedAt: { lt: generatingBoundary } },
    take: BATCH_LIMIT,
  });

  for (const row of staleGenerating) {
    try {
      await prisma.$transaction([
        prisma.doctorPack.update({
          where: { id: row.id },
          data: {
            state: 'failed',
            errorMessage: GENERATING_TIMEOUT_MESSAGE,
            version: { increment: 1 },
          },
        }),
        prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId: row.caseId,
            action: 'doctor_pack_swept_stale_generating',
            detailsJson: {
              doctorPackId: row.id,
              caseId: row.caseId,
              priorState: row.state,
              updatedAtBeforeSweep: row.updatedAt.toISOString(),
              staleThresholdMin: 15,
            },
          },
        }),
      ]);
      generatingFailed += 1;
      console.log(JSON.stringify({
        msg: 'stuck-doctor-pack-watcher: swept stale generating row',
        doctorPackId: row.id,
        caseId: row.caseId,
      }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({
        msg: 'stuck-doctor-pack-watcher: generating sweep failed',
        doctorPackId: row.id,
        caseId: row.caseId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const summary: StuckDoctorPackWatcherResult = {
    ranAt: now.toISOString(),
    queuedRepublished,
    generatingFailed,
    errors,
  };
  console.log(JSON.stringify({ msg: 'stuck-doctor-pack-watcher: summary', ...summary }));
  return summary;
}
