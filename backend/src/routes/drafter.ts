import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import { getDraftReadiness } from '../services/draft-readiness.js';
import { publishDraftJobQueued } from '../services/draft-job-queue.js';
import {
  buildDrafterBundle,
  buildJobBundleS3Key,
  buildManualBundleS3Key,
  CaseNotFoundError,
  presignBundleUrl,
  VeteranNotFoundError,
  writeBundleToS3,
} from '../services/drafter-bundle.js';
import { isDrafterArtifactS3Key } from '../services/s3-key-safety.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let cachedS3Client: S3Client | null = null;
function getS3ForArtifacts(): S3Client {
  if (cachedS3Client !== null) return cachedS3Client;
  // forcePathStyle is needed for LocalStack (its virtual-host style isn't reachable from a
  // browser on localhost). Off by default; AWS_S3_FORCE_PATH_STYLE=true only in local dev.
  cachedS3Client = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' });
  return cachedS3Client;
}
const ARTIFACT_PDF_TTL_SECONDS = 5 * 60;
import type { AppDb } from '../services/db-types.js';

/**
 * Drafter integration routes.
 *
 *   GET  /api/v1/cases/:id/drafter-export             admin, ops_staff
 *   POST /api/v1/cases/:id/draft                      admin, ops_staff
 *   POST /api/v1/internal/drafter/jobs/:id/progress   drafter-principal (separate token)
 *   POST /api/v1/internal/drafter/jobs/:id/complete   drafter-principal (separate token)
 *
 * Contract surface mirrors the FRN drafter reliability spine exactly:
 *   - pipeline_manifest.json   (per-phase status; 15 named phases)
 *   - v<N>_qa_grade.json       (probative_score, grade, ship_recommendation, hints)
 *   - summarizeForOperator()   (terminal-state enum: ready / ready_with_notes / needs_one_thing / paused)
 *
 * Triage rule: a case routes to a physician inbox only when
 *   runComplete = true  AND  shipRecommendation = 'ship'.
 * An A- on an incomplete run stays in the ops queue. (Ryan's directive — completion gate
 * dominates grade gate.)
 */

const OPERATOR_STATES = ['ready', 'ready_with_notes', 'needs_one_thing', 'paused'] as const;
type OperatorState = (typeof OPERATOR_STATES)[number];

const SHIP_RECOMMENDATIONS = ['ship', 'revise'] as const;
type ShipRecommendation = (typeof SHIP_RECOMMENDATIONS)[number];

const FAILURE_CLASSES = ['transient', 'degrade', 'needs_human', 'system'] as const;
type FailureClass = (typeof FAILURE_CLASSES)[number];

const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'] as const;
type Grade = (typeof GRADES)[number];

interface ParsedDraftCreate {
  strategyOverride?: string;
  parentVersion?: number;
  acknowledgeMissingDocs?: boolean;
  overrideReason?: string;
}

function parseDraftCreateBody(body: unknown): ParsedDraftCreate {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) badRequest('Request body must be an object');
  const out: ParsedDraftCreate = {};
  // Essential-docs gate override: the RN may proceed past a missing-doc block with a logged
  // reason (Ryan 2026-06-03 — block + override, honors RN self-service).
  const ack = body['acknowledgeMissingDocs'];
  if (ack !== undefined && ack !== null) {
    if (typeof ack !== 'boolean') badRequest('acknowledgeMissingDocs must be a boolean', { field: 'acknowledgeMissingDocs' });
    out.acknowledgeMissingDocs = ack as boolean;
  }
  const reason = body['overrideReason'];
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string' || (reason as string).length > 2000) {
      badRequest('overrideReason must be a string under 2000 chars', { field: 'overrideReason' });
    }
    if ((reason as string).trim().length > 0) out.overrideReason = (reason as string).trim();
  }
  const strategyOverride = body['strategyOverride'];
  if (strategyOverride !== undefined && strategyOverride !== null) {
    if (typeof strategyOverride !== 'string') {
      badRequest('strategyOverride must be a string', { field: 'strategyOverride' });
    }
    if ((strategyOverride as string).length > 4000) {
      badRequest('strategyOverride exceeds 4000 chars', { field: 'strategyOverride', max: 4000 });
    }
    if ((strategyOverride as string).trim().length > 0) {
      out.strategyOverride = (strategyOverride as string).trim();
    }
  }
  const parentVersion = body['parentVersion'];
  if (parentVersion !== undefined && parentVersion !== null) {
    if (typeof parentVersion !== 'number' || !Number.isInteger(parentVersion) || parentVersion < 1) {
      badRequest('parentVersion must be a positive integer', { field: 'parentVersion' });
    }
    out.parentVersion = parentVersion as number;
  }
  return out;
}

interface ParsedProgress {
  manifest: Record<string, unknown>;
  currentPhase?: string;
  nextRetryInS?: number;
  failureClass?: FailureClass;
}

function parseProgressBody(body: unknown): ParsedProgress {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const manifest = body['manifest'];
  if (!isRecord(manifest)) {
    badRequest('manifest is required (object)', { field: 'manifest' });
  }
  const out: ParsedProgress = { manifest: manifest as Record<string, unknown> };
  const currentPhase = body['currentPhase'];
  if (currentPhase !== undefined && currentPhase !== null) {
    if (typeof currentPhase !== 'string' || (currentPhase as string).length === 0 || (currentPhase as string).length > 40) {
      badRequest('currentPhase must be a non-empty string under 40 chars', { field: 'currentPhase' });
    }
    out.currentPhase = currentPhase as string;
  }
  const nextRetryInS = body['nextRetryInS'];
  if (nextRetryInS !== undefined && nextRetryInS !== null) {
    if (typeof nextRetryInS !== 'number' || !Number.isInteger(nextRetryInS) || nextRetryInS < 0) {
      badRequest('nextRetryInS must be a non-negative integer', { field: 'nextRetryInS' });
    }
    out.nextRetryInS = nextRetryInS as number;
  }
  const failureClass = body['failureClass'];
  if (failureClass !== undefined && failureClass !== null) {
    if (typeof failureClass !== 'string' || !(FAILURE_CLASSES as readonly string[]).includes(failureClass)) {
      badRequest(`failureClass must be one of: ${FAILURE_CLASSES.join(', ')}`, { field: 'failureClass' });
    }
    out.failureClass = failureClass as FailureClass;
  }
  return out;
}

interface ParsedComplete {
  artifactPdfS3Key: string;
  artifactTxtS3Key: string;
  artifactDocxS3Key?: string;
  gradeSidecar: Record<string, unknown>;
  manifest: Record<string, unknown>;
  operatorState: OperatorState;
  operatorMessage: string;
  operatorDetailPhase?: string;
  runComplete: boolean;
  failureClass?: FailureClass;
  probativeScore: number;
  grade: Grade;
  shipRecommendation: ShipRecommendation;
  // Per-claim drafting cost in US dollars (e.g. 3.42; 0 when no metered LLM spend). Optional —
  // ignored if absent or invalid (not a finite number >= 0). Persisted to DraftJob.costUsd.
  costUsd?: number;
}

function parseCompleteBody(body: unknown): ParsedComplete {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const requireString = (key: string, max: number, optional = false): string | undefined => {
    const v = (body as Record<string, unknown>)[key];
    if (v === undefined || v === null) {
      if (optional) return undefined;
      badRequest(`${key} is required (string)`, { field: key });
    }
    if (typeof v !== 'string' || (v as string).length === 0 || (v as string).length > max) {
      badRequest(`${key} must be a non-empty string under ${max} chars`, { field: key, max });
    }
    return v as string;
  };
  const requireObject = (key: string): Record<string, unknown> => {
    const v = (body as Record<string, unknown>)[key];
    if (!isRecord(v)) badRequest(`${key} is required (object)`, { field: key });
    return v as Record<string, unknown>;
  };

  const artifactPdfS3Key = requireString('artifactPdfS3Key', 500) as string;
  const artifactTxtS3Key = requireString('artifactTxtS3Key', 500) as string;
  const artifactDocxS3Key = requireString('artifactDocxS3Key', 500, true);

  // Task #107a: path-traversal guard on the worker callback. Compromised drafter wrapper
  // could redirect artifact pointers to arbitrary S3 keys (cross-case read, exfil, etc.).
  // Validator rejects '..', leading '/', and anything outside the
  // drafter-artifacts/<caseId>/v<N>/<filename>.<ext> pattern.
  if (!isDrafterArtifactS3Key(artifactPdfS3Key)) {
    badRequest('artifactPdfS3Key does not match the safe drafter-artifacts/<caseId>/v<N>/*.pdf pattern', { field: 'artifactPdfS3Key' });
  }
  if (!isDrafterArtifactS3Key(artifactTxtS3Key)) {
    badRequest('artifactTxtS3Key does not match the safe drafter-artifacts/<caseId>/v<N>/*.txt pattern', { field: 'artifactTxtS3Key' });
  }
  if (artifactDocxS3Key !== undefined && !isDrafterArtifactS3Key(artifactDocxS3Key)) {
    badRequest('artifactDocxS3Key does not match the safe drafter-artifacts/<caseId>/v<N>/*.docx pattern', { field: 'artifactDocxS3Key' });
  }
  const gradeSidecar = requireObject('gradeSidecar');
  const manifest = requireObject('manifest');

  const operatorState = (body as Record<string, unknown>)['operatorState'];
  if (typeof operatorState !== 'string' || !(OPERATOR_STATES as readonly string[]).includes(operatorState)) {
    badRequest(`operatorState must be one of: ${OPERATOR_STATES.join(', ')}`, { field: 'operatorState' });
  }
  const operatorMessage = requireString('operatorMessage', 2000) as string;
  const operatorDetailPhase = requireString('operatorDetailPhase', 40, true);

  const runComplete = (body as Record<string, unknown>)['runComplete'];
  if (typeof runComplete !== 'boolean') {
    badRequest('runComplete must be a boolean', { field: 'runComplete' });
  }
  const failureClass = (body as Record<string, unknown>)['failureClass'];
  let failureClassParsed: FailureClass | undefined;
  if (failureClass !== undefined && failureClass !== null) {
    if (typeof failureClass !== 'string' || !(FAILURE_CLASSES as readonly string[]).includes(failureClass)) {
      badRequest(`failureClass must be one of: ${FAILURE_CLASSES.join(', ')}`, { field: 'failureClass' });
    }
    failureClassParsed = failureClass as FailureClass;
  }

  const probativeScore = gradeSidecar['probative_score'];
  if (typeof probativeScore !== 'number' || !Number.isInteger(probativeScore) || probativeScore < 1 || probativeScore > 10) {
    badRequest('gradeSidecar.probative_score must be an integer 1-10', { field: 'gradeSidecar.probative_score' });
  }
  const grade = gradeSidecar['grade'];
  if (typeof grade !== 'string' || !(GRADES as readonly string[]).includes(grade)) {
    badRequest(`gradeSidecar.grade must be one of: ${GRADES.join(', ')}`, { field: 'gradeSidecar.grade' });
  }
  const shipRecommendation = gradeSidecar['ship_recommendation'];
  if (typeof shipRecommendation !== 'string' || !(SHIP_RECOMMENDATIONS as readonly string[]).includes(shipRecommendation)) {
    badRequest(`gradeSidecar.ship_recommendation must be one of: ${SHIP_RECOMMENDATIONS.join(', ')}`, { field: 'gradeSidecar.ship_recommendation' });
  }

  // Per-claim drafting cost (US dollars). Optional + lenient: silently ignore anything that
  // isn't a finite non-negative number rather than rejecting the whole terminal callback over
  // a cost-telemetry field. The contract guarantees a JS number, but we never want a malformed
  // cost value to block persisting a completed legal letter.
  const costUsdRaw = (body as Record<string, unknown>)['costUsd'];
  let costUsdParsed: number | undefined;
  if (typeof costUsdRaw === 'number' && Number.isFinite(costUsdRaw) && costUsdRaw >= 0) {
    costUsdParsed = costUsdRaw;
  }

  const out: ParsedComplete = {
    artifactPdfS3Key,
    artifactTxtS3Key,
    gradeSidecar,
    manifest,
    operatorState: operatorState as OperatorState,
    operatorMessage,
    runComplete: runComplete as boolean,
    probativeScore: probativeScore as number,
    grade: grade as Grade,
    shipRecommendation: shipRecommendation as ShipRecommendation,
  };
  if (artifactDocxS3Key !== undefined) out.artifactDocxS3Key = artifactDocxS3Key;
  if (operatorDetailPhase !== undefined) out.operatorDetailPhase = operatorDetailPhase;
  if (failureClassParsed !== undefined) out.failureClass = failureClassParsed;
  if (costUsdParsed !== undefined) out.costUsd = costUsdParsed;
  return out;
}

/**
 * Client-facing drafter routes (Cognito-authenticated; mounted under requireRole guards).
 * Internal worker routes live in `createDrafterWorkerRouter` below — they use a separate
 * shared-secret token because they mutate the legal-letter artifact.
 */
export function createDrafterClientRouter(db: AppDb): Router {
  const router = Router();

  /**
   * GET /api/v1/cases/:id/drafter-export
   *
   * Architect QA F1: returns a presigned S3 URL for the materialization bundle (NOT the
   * inline JSON). The drafter wrapper running on Fargate fetches the bundle straight from
   * S3 using its phiBucket read grant — bypassing API Gateway / Lambda payload limits
   * (~6-10 MB hard cap) that the inline JSON would exceed on 100+ doc cases.
   *
   * This endpoint is primarily for human ops/debug. The drafter wrapper itself doesn't
   * need to call it — the bundleS3Key is in the SQS message body it consumes.
   *
   * On each call: builds a fresh bundle, writes to s3://<phi-bucket>/drafter-exports/
   * <caseId>/manual-<timestamp>.json, returns a 15-min presigned GET URL. Manual bundles
   * accumulate; rely on an S3 lifecycle policy on drafter-exports/ for cleanup (followup).
   */
  router.get(
    '/cases/:id/drafter-export',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);

      const bucket = process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      }

      const bundle = await buildDrafterBundle(db, caseId).catch((err: unknown) => {
        if (err instanceof CaseNotFoundError) {
          throw new HttpError(404, 'not_found', 'Case not found', { caseId: err.caseId });
        }
        if (err instanceof VeteranNotFoundError) {
          throw new HttpError(404, 'not_found', 'Veteran not found', { veteranId: err.veteranId });
        }
        throw err;
      });

      const s3Key = buildManualBundleS3Key(caseId);
      const upload = await writeBundleToS3(bucket, s3Key, bundle, 'manual');
      const presigned = await presignBundleUrl(bucket, s3Key);

      res.json({
        data: {
          bundleS3Key: upload.s3Key,
          bundleSizeBytes: upload.sizeBytes,
          presignedUrl: presigned.url,
          expiresAt: presigned.expiresAt,
          ttlSeconds: presigned.ttlSeconds,
        },
      });
    }),
  );

  /**
   * POST /api/v1/cases/:id/draft
   *
   * Ops-staff trigger to send the case to the drafter. Creates a DraftJob row (state=queued)
   * and publishes to the DraftJobQueue. Optional body:
   *   { strategyOverride?: string, parentVersion?: number }
   *
   * strategyOverride is the RN-redraft-with-strategy free-text field — physician marks the
   * letter "send back for major rework", RN types the strategy change, this endpoint queues
   * a new version that the drafter wrapper will inject into framing-gate input.
   *
   * Gated on:
   *   - chart-readiness GREEN
   *   - no in-flight DraftJob (state in {queued, running}) — would 409 if attempted twice
   *
   * Versioning: new DraftJob.version = max(existing versions) + 1.
   */
  // Pre-draft essential-docs readiness, for the RN popup. Same deterministic check the POST /draft
  // gate enforces — so the popup shows exactly what would block (or be overridden).
  router.get(
    '/cases/:id/draft-readiness',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const readiness = await getDraftReadiness(db, caseId);
      if (readiness === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      res.json({ data: readiness });
    }),
  );

  router.post(
    '/cases/:id/draft',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const parsed = parseDraftCreateBody(req.body);
      const actor = currentActor(req);

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const inFlight = await db.draftJob.findFirst({
        where: { caseId, state: { in: ['queued', 'running'] as const } },
      });
      if (inFlight !== null) {
        throw new HttpError(409, 'conflict', 'A draft job is already in flight for this case.', {
          caseId,
          inFlightJobId: inFlight.id,
          state: inFlight.state,
        });
      }

      const fileRows = await db.fileReadStatus.findMany({ where: { caseId } });
      const chartReadiness = evaluateChartReadiness(fileRows);
      if (!chartReadiness.ready) {
        throw new HttpError(409, 'conflict', 'Chart is not ready — manual summary required on at least one file.', {
          caseId,
          manualSummaryRequired: chartReadiness.manualSummaryRequired,
        });
      }

      // Essential-docs gate (no silent deaths, Ryan 2026-06-03): catch a missing essential
      // document BEFORE any draft spend, with a plain RN-actionable message. The RN can override
      // with a logged reason (block + override). The drafter's own chartCompleteness gate remains
      // the backstop; this surfaces the same condition synchronously so it can never be a silent
      // async death or a cryptic code.
      //
      // FLAG-GUARDED (default OFF): the blocking behavior activates only when DRAFT_READINESS_GATE
      // ='on'. Until the EMR override popup ships, leaving it off preserves today's /draft behavior
      // exactly, so a false-flag can't trap an RN with no override button. The GET
      // /cases/:id/draft-readiness route is always live (read-only) so the UI can build against it.
      const gateOn = process.env.DRAFT_READINESS_GATE === 'on';
      const readiness = gateOn ? await getDraftReadiness(db, caseId) : null;
      if (readiness !== null && !readiness.ready) {
        // Distinguish "the chart is still being built from the records" (a wait, not a fault) from
        // a genuine missing essential. Both block, both overridable (never a dead-end).
        const stillBuilding = readiness.buildState === 'ocr_in_progress' || readiness.buildState === 'extracting';
        if (parsed.acknowledgeMissingDocs !== true) {
          throw new HttpError(
            409,
            stillBuilding ? 'chart_not_ready' : 'essential_docs_missing',
            readiness.summary,
            {
              caseId,
              buildState: readiness.buildState,
              missing: readiness.missing.map((m) => ({ key: m.key, label: m.label, message: m.message })),
              items: readiness.items.map((i) => ({ key: i.key, label: i.label, present: i.present, message: i.message })),
              canOverride: true,
            },
          );
        }
        await db.activityLog.create({
          data: {
            actorUserId: actor.sub,
            caseId,
            action: 'draft_readiness_overridden',
            detailsJson: {
              missing: readiness.missing.map((m) => m.key),
              reason: parsed.overrideReason ?? null,
            },
          },
        });
      }

      const maxVersionRow = await db.draftJob.findFirst({
        where: { caseId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (maxVersionRow?.version ?? 0) + 1;

      const jobId = randomUUID();

      // Architect QA F1: write the materialization bundle to S3 BEFORE creating the
      // DraftJob row + enqueueing. If S3 write fails we abort cleanly without leaving a
      // queued row that has no bundle. The wrapper reads from bundleS3Key via its
      // Fargate task role's phiBucket read grant — never via API GET.
      const bucket = process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      }
      const bundle = await buildDrafterBundle(db, caseId).catch((err: unknown) => {
        if (err instanceof CaseNotFoundError) {
          throw new HttpError(404, 'not_found', 'Case not found', { caseId: err.caseId });
        }
        if (err instanceof VeteranNotFoundError) {
          throw new HttpError(404, 'not_found', 'Veteran not found', { veteranId: err.veteranId });
        }
        throw err;
      });
      const bundleS3Key = buildJobBundleS3Key(caseId, jobId);
      const upload = await writeBundleToS3(bucket, bundleS3Key, bundle, 'job');
      // F1c bundle-size CloudWatch signal (Ryan 2026-05-26): structured log per /draft so
      // ops can track when bundles approach the soft cap. Independent of the warn-line
      // which only fires above threshold.
      console.log(JSON.stringify({
        msg: 'drafter-bundle: job export uploaded',
        caseId,
        jobId,
        bundleS3Key,
        sizeBytes: upload.sizeBytes,
        warnedLargeBundle: upload.warnedLargeBundle,
      }));

      let created;
      try {
        created = await db.$transaction(async (tx) => {
          const job = await tx.draftJob.create({
            data: {
              id: jobId,
              caseId,
              version: nextVersion,
              state: 'queued',
              bundleS3Key,
              ...(parsed.strategyOverride !== undefined ? { strategyOverride: parsed.strategyOverride } : {}),
              ...(parsed.parentVersion !== undefined ? { parentVersion: parsed.parentVersion } : {}),
            },
          });
          await tx.activityLog.create({
            data: {
              actorUserId: actor.sub,
              caseId,
              action: 'draft_job_queued',
              detailsJson: {
                jobId,
                version: nextVersion,
                bundleS3Key,
                bundleSizeBytes: upload.sizeBytes,
                ...(parsed.strategyOverride !== undefined && { strategyOverride: parsed.strategyOverride }),
                ...(parsed.parentVersion !== undefined && { parentVersion: parsed.parentVersion }),
              },
            },
          });
          return job;
        });
      } catch (err) {
        // Architect QA F3: the partial unique index draft_jobs_case_id_in_flight_uq closes
        // the race between the pre-flight in-flight check and this insert. Prisma surfaces
        // a P2002 unique-constraint violation when a concurrent request beats us to the row.
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
          // The bundle we just uploaded is orphaned (no DraftJob references it). Acceptable —
          // S3 lifecycle policy on drafter-exports/ will reap it; concurrent /draft is rare.
          throw new HttpError(409, 'conflict', 'Another draft job for this case was queued concurrently.', { caseId });
        }
        throw err;
      }

      const publishResult = await publishDraftJobQueued({
        jobId,
        caseId,
        version: nextVersion,
        bundleS3Key,
        strategyOverride: parsed.strategyOverride ?? null,
        parentVersion: parsed.parentVersion ?? null,
      });

      res.status(201).json({ data: { job: created, publish: publishResult, bundle: { s3Key: bundleS3Key, sizeBytes: upload.sizeBytes } } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/draft-jobs/:jobId/artifact-pdf-url
   *
   * Returns a 5-min presigned GET URL for the DraftJob's artifactPdfS3Key. Used by the
   * Phase 8 physician "Open PDF" button (PhysicianLetterReadyPanel.onOpenPdf callback).
   *
   * Access: admin / ops_staff / the assigned physician for this case.
   * Validates: the DraftJob exists, belongs to the URL case, has artifactPdfS3Key set,
   * and the key passes our drafter-artifacts path-traversal validator (server-side belt
   * before generating a signed URL).
   */
  router.get(
    '/cases/:id/draft-jobs/:jobId/artifact-pdf-url',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const jobId = String(req.params.jobId);

      const bucket = process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      }

      const job = await db.draftJob.findUnique({ where: { id: jobId } });
      if (job === null || job.caseId !== caseId) {
        throw new HttpError(404, 'not_found', 'DraftJob not found for this case', { caseId, jobId });
      }
      if (job.artifactPdfS3Key === null || job.artifactPdfS3Key === '') {
        throw new HttpError(409, 'conflict', 'DraftJob has no PDF artifact yet', { caseId, jobId });
      }
      // Defensive: re-validate the stored key matches the safe pattern. The /complete
      // route already validated on write, but a corrupted row shouldn't be used to sign
      // an arbitrary URL.
      if (!isDrafterArtifactS3Key(job.artifactPdfS3Key)) {
        throw new HttpError(500, 'internal_error', 'Stored artifactPdfS3Key fails safety check', { caseId, jobId });
      }

      const s3 = getS3ForArtifacts();
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: job.artifactPdfS3Key }), {
        expiresIn: ARTIFACT_PDF_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + ARTIFACT_PDF_TTL_SECONDS * 1000).toISOString();

      res.json({ data: { url, expiresAt, ttlSeconds: ARTIFACT_PDF_TTL_SECONDS } });
    }),
  );

  return router;
}

/**
 * Internal drafter worker routes. Auth via `requireDrafterPrincipal` (separate
 * DRAFTER_INVOKE_TOKEN, not the shared INTERNAL_WORKER_TOKEN). Server mounts these under
 * `/api/v1` with the drafter-principal middleware in front.
 */
export function createDrafterWorkerRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/internal/drafter/jobs/:id/progress
   *
   * Drafter wrapper posts on every phase transition. Body:
   *   { manifest: <pipeline_manifest.json>, currentPhase?, nextRetryInS?, failureClass? }
   *
   * Updates DraftJob.{manifestSnapshot, currentPhase, nextRetryInS, failureClass,
   * lastHeartbeatAt}. Also flips state queued -> running on first progress call.
   */
  router.post(
    '/internal/drafter/jobs/:id/progress',
    asyncHandler(async (req: Request, res: Response) => {
      const jobId = String(req.params.id);
      const parsed = parseProgressBody(req.body);

      const existing = await db.draftJob.findUnique({ where: { id: jobId } });
      if (existing === null) throw new HttpError(404, 'not_found', 'DraftJob not found', { jobId });
      if (existing.state === 'done' || existing.state === 'failed') {
        throw new HttpError(409, 'conflict', `DraftJob is already in terminal state '${existing.state}'`, {
          jobId,
          state: existing.state,
        });
      }

      const now = new Date();
      const updated = await db.draftJob.update({
        where: { id: jobId },
        data: {
          state: existing.state === 'queued' ? 'running' : existing.state,
          manifestSnapshot: parsed.manifest,
          ...(parsed.currentPhase !== undefined ? { currentPhase: parsed.currentPhase } : {}),
          ...(parsed.nextRetryInS !== undefined ? { nextRetryInS: parsed.nextRetryInS } : {}),
          ...(parsed.failureClass !== undefined ? { failureClass: parsed.failureClass } : {}),
          lastHeartbeatAt: now,
          ...(existing.state === 'queued' && existing.startedAt === null ? { startedAt: now } : {}),
        },
      });

      res.json({ data: updated });
    }),
  );

  /**
   * POST /api/v1/internal/drafter/jobs/:id/complete
   *
   * Drafter wrapper posts at terminal. Body includes the full v<N>_qa_grade.json, the final
   * manifest, the summarizeForOperator() result, the assertRunComplete() result, and S3 keys
   * for the produced artifacts (PDF + TXT + optional DOCX).
   *
   * This is the ONLY path that mirrors fields to the parent Case row (probativeScore, grade,
   * shipRecommendation, operatorState, runComplete) — i.e. the physician-routing surface.
   *
   * Triage: status flip to physician_review happens here too, but ONLY if
   * (runComplete && shipRecommendation === 'ship'). Otherwise status moves to drafting
   * (= ops queue) so an RN can decide whether to redraft or surface a clarification.
   */
  router.post(
    '/internal/drafter/jobs/:id/complete',
    asyncHandler(async (req: Request, res: Response) => {
      const jobId = String(req.params.id);
      const parsed = parseCompleteBody(req.body);

      const existing = await db.draftJob.findUnique({ where: { id: jobId } });
      if (existing === null) throw new HttpError(404, 'not_found', 'DraftJob not found', { jobId });

      const now = new Date();

      // Late-artifact recovery. The stuck-job watcher flips a stale job to 'failed' at the
      // ~10-min mark BEFORE the worker's SIGTERM handler POSTs /complete with the real S3
      // artifact keys it just uploaded. Without this branch the terminal-state guard 409-rejects
      // that body and the keys never land — artifactPdfS3Key stays null and the RN's "Open as-is"
      // / Open PDF affordance is dead even though v<N>.{txt,pdf,docx} exist in S3. Here we MERGE
      // the incoming artifact keys onto the already-terminal row (state stays as-is). We do NOT
      // bump case.version / currentVersion / status — the watcher already settled those; this is
      // a pure artifact-attachment, not a second terminal transition.
      if (existing.state === 'done' || existing.state === 'failed') {
        const hasArtifacts =
          typeof existing.artifactPdfS3Key === 'string' &&
          existing.artifactPdfS3Key.length > 0 &&
          typeof existing.artifactTxtS3Key === 'string' &&
          existing.artifactTxtS3Key.length > 0;
        if (hasArtifacts) {
          // Genuine duplicate terminal callback — the row already carries artifacts. Reject.
          throw new HttpError(409, 'conflict', `DraftJob is already in terminal state '${existing.state}'`, {
            jobId,
            state: existing.state,
          });
        }

        const recovered = await db.$transaction(async (tx) => {
          const job = await tx.draftJob.update({
            where: { id: jobId },
            data: {
              artifactPdfS3Key: parsed.artifactPdfS3Key,
              artifactTxtS3Key: parsed.artifactTxtS3Key,
              ...(parsed.artifactDocxS3Key !== undefined ? { artifactDocxS3Key: parsed.artifactDocxS3Key } : {}),
              manifestSnapshot: parsed.manifest,
              gradeSidecarJson: parsed.gradeSidecar,
              lastHeartbeatAt: now,
              errorMessage: parsed.operatorMessage.slice(0, 2000),
            },
          });
          const caseUpdated = await tx.case.update({
            where: { id: existing.caseId },
            data: { operatorMessage: parsed.operatorMessage },
          });
          await tx.activityLog.create({
            data: {
              actorUserId: SERVICE_ACTORS.DRAFTER,
              caseId: existing.caseId,
              action: 'draft_job_artifacts_recovered',
              detailsJson: {
                jobId,
                version: existing.version,
                state: existing.state,
                artifactPdfS3Key: parsed.artifactPdfS3Key,
                artifactTxtS3Key: parsed.artifactTxtS3Key,
                note: 'Late SIGTERM artifact callback merged onto a watcher-swept terminal job; case version/currentVersion/status left untouched.',
              },
            },
          });
          return { job, case: caseUpdated };
        });

        res.json({ data: recovered, recovered: true });
        return;
      }

      const triageToPhysician = parsed.runComplete && parsed.shipRecommendation === 'ship';
      const nextCaseStatus = triageToPhysician ? 'physician_review' : 'drafting';

      const updated = await db.$transaction(async (tx) => {
        const job = await tx.draftJob.update({
          where: { id: jobId },
          data: {
            state: parsed.runComplete ? 'done' : 'failed',
            manifestSnapshot: parsed.manifest,
            gradeSidecarJson: parsed.gradeSidecar,
            artifactPdfS3Key: parsed.artifactPdfS3Key,
            artifactTxtS3Key: parsed.artifactTxtS3Key,
            ...(parsed.artifactDocxS3Key !== undefined ? { artifactDocxS3Key: parsed.artifactDocxS3Key } : {}),
            ...(parsed.failureClass !== undefined ? { failureClass: parsed.failureClass } : {}),
            // Prisma Decimal accepts a number or string — pass the validated number through.
            ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
            completedAt: now,
            lastHeartbeatAt: now,
            ...(parsed.runComplete ? {} : { errorMessage: parsed.operatorMessage.slice(0, 2000) }),
          },
        });

        const caseUpdated = await tx.case.update({
          where: { id: existing.caseId },
          data: {
            probativeScore: parsed.probativeScore,
            grade: parsed.grade,
            shipRecommendation: parsed.shipRecommendation,
            operatorState: parsed.operatorState,
            // G8: previously parsed but discarded; now wired so the RN/physician UI can render
            // summarizeForOperator()'s message verbatim without rebuilding from state.
            operatorMessage: parsed.operatorMessage,
            runComplete: parsed.runComplete,
            // F4 semantics (Ryan, 2026-05-26): currentVersion = last *attempted* version,
            // advances on ANY terminal /complete call — ship or fail. The "current" pointer
            // is "what's the newest artifact set we produced" (regardless of whether it was
            // shippable). The physician-routing gate is enforced separately via
            // (runComplete && shipRecommendation==='ship') at write time + read time, NOT
            // via currentVersion. Failed runs still bump currentVersion so the operator UI
            // can show "v3 failed; you can retry as v4" rather than mysteriously still
            // showing v2.
            currentVersion: existing.version,
            status: nextCaseStatus,
            version: { increment: 1 },
          },
        });

        await tx.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.DRAFTER,
            caseId: existing.caseId,
            action: 'draft_job_completed',
            detailsJson: {
              jobId,
              version: existing.version,
              probativeScore: parsed.probativeScore,
              grade: parsed.grade,
              shipRecommendation: parsed.shipRecommendation,
              operatorState: parsed.operatorState,
              runComplete: parsed.runComplete,
              triageToPhysician,
              nextCaseStatus,
            },
          },
        });

        // Unified letter timeline (LETTER_EDITOR_BACKEND_PLAN.md): mirror this completed
        // drafter version into LetterRevision so the in-EMR editor resolves the current
        // letter from ONE table by Case.currentVersion (no DraftJob fallback). Idempotent
        // find-then-create — re-delivery / late SIGTERM callbacks must not duplicate (the
        // row carries @@unique([caseId,version])).
        const existingRev = await tx.letterRevision.findFirst({ where: { caseId: existing.caseId, version: existing.version } });
        if (existingRev === null) {
          await tx.letterRevision.create({
            data: {
              caseId: existing.caseId,
              version: existing.version,
              parentVersion: existing.parentVersion ?? existing.version,
              source: 'drafter_run',
              artifactTxtS3Key: parsed.artifactTxtS3Key,
              artifactPdfS3Key: parsed.artifactPdfS3Key ?? null,
              artifactDocxS3Key: parsed.artifactDocxS3Key ?? null,
              editedBy: SERVICE_ACTORS.DRAFTER,
              editorRole: 'drafter',
              sanityJson: null,
            },
          });
        }

        return { job, case: caseUpdated };
      });

      res.json({ data: updated });
    }),
  );

  return router;
}
