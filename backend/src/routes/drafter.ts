import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import { getDraftReadiness } from '../services/draft-readiness.js';
import { stampCaseFraming } from '../services/case-framing-stamp.js';
import { caseViabilityEnabled, stampCaseViability } from '../services/case-viability-stamp.js';
import { publishDraftJobQueued } from '../services/draft-job-queue.js';
import { getDraftConcurrency, type DraftConcurrency } from '../services/draft-concurrency.js';
import {
  buildDrafterBundle,
  buildJobBundleS3Key,
  buildManualBundleS3Key,
  CaseNotFoundError,
  presignBundleUrl,
  VeteranNotFoundError,
  writeBundleToS3,
} from '../services/drafter-bundle.js';
import { isDrafterArtifactS3Key, buildLetterRevisionKey } from '../services/s3-key-safety.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RenderInvoker } from './letter.js';

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

// 'cancelled' (2026-06-05, drafter30): the worker posts a terminal /complete with
// operatorState:'cancelled' / failureClass:'cancelled' after an RN Cancel kills the pipeline child.
// Both columns are plain VarChar (no Prisma enum), so this needs no migration. Accepting the value
// (vs 400-rejecting it) lets the cancelled callback reach the discard guard cleanly.
const OPERATOR_STATES = ['ready', 'ready_with_notes', 'needs_one_thing', 'paused', 'cancelled'] as const;
type OperatorState = (typeof OPERATOR_STATES)[number];

const SHIP_RECOMMENDATIONS = ['ship', 'revise'] as const;
type ShipRecommendation = (typeof SHIP_RECOMMENDATIONS)[number];

const FAILURE_CLASSES = ['transient', 'degrade', 'needs_human', 'system', 'cancelled'] as const;
type FailureClass = (typeof FAILURE_CLASSES)[number];

const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'] as const;
type Grade = (typeof GRADES)[number];

interface ParsedRnDecision {
  gate2Override?: boolean;
  switchToCondition?: string;
  proceed?: boolean;
  reason?: string;
  rnUser?: string;
}

interface ParsedDraftCreate {
  strategyOverride?: string;
  parentVersion?: number;
  acknowledgeMissingDocs?: boolean;
  overrideReason?: string;
  rnDecision?: ParsedRnDecision;
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
  // Gate-2 resume: the RN's decision attached to a fresh draft job (the drafter skips the gate).
  const rnDecision = body['rnDecision'];
  if (rnDecision !== undefined && rnDecision !== null) {
    if (!isRecord(rnDecision)) badRequest('rnDecision must be an object', { field: 'rnDecision' });
    const rd = rnDecision as Record<string, unknown>;
    const override = rd['gate2Override'] === true;
    const proceed = rd['proceed'] === true;
    const switchTo = typeof rd['switchToCondition'] === 'string' && (rd['switchToCondition'] as string).trim().length > 0 ? (rd['switchToCondition'] as string).trim() : undefined;
    const chosen = [override, proceed, switchTo !== undefined].filter(Boolean).length;
    if (chosen !== 1) badRequest('rnDecision must carry exactly one of gate2Override / switchToCondition / proceed', { field: 'rnDecision' });
    const reason = typeof rd['reason'] === 'string' ? (rd['reason'] as string).trim() : '';
    // Override / switch require a typed reason (logged + shown in chart, spec §178).
    if ((override || switchTo !== undefined) && reason.length === 0) {
      badRequest('rnDecision.reason is required for an override or a condition switch', { field: 'rnDecision.reason' });
    }
    const rnUser = typeof rd['rnUser'] === 'string' ? (rd['rnUser'] as string).trim() : '';
    const parsed: ParsedRnDecision = {};
    if (override) parsed.gate2Override = true;
    if (proceed) parsed.proceed = true;
    if (switchTo !== undefined) parsed.switchToCondition = switchTo;
    if (reason.length > 0) parsed.reason = reason.slice(0, 2000);
    if (rnUser.length > 0) parsed.rnUser = rnUser;
    out.rnDecision = parsed;
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
      // SSOT stamp (no persist — a debug/ops GET never mutates the Case row).
      let stamped = await stampCaseFraming(db, caseId, bundle, { persist: false });
      // P4 anchor-viability stamp — SIBLING block in the same pass, DARK behind
      // EMR_CASE_VIABILITY_ENABLED (off ⇒ byte-identical legacy bundle, no caseViability key).
      if (caseViabilityEnabled()) {
        stamped = await stampCaseViability(db, caseId, stamped, { persist: false });
      }

      const s3Key = buildManualBundleS3Key(caseId);
      const upload = await writeBundleToS3(bucket, s3Key, stamped, 'manual');
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

      // Require BOTH reviewers assigned before a draft can run (Ryan 2026-06-09): a draft shouldn't spend
      // cloud $ until a physician AND an RN liaison own the case.
      if (!c.assignedPhysicianId || !c.assignedRnId) {
        const missing = [!c.assignedPhysicianId ? 'a physician' : null, !c.assignedRnId ? 'an RN liaison' : null].filter(Boolean).join(' and ');
        throw new HttpError(400, 'bad_request', `Assign ${missing} before drafting.`, { caseId, reason: 'assignment_required', assignedPhysicianId: c.assignedPhysicianId, assignedRnId: c.assignedRnId });
      }

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
      // OVERRIDABLE — never a dead-end (Ryan HARD RULE: EVERYTHING must be overridable). When some
      // files couldn't be auto-read, the RN may still proceed with a logged reason (the chart simply
      // drafts without those files). Names the blocking files + canOverride so the UI shows the
      // override button + what's blocking, never a blind "N files need review" with no recourse.
      // A Gate-2 RESUME (rnDecision present) is the RN's explicit "draft anyway" decision made at the halt
      // panel — it bypasses the missing-docs gate too, so a parked case is NEVER an unbypassable dead-end
      // (Ryan HARD RULE). 2026-06-08: "Draft anyway (override)" 409'd HERE because it didn't acknowledge
      // unread files, and the Gate-2 panel has no further override — a failure that cannot happen.
      if (!chartReadiness.ready && parsed.acknowledgeMissingDocs !== true && parsed.rnDecision === undefined) {
        throw new HttpError(409, 'conflict', `${chartReadiness.manualSummaryRequired} file(s) could not be automatically read. Add a manual summary, or override to draft without them.`, {
          caseId,
          manualSummaryRequired: chartReadiness.manualSummaryRequired,
          blockingFiles: chartReadiness.blockingFiles.map((b) => ({ filePath: b.filePath, terminalStatus: b.terminalStatus })),
          canOverride: true,
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
        if (parsed.acknowledgeMissingDocs !== true && parsed.rnDecision === undefined) {
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
      // Redraft must win: the new draft's version has to exceed not just the highest prior draft
      // job but also case.currentVersion, which an RN/physician hand-edit or surgical-AI edit may
      // have advanced past the draft-job numbering (LetterRevision rows share the currentVersion
      // pointer space). Without this, a redraft after an edit could land at a version that already
      // has a LetterRevision — and resolveCurrent() (LetterRevision-first) would then show the doctor
      // the STALE edit instead of the fresh redraft, or currentVersion could even regress.
      // (Ryan 2026-06-04: "the doc would just see the newest draft right?")
      const nextVersion = Math.max(maxVersionRow?.version ?? 0, c.currentVersion ?? 0) + 1;

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
      // SSOT stamp + only-when-null Case persist (the real draft path is a mutating POST).
      let stamped = await stampCaseFraming(db, caseId, bundle, { persist: true });
      // P4 anchor-viability stamp — SIBLING block in the same pass, DARK behind
      // EMR_CASE_VIABILITY_ENABLED (off ⇒ byte-identical legacy bundle, no caseViability key).
      if (caseViabilityEnabled()) {
        stamped = await stampCaseViability(db, caseId, stamped, { persist: true });
      }
      const bundleS3Key = buildJobBundleS3Key(caseId, jobId);
      const upload = await writeBundleToS3(bucket, bundleS3Key, stamped, 'job');
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
                ...(parsed.rnDecision !== undefined && { rnDecision: parsed.rnDecision }),
                ...(parsed.acknowledgeMissingDocs === true && { acknowledgeMissingDocs: true, overrideReason: parsed.overrideReason ?? null }),
              },
            },
          });
          // Mark the case 'drafting' the moment a job is enqueued (ANY path, not just a Gate-2 resume) so
          // the Cases list shows "Drafting", not the stale prior status — a draft takes ~20 min and the
          // team needs to see it's in progress (Ryan 2026-06-08: Hamilton-Dorsey was drafting but read
          // "Intake"). /progress keeps it 'drafting'; /complete sets rn_review.
          await tx.case.update({ where: { id: caseId }, data: { status: 'drafting' } });
          // Gate-2 resume: persist the RN's decision into the chart-visible decision log BEFORE
          // the job goes out (spec §183 — reason logged + shown in chart before re-enqueue).
          if (parsed.rnDecision !== undefined) {
            const rd = parsed.rnDecision;
            const decision = rd.switchToCondition !== undefined ? 'switch_accept' : rd.gate2Override ? 'override' : 'proceed';
            const item = rd.switchToCondition !== undefined ? 'nexus_switch' : 'dx_verification';
            await tx.draftDecision.create({
              data: {
                caseId,
                draftAttempt: nextVersion,
                gate: 2,
                item,
                decision,
                reason: rd.reason ?? (rd.switchToCondition !== undefined ? `switch to ${rd.switchToCondition}` : null),
                rnUser: rd.rnUser ?? actor.sub,
              },
            });
          }
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
        rnDecision: parsed.rnDecision ?? null,
      });

      // Queue-position indicator: fold a concurrency snapshot into the 201 so the click knows its
      // place in line IMMEDIATELY (cross-case only — a case can't queue behind itself; the in-flight
      // 409 above guarantees that). Computed from the DraftJob table only. Never block the enqueue on
      // this read — a concurrency-count hiccup must not fail a successfully-queued draft.
      let concurrency: DraftConcurrency | null = null;
      try {
        concurrency = await getDraftConcurrency(db.draftJob, created.enqueuedAt);
      } catch {
        concurrency = null;
      }
      res.status(201).json({ data: { job: created, publish: publishResult, bundle: { s3Key: bundleS3Key, sizeBytes: upload.sizeBytes }, concurrency } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/draft-concurrency  (admin / ops_staff / physician)
   *
   * Thin read for the queue-position poll: returns the live concurrency snapshot for this case's
   * newest in-flight (queued or running) DraftJob. The InFlightDrafterPanel refreshes this on the
   * SAME case poll the page already runs (no new poll loop) so a queued draft's "#N in line" stays
   * truthful until it flips to running. No in-flight job → concurrency is null (nothing to show).
   */
  router.get(
    '/cases/:id/draft-concurrency',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      // Newest in-flight job for this case (the one the panel is showing). version-desc so the most
      // recent attempt wins. Only queued/running jobs have a meaningful queue position.
      const job = await db.draftJob.findFirst({
        where: { caseId, state: { in: ['queued', 'running'] } },
        orderBy: { version: 'desc' },
        select: { id: true, state: true, enqueuedAt: true },
      });
      if (job === null) {
        res.json({ data: { concurrency: null } });
        return;
      }
      const concurrency = await getDraftConcurrency(db.draftJob, job.enqueuedAt);
      res.json({ data: { jobId: job.id, state: job.state, concurrency } });
    }),
  );

  /**
   * POST /api/v1/cases/:id/draft-jobs/:jobId/cancel  (admin / ops_staff)
   *
   * Cancel an in-flight draft so the RN doesn't burn a full ~$15 drafter run on a bad start. Marks
   * the DraftJob terminal ('failed', failureClass='system', reason "Cancelled by RN") — the drafter
   * wrapper's NEXT /progress heartbeat then gets a 409 (terminal-state guard) and aborts, stopping
   * the spend. The case drops out of "in flight" so the RN can re-send. Idempotent on an already-
   * terminal job.
   */
  router.post(
    '/cases/:id/draft-jobs/:jobId/cancel',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);
      const actor = currentActor(req);
      const job = await db.draftJob.findUnique({ where: { id: jobId } });
      if (job === null) throw new HttpError(404, 'not_found', 'DraftJob not found', { jobId });
      if (job.state === 'done' || job.state === 'failed' || job.state === 'halted') {
        res.json({ data: job, alreadyTerminal: true });
        return;
      }
      const updated = await db.$transaction(async (tx) => {
        const j = await tx.draftJob.update({
          where: { id: jobId },
          data: { state: 'failed', failureClass: 'system', completedAt: new Date(), errorMessage: 'Cancelled by RN' },
        });
        await tx.activityLog.create({ data: { actorUserId: actor.sub, caseId: job.caseId, action: 'draft_job_cancelled', detailsJson: { jobId, cancelledBy: actor.sub } } });
        return j;
      });
      res.json({ data: updated, cancelled: true });
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
      // Resolve the PDF key: prefer the stored artifactPdfS3Key, but FALL BACK to the canonical
      // drafter-artifacts path derived from the job version. The stored key can be null when the
      // stuck-job watcher flips a long (>~10min) run to 'failed' before /complete merges the keys,
      // yet the rendered PDF still exists in S3 at the deterministic path. Deriving from version
      // makes "View letter" work for the RN every time a run produced a letter, independent of the
      // nullable column. caseId is the validated job.caseId; the final key is re-validated below;
      // HeadObject confirms the object exists so a true early-fail (no PDF) returns a clean 404.
      // (2026-06-04 — Ryan: the letter must be viewable in the EMR every time, no manual pulls.)
      const artifactPrefix = (process.env['DRAFTER_ARTIFACTS_S3_PREFIX'] || 'drafter-artifacts/').replace(/^\/+/, '');
      const pdfKey =
        typeof job.artifactPdfS3Key === 'string' && job.artifactPdfS3Key.length > 0
          ? job.artifactPdfS3Key
          : `${artifactPrefix}${caseId}/v${job.version}/v${job.version}.pdf`;
      if (!isDrafterArtifactS3Key(pdfKey)) {
        throw new HttpError(500, 'internal_error', 'Resolved artifactPdfS3Key fails safety check', { caseId, jobId });
      }

      const s3 = getS3ForArtifacts();
      // Confirm the object exists before signing — a derived key for a job that never rendered
      // should 404 cleanly, not hand back a URL that resolves to S3 NoSuchKey XML.
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: pdfKey }));
      } catch {
        throw new HttpError(404, 'not_found', 'No letter PDF exists for this draft yet', { caseId, jobId });
      }
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: pdfKey }), {
        expiresIn: ARTIFACT_PDF_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + ARTIFACT_PDF_TTL_SECONDS * 1000).toISOString();

      res.json({ data: { url, expiresAt, ttlSeconds: ARTIFACT_PDF_TTL_SECONDS } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/draft-decisions  (admin / ops_staff / physician)
   * The chart-visible "Decisions & overrides" log — Gate-1 attestations, Gate-2 halt findings, and
   * RN resume decisions. Physician MUST see overrides (spec §108), so they're never log-only.
   */
  router.get(
    '/cases/:id/draft-decisions',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.draftDecision.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  /**
   * POST /api/v1/internal-free /cases/:id/draft-decisions  (admin / ops_staff)
   * Gate-1 "Before we draft" checklist attestations. Body: { draftAttempt, items: [{item, decision,
   * reason?}] }. decision in yes|no|not_applicable|override; reason required for override. Written
   * BEFORE the draft is enqueued so the attestation is on the chart even if the run later halts.
   */
  router.post(
    '/cases/:id/draft-decisions',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const actor = currentActor(req);
      if (!isRecord(req.body)) badRequest('Request body must be an object');
      const body = req.body as Record<string, unknown>;
      const draftAttempt = typeof body['draftAttempt'] === 'number' && Number.isInteger(body['draftAttempt']) ? (body['draftAttempt'] as number) : 1;
      const itemsRaw = body['items'];
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) badRequest('items must be a non-empty array', { field: 'items' });
      const ALLOWED = new Set(['yes', 'no', 'not_applicable', 'override']);
      const data = (itemsRaw as unknown[]).map((it) => {
        if (!isRecord(it)) { badRequest('each item must be an object', { field: 'items' }); }
        const r = it as Record<string, unknown>;
        const item = typeof r['item'] === 'string' ? (r['item'] as string).slice(0, 40) : '';
        const decision = typeof r['decision'] === 'string' ? (r['decision'] as string) : '';
        if (item.length === 0 || !ALLOWED.has(decision)) badRequest('each item needs item + a valid decision', { field: 'items' });
        const reason = typeof r['reason'] === 'string' ? (r['reason'] as string).trim() : '';
        if (decision === 'override' && reason.length === 0) badRequest(`item '${item}' is an override and needs a reason`, { field: 'items' });
        return { caseId, draftAttempt, gate: 1, item, decision, reason: reason.length > 0 ? reason.slice(0, 2000) : null, rnUser: actor.sub };
      });
      const result = await db.draftDecision.createMany({ data });
      res.status(201).json({ data: { written: result.count } });
    }),
  );

  return router;
}

const HALT_REASON_CODES = [
  'dx_not_found', 'event_not_found', 'dx_and_event_not_found',
  'verify_error', 'verify_parse_error', 'verify_unavailable', 'no_records_text',
] as const;

interface ParsedHalt {
  haltGate: string;
  reasonCode: string;
  plainEnglish: string;
  operatorMessage?: string;
  switchProposal?: unknown;
  claimedDxFound?: string;
  inServiceEventFound?: string;
  manifest?: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function parseHaltBody(body: unknown): ParsedHalt {
  if (!isRecord(body)) { badRequest('Request body must be an object'); }
  const b = body as Record<string, unknown>;
  const reasonCode = b['reasonCode'];
  if (typeof reasonCode !== 'string' || !(HALT_REASON_CODES as readonly string[]).includes(reasonCode)) {
    badRequest(`reasonCode must be one of: ${HALT_REASON_CODES.join(', ')}`, { field: 'reasonCode' });
  }
  const plainEnglish = b['plainEnglish'];
  if (typeof plainEnglish !== 'string' || plainEnglish.trim().length === 0) {
    badRequest('plainEnglish is required (the RN-facing reason)', { field: 'plainEnglish' });
  }
  const out: ParsedHalt = {
    haltGate: typeof b['haltGate'] === 'string' ? (b['haltGate'] as string) : 'dx_verification',
    reasonCode: reasonCode as string,
    plainEnglish: (plainEnglish as string).trim(),
    payload: b, // the full payload is stored for the RN UI to render (switchProposal, evidence, etc.)
  };
  if (typeof b['operatorMessage'] === 'string') out.operatorMessage = b['operatorMessage'] as string;
  if (b['switchProposal'] !== undefined && b['switchProposal'] !== null) out.switchProposal = b['switchProposal'];
  if (typeof b['claimedDxFound'] === 'string') out.claimedDxFound = b['claimedDxFound'] as string;
  if (typeof b['inServiceEventFound'] === 'string') out.inServiceEventFound = b['inServiceEventFound'] as string;
  if (isRecord(b['manifest'])) out.manifest = b['manifest'] as Record<string, unknown>;
  return out;
}

// Map a Gate-2 halt reasonCode to the draft_decisions item it concerns (for the chart panel).
function haltItem(reasonCode: string): string {
  if (reasonCode === 'event_not_found') return 'in_service_event';
  if (reasonCode === 'dx_not_found' || reasonCode === 'dx_and_event_not_found') return 'dx_present';
  return 'dx_verification';
}

/**
 * Worker-router deps. renderLetter + s3 + bucketName are injected so the /complete mirror can
 * BACKFILL a missing DOCX (#9 Fix 4): the FRN drafter's artifactDocxS3Key is optional, but a
 * LetterRevision must point at all three artifacts. When the docx is absent we read the TXT and
 * render the trio into the letter-revisions/v<N>/ keyspace, then mirror the rendered docx key.
 * All optional + injected so unit tests stub them (and so a render-less env still functions —
 * it just can't backfill, in which case the mirror falls back to the legacy null docx).
 */
export interface DrafterWorkerRouterDeps {
  renderLetter?: RenderInvoker;
  s3?: S3Client;
  bucketName?: string;
}

/**
 * Internal drafter worker routes. Auth via `requireDrafterPrincipal` (separate
 * DRAFTER_INVOKE_TOKEN, not the shared INTERNAL_WORKER_TOKEN). Server mounts these under
 * `/api/v1` with the drafter-principal middleware in front.
 */
export function createDrafterWorkerRouter(db: AppDb, deps: DrafterWorkerRouterDeps = {}): Router {
  const router = Router();

  // Backfill a missing DOCX for a completing drafter run so the mirrored LetterRevision can carry
  // all three non-null artifact keys (#9 Fix 4). Returns the docx key to persist:
  //   • parsed.artifactDocxS3Key when the worker already produced one (the common case), else
  //   • a freshly-rendered letter-revisions/<caseId>/v<N>/letter.docx key (TXT → render Lambda).
  // Renders the full trio (the Lambda always does) into the letter-revisions keyspace and returns
  // the docx key. Throws (502) when no docx exists AND we cannot render one — never persist a
  // revision that points at a missing artifact.
  async function resolveDocxKeyForMirror(args: {
    caseId: string;
    version: number;
    parentVersion: number;
    txtKey: string;
    docxKey: string | null | undefined;
  }): Promise<string> {
    if (typeof args.docxKey === 'string' && args.docxKey.trim() !== '') return args.docxKey;
    const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;
    if (deps.renderLetter === undefined || deps.s3 === undefined || bucketName === undefined) {
      throw new HttpError(502, 'internal_error', 'Drafter run produced no DOCX and DOCX backfill is not configured; refusing to mirror a letter revision with a missing artifact.', { reason: 'docx_backfill_unavailable', caseId: args.caseId, version: args.version });
    }
    // Read the TXT (the source of truth) and render the trio into the letter-revisions keyspace.
    const obj = await deps.s3.send(new GetObjectCommand({ Bucket: bucketName, Key: args.txtKey }));
    if (obj.Body === undefined) throw new HttpError(502, 'internal_error', 'Drafter TXT object had no body; cannot backfill DOCX.', { reason: 'txt_read_failed', caseId: args.caseId, key: args.txtKey });
    const letterText = await obj.Body.transformToString('utf-8');
    const c = await db.case.findFirst({ where: { id: args.caseId } });
    const veteran = c !== null ? await db.veteran.findUnique({ where: { id: c.veteranId } }) : null;
    const keys = {
      txtKey: buildLetterRevisionKey(args.caseId, args.version, 'txt'),
      pdfKey: buildLetterRevisionKey(args.caseId, args.version, 'pdf'),
      docxKey: buildLetterRevisionKey(args.caseId, args.version, 'docx'),
    };
    const caseData = {
      id: args.caseId,
      veteran_name: veteran !== null ? `${veteran.firstName} ${veteran.lastName}`.trim() : '',
      veteran_last: veteran?.lastName ?? '',
      claimed_condition: c?.claimedCondition ?? '',
    };
    const rendered = await deps.renderLetter({ caseData, letterText, version: args.version, draft: true, bucket: bucketName, keys });
    if (!rendered.ok) throw new HttpError(502, 'internal_error', 'DOCX backfill render failed; refusing to mirror a letter revision with a missing artifact.', { reason: 'docx_backfill_render_failed', caseId: args.caseId, version: args.version });
    return keys.docxKey;
  }

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
      // RN cancellation gets a DISTINCT, abort-able signal (200 + cancelRequested:true) rather than a
      // plain 409 — the drafter worker swallows 409 as idempotent redelivery and would NOT stop.
      // (Architect QA #1: the worker must check this flag and kill the child to actually stop spend —
      // that worker change is a separate drafter-window task.)
      if (existing.state === 'failed' && existing.errorMessage === 'Cancelled by RN') {
        res.status(200).json({ data: existing, cancelRequested: true });
        return;
      }
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
        // An RN cancellation must NOT resurrect a letter/grade onto the case via late-artifact
        // recovery — the run was explicitly abandoned. Discard the callback. (Architect QA #2.)
        // Key off BOTH signals so a cancel is caught even if one is absent (drafter30 contract,
        // confirmed 2026-06-05): (a) the row pre-stamped 'Cancelled by RN' by the cancel route when
        // the RN clicked Cancel, AND (b) the worker's own terminal payload, which sends
        // operatorState:'cancelled' / failureClass:'cancelled' after it kills the pipeline child.
        if (
          existing.errorMessage === 'Cancelled by RN' ||
          parsed.operatorState === 'cancelled' ||
          parsed.failureClass === 'cancelled'
        ) {
          throw new HttpError(409, 'conflict', 'DraftJob was cancelled by the RN — artifacts discarded.', { jobId, cancelled: true });
        }
        const incomingIsRealLetter =
          parsed.runComplete === true &&
          typeof parsed.artifactPdfS3Key === 'string' && parsed.artifactPdfS3Key.length > 0 &&
          typeof parsed.artifactTxtS3Key === 'string' && parsed.artifactTxtS3Key.length > 0;

        // RESURRECT (2026-06-06; race fix 2026-06-07): the stuck-job watcher FALSE-POSITIVE-reaped
        // this job (marked it 'failed'), but the worker actually finished a real letter and is now
        // posting it. Merging artifacts onto the 'failed' row alone is NOT enough — resolveCurrent()
        // reads Case.currentVersion, so the letter would stay unreachable (the RN sees "paused/failed"
        // while the letter sits in S3). Run the SAME case transition the happy path uses so the letter
        // SURFACES. KEEP IN SYNC with the happy-path completion below.
        //
        // 2026-06-07 reconcile fix (CLM-A355D7A822 / Hamilton-Dorsey): this MUST run BEFORE the
        // duplicate-artifacts 409 below. When the FIRST run's SIGTERM handler uploaded a PARTIAL
        // letter, the late-artifact-recovery branch already merged both artifact keys onto the swept
        // row AND overwrote errorMessage. So by the time the SQS-redelivered run posts the REAL
        // completed letter, (a) the row carries artifacts → the old hasArtifacts guard 409'd it first,
        // and (b) errorMessage no longer equals DRAFT_JOB_WATCHER_SWEPT_MESSAGE → wasWatcherSwept was
        // false. Both defeated resurrect, so the case stayed in 'drafting'/paused and OpsHeldPanel
        // never cleared despite a B+/ship v2 in S3. Fix: a 'failed' row (i.e. a swept/abandoned run
        // that never reached a REAL completion — happy-path completions are state='done') is eligible
        // to be SUPERSEDED by a genuine completed letter, regardless of partial artifacts or a
        // mutated errorMessage. state='done' rows are NOT eligible (true completed duplicate → 409
        // below). RN-cancelled jobs were already 409'd above.
        const eligibleForResurrect = existing.state === 'failed';
        if (eligibleForResurrect && incomingIsRealLetter) {
          // #9 Fix 4: guarantee a non-null DOCX for the mirrored LetterRevision (backfill if absent).
          const mirrorDocxKey = await resolveDocxKeyForMirror({
            caseId: existing.caseId,
            version: existing.version,
            parentVersion: existing.parentVersion ?? existing.version,
            txtKey: parsed.artifactTxtS3Key,
            docxKey: parsed.artifactDocxS3Key,
          });
          const resurrected = await db.$transaction(async (tx) => {
            const job = await tx.draftJob.update({
              where: { id: jobId },
              data: {
                state: 'done',
                artifactPdfS3Key: parsed.artifactPdfS3Key,
                artifactTxtS3Key: parsed.artifactTxtS3Key,
                artifactDocxS3Key: mirrorDocxKey,
                manifestSnapshot: parsed.manifest,
                gradeSidecarJson: parsed.gradeSidecar,
                ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
                failureClass: null,
                errorMessage: null,
                completedAt: now,
                lastHeartbeatAt: now,
              },
            });
            const caseUpdated = await tx.case.update({
              where: { id: existing.caseId },
              data: {
                probativeScore: parsed.probativeScore,
                grade: parsed.grade,
                shipRecommendation: parsed.shipRecommendation,
                operatorState: parsed.operatorState,
                operatorMessage: parsed.operatorMessage,
                runComplete: true,
                currentVersion: existing.version, // <-- the real fix: what resolveCurrent() reads
                status: 'rn_review',
                version: { increment: 1 },
              },
            });
            // Idempotent LetterRevision mirror (unique [caseId,version]) — same as the happy path.
            const existingRev = await tx.letterRevision.findFirst({ where: { caseId: existing.caseId, version: existing.version } });
            if (existingRev === null) {
              await tx.letterRevision.create({
                data: {
                  caseId: existing.caseId,
                  version: existing.version,
                  parentVersion: existing.parentVersion ?? existing.version,
                  source: 'drafter_run',
                  artifactTxtS3Key: parsed.artifactTxtS3Key,
                  artifactPdfS3Key: parsed.artifactPdfS3Key,
                  artifactDocxS3Key: mirrorDocxKey,
                  editedBy: SERVICE_ACTORS.DRAFTER,
                  editorRole: 'drafter',
                  sanityJson: null,
                },
              });
            }
            await tx.activityLog.create({
              data: {
                actorUserId: SERVICE_ACTORS.DRAFTER,
                caseId: existing.caseId,
                action: 'draft_job_resurrected',
                detailsJson: {
                  jobId,
                  version: existing.version,
                  note: 'Watcher-swept job posted a real completed letter; resurrected to rn_review and currentVersion advanced so the letter surfaces.',
                },
              },
            });
            return { job, case: caseUpdated };
          });
          res.json({ data: resurrected, resurrected: true });
          return;
        }

        // Duplicate-terminal-callback guard. Reached only when the incoming body is NOT a real
        // completed letter that supersedes a 'failed' row (that case resurrected above). If the row
        // already carries both artifact keys, this is a redundant callback (a true completed-run
        // duplicate, or a repeat partial SIGTERM POST) — there is nothing new to merge. Reject so we
        // don't re-write artifacts/operatorMessage on every retry. The late-artifact MERGE below is
        // for the first partial callback landing on a swept row whose keys are still NULL.
        const hasArtifacts =
          typeof existing.artifactPdfS3Key === 'string' &&
          existing.artifactPdfS3Key.length > 0 &&
          typeof existing.artifactTxtS3Key === 'string' &&
          existing.artifactTxtS3Key.length > 0;
        if (hasArtifacts) {
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

      // shipRecommendation is now ADVISORY — it no longer routes the case. A completed draft (ship
      // or not) lands in 'rn_review' so the RN reviews/edits and then explicitly sends it to the
      // doctor; failed runs stay in 'drafting' (held for retry). NEVER auto-route to the physician.
      // (Ryan 2026-06-04: "once a draft is complete it should not route to the doctor automatically
      // ... they ... click a button to send to doctor for review.") triageToPhysician is retained
      // only as an informational field in the activity log below (what the OLD rule would have done).
      const triageToPhysician = parsed.runComplete && parsed.shipRecommendation === 'ship';
      const nextCaseStatus = parsed.runComplete ? 'rn_review' : 'drafting';

      // #9 Fix 4: the mirrored LetterRevision must carry a non-null DOCX. The FRN drafter's docx
      // key is optional; when absent, backfill by rendering the TXT into the letter-revisions
      // keyspace BEFORE the transaction (the render does S3 PutObjects + a sync Lambda call).
      // artifactPdfS3Key/artifactTxtS3Key are required non-empty by parseCompleteBody, so only the
      // docx can be missing. Falls through to the existing docx key when the worker produced one.
      const mirrorDocxKey = await resolveDocxKeyForMirror({
        caseId: existing.caseId,
        version: existing.version,
        parentVersion: existing.parentVersion ?? existing.version,
        txtKey: parsed.artifactTxtS3Key,
        docxKey: parsed.artifactDocxS3Key,
      });

      const updated = await db.$transaction(async (tx) => {
        const job = await tx.draftJob.update({
          where: { id: jobId },
          data: {
            state: parsed.runComplete ? 'done' : 'failed',
            manifestSnapshot: parsed.manifest,
            gradeSidecarJson: parsed.gradeSidecar,
            artifactPdfS3Key: parsed.artifactPdfS3Key,
            artifactTxtS3Key: parsed.artifactTxtS3Key,
            artifactDocxS3Key: mirrorDocxKey,
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
              artifactPdfS3Key: parsed.artifactPdfS3Key,
              artifactDocxS3Key: mirrorDocxKey,
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

  /**
   * POST /api/v1/internal/drafter/jobs/:id/halt   (drafter-principal)
   *
   * Gate-2 pre-draft dx/event verification HALT. The drafter ran one bounded check over the
   * already-extracted chart and could not confirm the claimed diagnosis and/or in-service event
   * (fail-TO-halt — it NEVER drafts on a guess and spends zero drafting tokens). This parks the
   * case for an RN decision.
   *
   * CRITICAL: sets DraftJob.state='halted' so the stuck-job-watcher (state IN ('queued','running'))
   * can never resurrect the parked case. Stores the full payload (plain-English reason + optional
   * switchProposal) so the RN UI renders the real reason + choices — never a blind block.
   */
  router.post(
    '/internal/drafter/jobs/:id/halt',
    asyncHandler(async (req: Request, res: Response) => {
      const jobId = String(req.params.id);
      const parsed = parseHaltBody(req.body);

      const existing = await db.draftJob.findUnique({ where: { id: jobId } });
      if (existing === null) throw new HttpError(404, 'not_found', 'DraftJob not found', { jobId });
      // Idempotent: a redelivered halt on an already-halted job is a no-op 200 (a DLQ replay must
      // not double-park or double-bump the case version).
      if (existing.state === 'halted') { res.json({ data: existing, alreadyHalted: true }); return; }
      if (existing.state === 'done' || existing.state === 'failed') {
        throw new HttpError(409, 'conflict', `DraftJob is already in terminal state '${existing.state}'`, { jobId, state: existing.state });
      }

      const now = new Date();
      const message = parsed.operatorMessage ?? parsed.plainEnglish;
      const updated = await db.$transaction(async (tx) => {
        const job = await tx.draftJob.update({
          where: { id: jobId },
          data: {
            state: 'halted', // <-- watcher-immunity: falls outside state IN ('queued','running')
            failureClass: 'needs_human',
            completedAt: now,
            lastHeartbeatAt: now,
            errorMessage: parsed.plainEnglish.slice(0, 2000),
            haltPayloadJson: parsed.payload,
            ...(parsed.manifest !== undefined ? { manifestSnapshot: parsed.manifest } : {}),
          },
        });
        const caseUpdated = await tx.case.update({
          where: { id: existing.caseId },
          data: {
            status: parsed.reasonCode === 'no_records_text' ? 'needs_records' : 'needs_rn_decision',
            operatorState: 'paused',
            operatorMessage: message.slice(0, 2000),
            runComplete: false,
            version: { increment: 1 },
          },
        });
        // Record the gate-2 FINDING in the chart-visible decision log (so the panel shows WHY it
        // halted, not a blank block). The RN's response is logged separately on resume.
        await tx.draftDecision.create({
          data: {
            caseId: existing.caseId,
            draftAttempt: existing.version,
            gate: 2,
            item: haltItem(parsed.reasonCode),
            decision: parsed.reasonCode.startsWith('verify') || parsed.reasonCode === 'no_records_text' ? 'pause' : 'no',
            reason: parsed.plainEnglish.slice(0, 2000),
            rnUser: SERVICE_ACTORS.DRAFTER,
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.DRAFTER,
            caseId: existing.caseId,
            action: 'draft_job_halted_gate2',
            detailsJson: {
              jobId, version: existing.version, haltGate: parsed.haltGate, reasonCode: parsed.reasonCode,
              switchProposal: parsed.switchProposal ?? null,
            },
          },
        });
        return { job, case: caseUpdated };
      });

      res.json({ data: updated });
    }),
  );

  return router;
}
