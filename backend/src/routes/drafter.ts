import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { loadReconciledChartReadiness } from '../services/chart-readiness.js';
import { autoRemediateChartForDraft } from '../services/chart-auto-remediate.js';
import { getDraftReadiness } from '../services/draft-readiness.js';
import { resolveGroundedFraming } from '../services/grounded-framing.js';
import { stampCaseFraming } from '../services/case-framing-stamp.js';
import { caseViabilityEnabled, stampCaseViability } from '../services/case-viability-stamp.js';
import { stampAiViabilityPlan } from '../services/ai-viability-plan-stamp.js';
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
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RenderInvoker, EnrichVerifier } from './letter.js';
// Reuse the editor-save regrade mechanism (Ryan 2026-07-08): the SAME fast Sonnet probative grader
// (gradeLetterText) and the SAME best-effort, txn-decoupled persist (persistLetterGrade) that a letter
// EDITOR-SAVE runs, so a pushed revised letter shows a Grade like a drafter letter. No new grader.
import { persistLetterGrade } from './letter.js';
import { gradeLetterText, type LetterRegrade } from '../services/letter-grade.js';
import { cleanProseForSave, sanityCheckLetterText, type SanityFinding } from '../services/letter-sanity.js';
import { extractCitationTokenMap } from '../services/letter-citation-integrity.js';
import { isValidCaseStatusTransition } from '../services/case-status-transitions.js';
import { STALE_THRESHOLD_MS } from '../services/draft-job-constants.js';

let cachedS3Client: S3Client | null = null;
function getS3ForArtifacts(): S3Client {
  if (cachedS3Client !== null) return cachedS3Client;
  // forcePathStyle is needed for LocalStack (its virtual-host style isn't reachable from a
  // browser on localhost). Off by default; AWS_S3_FORCE_PATH_STYLE=true only in local dev.
  cachedS3Client = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' });
  return cachedS3Client;
}
const ARTIFACT_PDF_TTL_SECONDS = 5 * 60;
// Import final letter (2026-06-14): TTL for the presigned PUT of a finished letter PDF.
const IMPORT_UPLOAD_TTL_SECONDS = 5 * 60;
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
      // Persisted route-picker PLAN stamp (Ryan 2026-06-25, "honor the SOAP theory on redraft") — read-only
      // by nature (the plan was already persisted by ai-viability.ts). Fail-open: no ready plan ⇒ unstamped.
      stamped = await stampAiViabilityPlan(db, caseId, stamped);

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
  // DEPRECATED-AS-A-GATE 2026-06-29 (Dr. Kasky): the deterministic essential-docs ✓/⚠ evaluation no
  // longer drives any UI caution or the POST /draft gate (both retired — the Gate-1 modal is now a pure
  // human attestation). This route is RETAINED only because DecisionsOverridesPanel reads the SSOT
  // caseFraming provenance off it; the items/missing/ready it still returns are unconsumed by the UI.
  router.get(
    '/cases/:id/draft-readiness',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const readiness = await getDraftReadiness(db, caseId);
      if (readiness === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // "ANKLE nowhere" (Ryan 2026-07-11): the DecisionsOverridesPanel reads caseFraming.upstreamScCondition
      // off this (retired-gate) route — ground its ANCHOR for display so a stale value never shows. Feed the
      // resolver the DERIVED/SSOT caseFraming values (already drops unrecognized anchors) with only the RAW
      // framingStampSource as provenance — mirroring halt-explanation — so grounding never DOWNGRADES a
      // cleaned SSOT anchor back to the raw column (architect QA). This route gates nothing; display-only.
      if (readiness.caseFraming) {
        const raw = (await db.case.findFirst({ where: { id: caseId }, select: { framingStampSource: true } })) as { framingStampSource?: string | null } | null;
        const g = await resolveGroundedFraming(db, caseId, {
          framingStampSource: raw?.framingStampSource ?? null,
          framingChoice: readiness.caseFraming.framingChoice ?? null,
          upstreamScCondition: readiness.caseFraming.upstreamScCondition ?? null,
        });
        readiness.caseFraming = { ...readiness.caseFraming, upstreamScCondition: g.upstream };
      }
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

      // ── G1 REDRAFT LOCK (ratified sign/edit lifecycle, Ryan 2026-06-12: "lock redraft after
      // sent to doctor. if doc sends back to RN that reopens.") ── Once the RN sends the case to
      // the doctor (physician_review), ops_staff can no longer redraft. Same 409 envelope shape
      // as the letter editor's RN lock (PUT /letter + surgical-ai) so the UI handles both
      // identically. The doctor's "Send back to RN" (correction_requested → correction_review)
      // reopens; correction_review / drafting / rn_review stay redraftable. Admin is unaffected.
      // REVERSES the deliberate 2026-06-04 "re-run a physician_review letter" affordance — see
      // CaseDetailPage canRedraft, updated in the same change.
      if (actor.role === 'ops_staff' && c.status === 'physician_review') {
        throw new HttpError(409, 'conflict', 'Redraft is locked while the case is in physician review. It reopens if the doctor sends the case back to the RN.', { reason: 'locked_physician_review', caseId, status: c.status });
      }

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

      // RECONCILED readiness (CLM-4DACAF4A80, 2026-06-14): drop orphaned rows (a deleted file's
      // readiness row no longer in this case's documents) so an invisible orphan can't force the RN
      // through the override path for a chart that has nothing unread. Same shared loader as the gates.
      const chartReadiness = await loadReconciledChartReadiness(db, caseId);
      // OVERRIDABLE — never a dead-end (Ryan HARD RULE: EVERYTHING must be overridable). When some
      // files couldn't be auto-read, the RN may still proceed with a logged reason (the chart simply
      // drafts without those files). Names the blocking files + canOverride so the UI shows the
      // override button + what's blocking, never a blind "N files need review" with no recourse.
      // A Gate-2 RESUME (rnDecision present) is the RN's explicit "draft anyway" decision made at the halt
      // panel — it bypasses the missing-docs gate too, so a parked case is NEVER an unbypassable dead-end
      // (Ryan HARD RULE). 2026-06-08: "Draft anyway (override)" 409'd HERE because it didn't acknowledge
      // unread files, and the Gate-2 panel has no further override — a failure that cannot happen.
      if (!chartReadiness.ready && parsed.acknowledgeMissingDocs !== true && parsed.rnDecision === undefined) {
        // AUTO-RECOVERY (document auto-recovery loop, 2026-06-14): instead of dead-ending to a 409, try
        // to HEAL the chart automatically so the RN can click once and walk away. autoRemediateChartForDraft
        // is bounded — it re-fires the reprocess primitive AT MOST ONCE per doc-set (a `case_auto_remediated`
        // marker + the in-flight build-state guard prevent a re-fire loop on the frontend's 8s poll). It
        // reuses the existing extractionState='extracting' + that poll as the "held, auto-resuming" model
        // (no new case state). Only when auto-recovery is EXHAUSTED (it already ran for this exact doc-set
        // and the files are still blocked) do we fall through to the overridable 409 + the persistent
        // last-resort banner. Logged via `case_auto_remediated`.
        const remediation = await autoRemediateChartForDraft(db, caseId, actor.sub);
        if (remediation.state === 'preparing') {
          // 202-style: a remediation is running. The frontend shows the sky "Reading the documents…"
          // panel; its readiness poll auto-resumes the draft when extractionState reaches chart_ready.
          res.status(202).json({
            data: {
              preparing: true,
              autoRemediated: remediation.remediated,
              reocrQueued: remediation.remediated ? remediation.reocrQueued : 0,
              caseId,
              message: 'Reading the documents and rebuilding the chart. Drafting will start automatically when it finishes — no need to wait here.',
            },
          });
          return;
        }
        // remediation.state === 'exhausted' — auto-recovery already ran for this doc-set; surface the
        // overridable block (the SendToDrafter panel + the CaseDetailPage last-resort banner read this).
        throw new HttpError(409, 'conflict', `${chartReadiness.manualSummaryRequired} file(s) could not be automatically read, and an automatic re-read did not resolve them. Add a manual summary, or override to draft without them.`, {
          caseId,
          manualSummaryRequired: chartReadiness.manualSummaryRequired,
          blockingFiles: chartReadiness.blockingFiles.map((b) => ({ filePath: b.filePath, terminalStatus: b.terminalStatus })),
          canOverride: true,
          autoRecoveryExhausted: true,
        });
      }

      // RETIRED 2026-06-29 (Dr. Kasky): the deterministic essential-docs gate (DRAFT_READINESS_GATE +
      // getDraftReadiness's ✓/⚠ present/missing evaluation) is GONE. It over-fired — the exact-canonical
      // dx match false-flagged a documented clinically-equivalent condition as "diagnosis missing", and
      // cautions were wrong ~90% of the time — and a dormant on-flag would have re-introduced exactly that
      // hidden hard-block. Drafting is now gated by the HUMAN Gate-1 attestation (the RN completes the
      // checklist, including the nexus judgment, in Gate1ChecklistModal) — not by any machine string-match.
      // The chart-readiness OCR door above (loadReconciledChartReadiness) is SEPARATE and still enforced.
      // The LLM SOAP note is the analysis surface. See ARCHITECTURE.md SUPERSEDED log.

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
      // KEYSTONE (auto-recovery loop): thread the RN/admin override INTO the bundle so the Fargate
      // drafter honors it via caseData.acknowledge_missing_docs and stops re-halting the chart the EMR
      // just released. The override is TRUE when the RN explicitly acknowledged missing docs OR when a
      // Gate-2 resume (rnDecision) is present — both bypass the chart-readiness 409 above, so both must
      // tell the drafter not to re-halt on the same unread-file condition. Absent ⇒ false ⇒ legacy.
      const acknowledgeMissingDocs = parsed.acknowledgeMissingDocs === true || parsed.rnDecision !== undefined;
      const bundle = await buildDrafterBundle(db, caseId, { acknowledgeMissingDocs }).catch((err: unknown) => {
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
      // Persisted route-picker PLAN stamp (Ryan 2026-06-25, "honor the SOAP theory on redraft"). Threads the
      // SAME Case.aiViabilityPlanJson the SOAP/Overview render INTO the bundle so the drafter (initial draft
      // AND redraft) FOLLOWS the persisted lead theory instead of re-running the route-picker fresh and
      // diverging from what the RN saw. Read-only (the plan was persisted at card-compute time); fail-open:
      // no ready/on-condition plan ⇒ unstamped ⇒ the drafter derives fresh, byte-identical to today.
      stamped = await stampAiViabilityPlan(db, caseId, stamped);
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
            // WRITE-THROUGH (Ryan 2026-07-04): a Gate-2 "switch to condition" is the RN ACCEPTING a specific
            // dx — persist it to the Case so the NEXT redraft reads the switched condition instead of
            // re-refusing the original generic label (the latent revert bug: previously the switch was
            // per-job scratch only). Stamp source='manual' (RN-accepted → immutable to AI-narrow), set BOTH
            // claimedCondition and claimedConditions[] (they desync otherwise — CDS/drafter read the array
            // when non-empty), and invalidate the stale route-picker plan so it recomputes on the new claim.
            if (typeof rd.switchToCondition === 'string' && rd.switchToCondition.trim().length > 0) {
              const switched = rd.switchToCondition.trim();
              await tx.case.update({
                where: { id: caseId },
                data: { claimedCondition: switched, claimedConditions: [switched], claimedConditionSource: 'manual', aiViabilityPlanJson: null, aiViabilityPlanHash: null } as never,
              });
            }
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
      let concurrency: DraftConcurrency | null;
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
        // FIX (Bug 1, 2026-06-29): a cancel left Case.status at 'drafting' forever, so the Cases list
        // kept reading "Drafting" with no in-flight job. Take the case OFF 'drafting' here. Target
        // 'needs_rn_decision' (the decision-made park) — NOT 'rn_review', which would imply a completed
        // letter exists. Mirror the stuck-job-watcher's terminal-case write (operatorState 'paused' +
        // friendly operatorMessage + runComplete false + version bump so the 8s-poll UI refetches). The
        // newest DraftJob is now terminal ('failed'), so the in-flight gate clears and redraft (POST
        // /draft) stays available.
        await tx.case.update({
          where: { id: job.caseId },
          data: {
            status: 'needs_rn_decision',
            operatorState: 'paused',
            operatorMessage: 'This draft was cancelled. Click Send to Drafter to start a new draft when ready.',
            runComplete: false,
            version: { increment: 1 },
          },
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

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // Import final letter (2026-06-14). The EMR had no way to drop an already-FINISHED letter PDF
  // (a rig-origin draft produced outside the cloud drafter, or an externally-signed letter) onto a
  // case — so finished letters were stuck with nowhere to land. These two routes mirror the
  // drafter /complete happy path EXACTLY (DraftJob state='done' + version N + artifactPdfS3Key,
  // a LetterRevision at N, and Case currentVersion=N + status='rn_review' + version increment)
  // so the imported letter surfaces in the RN review queue and flows RN -> physician -> delivery
  // through the NORMAL sign-off. No re-render — the exact PDF bytes are preserved.
  //
  // DELIVERY SAFETY: this does NOT fabricate a SignOff and does NOT mark the case deliverable. The
  // imported letter still goes through the EMR physician sign-off (the #17 delivery-eligibility
  // gate); import only lands it in rn_review.
  //
  // KNOWN DOWNSTREAM GAP (flagged for the parent — see the report): the sign-off / approve /
  // delivery paths are TXT-centric (sign-off byte-binds to the txt hash; approve RE-RENDERS the
  // final letter from the txt and re-applies the assigned physician's signature; delivery builds
  // the §VII excerpt from the txt). LetterRevision.artifactTxtS3Key is NON-NULL in the schema, so
  // import writes a small PLACEHOLDER txt sidecar (canonical content is the PDF) to keep every txt
  // reader schema-valid and 500-free. An EXTERNALLY-SIGNED import that is later run through
  // approve would be re-rendered from that placeholder — so a "deliver the imported PDF as-is
  // (skip re-render)" passthrough is the follow-up needed before externally-signed imports can be
  // approved+delivered. A rig-origin draft is fine to re-render through approve. This route ships
  // the blocker fix (get the letter INTO the queue) today; the passthrough is tracked separately.

  // POST /api/v1/cases/:id/letter/import-presign  (admin / ops_staff)
  // Compute the next version N and presign a PUT of the finished PDF to the canonical
  // drafter-artifacts/<caseId>/vN/imported-letter.pdf key.
  router.post(
    '/cases/:id/letter/import-presign',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const bucket = process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      }
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, currentVersion: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // Next version = beyond BOTH the case pointer and the highest draft-job version, so an import
      // can never collide with an in-flight/prior draft attempt's numbering (same rule POST /draft uses).
      const maxVersionRow = await db.draftJob.findFirst({ where: { caseId }, orderBy: { version: 'desc' }, select: { version: true } });
      const version = Math.max(maxVersionRow?.version ?? 0, c.currentVersion ?? 0) + 1;

      const s3Key = `drafter-artifacts/${caseId}/v${version}/imported-letter.pdf`;
      if (!isDrafterArtifactS3Key(s3Key)) {
        // Only reachable if caseId carries characters the artifact-key pattern rejects.
        throw new HttpError(400, 'bad_request', 'Case id cannot be used to build a safe artifact key.', { caseId });
      }

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        ContentType: 'application/pdf',
        ServerSideEncryption: 'aws:kms',
      });
      const uploadUrl = await getSignedUrl(getS3ForArtifacts(), command, { expiresIn: IMPORT_UPLOAD_TTL_SECONDS });

      res.json({
        data: {
          uploadUrl,
          s3Key,
          version,
          expiresInSeconds: IMPORT_UPLOAD_TTL_SECONDS,
          requiredHeaders: {
            'content-type': 'application/pdf',
            'x-amz-server-side-encryption': 'aws:kms',
          },
        },
      });
    }),
  );

  // POST /api/v1/cases/:id/letter/import  (admin / ops_staff)
  // Commit the uploaded PDF: DraftJob (done) + LetterRevision (external_import) + Case (rn_review)
  // in ONE transaction. Validates the s3Key pattern AND that it belongs to THIS case.
  router.post(
    '/cases/:id/letter/import',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const actor = currentActor(req);
      const bucket = process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      }
      if (!isRecord(req.body)) badRequest('Request body must be an object');
      const body = req.body as Record<string, unknown>;
      const s3Key = typeof body['s3Key'] === 'string' ? body['s3Key'] : '';

      // (a) Pattern-safe (no traversal, drafter-artifacts/.../vN/<file>.pdf).
      if (!isDrafterArtifactS3Key(s3Key)) {
        throw new HttpError(400, 'bad_request', 's3Key is missing or not a valid drafter-artifacts key.', { caseId });
      }
      // (b) Belongs to THIS case AND is a PDF — the second path segment is the caseId. Reject a key
      // for another case (or a non-pdf) even if it passes the generic pattern check.
      if (!s3Key.startsWith(`drafter-artifacts/${caseId}/`) || !s3Key.endsWith('.pdf')) {
        throw new HttpError(400, 'bad_request', 's3Key does not belong to this case or is not a PDF.', { caseId, s3Key });
      }
      // (c) Derive the version from the key path (drafter-artifacts/<caseId>/v<N>/...).
      const versionMatch = /\/v(\d+)\//.exec(s3Key.slice(`drafter-artifacts/${caseId}/`.length - 1));
      const version = versionMatch !== null ? Number(versionMatch[1]) : NaN;
      if (!Number.isInteger(version) || version < 1) {
        throw new HttpError(400, 'bad_request', 'Could not derive a version from the s3Key.', { caseId, s3Key });
      }

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // Idempotency: a LetterRevision already at this version means the import already landed (a
      // double-click / retry). No-op gracefully instead of a P2002 or a duplicate DraftJob.
      const existingRev = await db.letterRevision.findFirst({ where: { caseId, version } });
      if (existingRev !== null) {
        res.json({ ok: true, version, alreadyImported: true });
        return;
      }

      // Confirm the uploaded object actually exists before we wire a row to it — an import that
      // references a missing key would 404 the moment the RN clicks "View letter".
      try {
        await getS3ForArtifacts().send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
      } catch {
        throw new HttpError(409, 'conflict', 'No uploaded PDF was found at the import key. Re-run the upload, then commit.', { caseId, s3Key });
      }

      // LetterRevision.artifactTxtS3Key is NON-NULL. The imported letter has no txt (we preserve the
      // PDF bytes, no re-render). Write a small placeholder txt sidecar at the canonical key so every
      // txt reader (editor load / sign-off byte-bind / approve re-render / delivery excerpt) stays
      // schema-valid and 500-free. See the KNOWN DOWNSTREAM GAP note above.
      const txtKey = `drafter-artifacts/${caseId}/v${version}/imported-letter.txt`;
      if (!isDrafterArtifactS3Key(txtKey)) {
        throw new HttpError(400, 'bad_request', 'Could not build a safe txt sidecar key.', { caseId });
      }
      const placeholderTxt = `[Imported final letter v${version}]\nThis letter was imported as a finished PDF. The canonical content is the PDF artifact at ${s3Key}. No text version was produced at import time.\n`;
      await getS3ForArtifacts().send(new PutObjectCommand({
        Bucket: bucket,
        Key: txtKey,
        Body: placeholderTxt,
        ContentType: 'text/plain; charset=utf-8',
        ServerSideEncryption: 'aws:kms',
      }));

      const now = new Date();
      const priorVersion = c.currentVersion;
      const jobId = randomUUID();
      const filename = typeof body['filename'] === 'string' ? (body['filename'] as string).slice(0, 200) : null;

      let imported;
      try {
        imported = await db.$transaction(async (tx) => {
          const job = await tx.draftJob.create({
            data: {
              id: jobId,
              caseId,
              version,
              state: 'done',
              artifactPdfS3Key: s3Key,
              artifactTxtS3Key: txtKey,
              failureClass: null,
              enqueuedAt: now,
              startedAt: now,
              completedAt: now,
              lastHeartbeatAt: now,
              currentPhase: 'complete',
            },
          });
          await tx.letterRevision.create({
            data: {
              caseId,
              version,
              parentVersion: priorVersion,
              source: 'external_import',
              artifactTxtS3Key: txtKey,
              artifactPdfS3Key: s3Key,
              artifactDocxS3Key: null,
              editedBy: actor.sub,
              editorRole: actor.role,
              sanityJson: null,
            },
          });
          const caseUpdated = await tx.case.update({
            where: { id: caseId },
            data: {
              currentVersion: version,
              status: 'rn_review',
              version: { increment: 1 },
            },
          });
          await tx.activityLog.create({
            data: {
              actorUserId: actor.sub,
              caseId,
              action: 'letter_imported',
              detailsJson: {
                jobId,
                version,
                parentVersion: priorVersion,
                artifactPdfS3Key: s3Key,
                ...(filename !== null ? { filename } : {}),
              },
            },
          });
          return { job, case: caseUpdated };
        });
      } catch (err) {
        // Concurrent import for the same version → the LetterRevision unique [caseId,version] fires.
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
          res.json({ ok: true, version, alreadyImported: true });
          return;
        }
        throw err;
      }

      res.json({ ok: true, version, draftJobId: imported.job.id });
    }),
  );

  return router;
}

const HALT_REASON_CODES = [
  'dx_not_found', 'event_not_found', 'dx_and_event_not_found',
  'verify_error', 'verify_parse_error', 'verify_unavailable', 'no_records_text',
  // Body-quality park (FRN cloud drafter draftBodyQualityGate): a FULL draft was produced but the
  // deterministic body-quality gate found a letter-killing MATERIAL defect (editorial-meta leak /
  // fabricated PMID / dual-prong missing / SSN-PHI / locked-block / Section III list-format). The
  // letter is parked for a targeted RE-DRAFT — NOT a dx/event verification hold. Maps to status
  // 'needs_rn_decision' + decision 'pause' (mirrors verify_error). The FRN side currently still
  // emits 'verify_error' with haltGate 'body_quality' until its drafter image redeploys; BOTH the
  // dedicated code here AND that legacy verify_error+body_quality path are accepted (see isBodyQualityHalt
  // on the frontend). DO NOT remove verify_error.
  'body_quality_critical',
  // Plan-validity park (FRN cloud drafter Phase 0.5a planValidityGate): the chosen lead theory
  // was not confirmed GROUNDED in this record (e.g. a SECONDARY theory whose upstream primary is
  // not yet marked Service-connected). The pipeline exits 3 BEFORE any letter is drafted, and the
  // FRN worker posts /halt with reasonCode 'plan_validity' + haltGate 'plan_validity'. Maps (via the
  // existing handler) to case status 'needs_rn_decision' + a draft_decisions 'no'. No handler change:
  // this allowlist entry lets parseHaltBody accept the code instead of 400-rejecting it (which would
  // DLQ the job and leave the case unparked). This is a NO-DRAFT hold (haltShouldCarryDraft stays
  // false → no artifact preserved). Fix C 2026-07-19 — surface-the-real-halt-reason.
  'plan_validity',
] as const;

// A halt reasonCode that maps to a draft_decisions 'pause' (a verification/quality step found a
// blocking problem and paused the run for the RN) rather than a 'no' (a gate answered a yes/no
// finding in the negative). body_quality_critical mirrors verify_error here.
function isPauseDecisionReason(reasonCode: string): boolean {
  return reasonCode.startsWith('verify') || reasonCode === 'no_records_text' || reasonCode === 'body_quality_critical';
}

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

// True when this halt class is one where a FULL letter WAS produced (a body-quality park), so the
// /halt receiver should try to PRESERVE that draft (persist its txt key + advance currentVersion) —
// as opposed to a dx/event verification hold (dx_not_found / event_not_found / no_records_text), which
// halts BEFORE any letter exists and must stay no-draft. Detection mirrors the frontend isBodyQualityHalt:
// the dedicated 'body_quality_critical' code OR the legacy emission (haltGate 'body_quality' borrowing
// the allowlisted 'verify_error' code until the FRN drafter image redeploys).
export function haltShouldCarryDraft(reasonCode: string, haltGate: string): boolean {
  return reasonCode === 'body_quality_critical' || haltGate === 'body_quality';
}

// Map a halt reasonCode to the draft_decisions item it concerns (for the chart panel).
function haltItem(reasonCode: string): string {
  if (reasonCode === 'event_not_found') return 'in_service_event';
  if (reasonCode === 'dx_not_found' || reasonCode === 'dx_and_event_not_found') return 'dx_present';
  // A body-quality park is NOT a dx-verification finding — label it honestly so the chart Decisions
  // panel does not read as a diagnosis hold.
  if (reasonCode === 'body_quality_critical') return 'body_quality';
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
  // Revised-letter recovery (2026-07-16): APPLY-time server-side re-verify of a single PMID against
  // NCBI (verifyPmidById). Injected so the router carries no NCBI dependency at type-check time and so
  // unit tests stub it. The revised-letter push FAILS CLOSED when this is absent but the pushed letter
  // carries PMIDs (a recovery push must never smuggle an unverified cite through an unconfigured env).
  verifyPmid?: EnrichVerifier;
  // Revised-letter GRADE (2026-07-22): the fast Sonnet probative regrader the editor-save runs. Injected
  // (optional) ONLY so unit tests can stub it without a network call; production leaves it undefined and
  // the handler falls back to the real `gradeLetterText`. Fail-open — a null/throw never blocks the push.
  gradeLetter?: (input: { letterText: string; claimedCondition: string }) => Promise<LetterRegrade | null>;
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
  }): Promise<string | null> {
    if (typeof args.docxKey === 'string' && args.docxKey.trim() !== '') return args.docxKey;
    // NON-FATAL (HOTFIX 2026-06-20): a DOCX backfill is an ENRICHMENT — it must NEVER 500 a terminal
    // drafter callback (a 500 leaves the SQS message for redrive → the case loops ~45m → the draft UI
    // freezes). Previously this THREW 502 on unconfigured deps / a missing TXT / a render failure, which
    // froze drafting (on a failed run the canonical TXT key points at an object that was never written →
    // NoSuchKey → 500). Now every failure path logs + returns null (the legacy null-docx fallback; the
    // letter editor null-guards docxKey). Protects BOTH callers (happy-path completion + the resurrect path).
    try {
      const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;
      if (deps.renderLetter === undefined || deps.s3 === undefined || bucketName === undefined) {
        console.warn(JSON.stringify({ msg: 'docx_backfill_unavailable', caseId: args.caseId, version: args.version }));
        return null;
      }
      // Read the TXT (the source of truth) and render the trio into the letter-revisions keyspace.
      const obj = await deps.s3.send(new GetObjectCommand({ Bucket: bucketName, Key: args.txtKey }));
      if (obj.Body === undefined) {
        console.warn(JSON.stringify({ msg: 'docx_backfill_txt_read_failed', caseId: args.caseId, key: args.txtKey }));
        return null;
      }
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
      if (!rendered.ok) {
        console.warn(JSON.stringify({ msg: 'docx_backfill_render_failed', caseId: args.caseId, version: args.version }));
        return null;
      }
      return keys.docxKey;
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'docx_backfill_failed_open', caseId: args.caseId, error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
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
      //
      // HOTFIX (2026-06-20): ONLY backfill/mirror for a SUCCESSFUL run. A FAILED run (runComplete=false,
      // pipeline exitCode 2 at the readiness gate) wrote NO letter artifacts, yet the worker still sends
      // the canonical txt key — so resolveDocxKeyForMirror's S3 GetObject on that never-written key threw
      // NoSuchKey → unhandled 500 → the FAILURE callback itself failed ("failure-complete also failed") →
      // the case could never record its failure and looped on the in-flight SQS message (~45m), freezing
      // the draft UI on step 1. That is the drafting-freeze. For a failed run there is nothing to mirror.
      // Belt-and-suspenders: even the happy-path backfill is now non-fatal — a backfill hiccup logs and
      // falls back to the legacy null docx instead of 500-ing the whole completion callback.
      // Only backfill/mirror a DOCX for a SUCCESSFUL run — a failed run wrote no letter (resolveDocxKeyForMirror
      // is now non-fatal too, so this gate is belt-and-suspenders + avoids the wasted S3/render work).
      const mirrorDocxKey: string | null = parsed.runComplete
        ? await resolveDocxKeyForMirror({
            caseId: existing.caseId,
            version: existing.version,
            parentVersion: existing.parentVersion ?? existing.version,
            txtKey: parsed.artifactTxtS3Key,
            docxKey: parsed.artifactDocxS3Key,
          })
        : (parsed.artifactDocxS3Key ?? null);

      // ── STRANDED-POINTER GUARD AT THE SOURCE (Puller, CLM-CCFDA1BCC3, 2026-06-25) ──
      // The F4 invariant historically advanced Case.currentVersion on ANY terminal /complete (ship OR
      // fail) so the operator UI could show "vN failed; retry as vN+1". But a failed/partial run writes
      // NO txt artifact, so advancing currentVersion onto that dead version STRANDED the prior good
      // letter: the editor's mutating paths (resolveCurrent, STRICT) returned null at the dead version
      // and 409'd `no_letter` BEFORE any §VII gate/holding-lock ever ran (Puller: 25+ surgical-ai 409s).
      // FIX B mirrors the /halt receiver's guard: HeadObject-verify the run's txt artifact ACTUALLY
      // exists in S3 before advancing the pointer. When it does NOT exist (failed run, or a run whose
      // wrapper never uploaded), we DO NOT advance currentVersion — the DraftJob row still records the
      // attempt (state, version, errorMessage) so the operator UI's "vN failed, retry" is unaffected.
      // Fail-SAFE default: never advance onto an artifact we cannot prove exists. The DOCX-backfill above
      // does a GetObject on the same txt, but it is non-fatal + may be skipped (unconfigured deps), so we
      // verify independently here. Done BEFORE the transaction (HeadObject is a network call).
      let advanceCurrentVersion = false;
      if (!parsed.runComplete) {
        // A FAILED run wrote no letter — the worker still sends the canonical (never-uploaded) txt key.
        // This is the PRIMARY stranding source the Puller incident traced: a failed re-draft advancing
        // currentVersion onto a dead version. Never advance for a failed run; never touch S3 (the
        // drafting-freeze hotfix test pins that a failed run does NOT call S3). The DraftJob row still
        // records the failure (state/version/errorMessage) so the operator "vN failed, retry" UI works.
        console.warn(JSON.stringify({
          msg: 'complete_failed_run_pointer_not_advanced',
          jobId, caseId: existing.caseId, version: existing.version,
          note: 'failed run wrote no letter; left Case.currentVersion at the last good version to avoid stranding the prior letter',
        }));
      } else {
        // A SUCCESSFUL run: HeadObject-verify the txt artifact ACTUALLY exists before advancing the
        // pointer (mirrors the /halt receiver's guard). A run that claims success but never uploaded its
        // txt (a partial/aborted upload) must not strand the prior good letter behind a dead pointer.
        const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;
        const s3 = deps.s3;
        if (s3 !== undefined && typeof bucketName === 'string' && bucketName.length > 0) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: parsed.artifactTxtS3Key }));
            advanceCurrentVersion = true; // object confirmed present → safe to advance
          } catch {
            advanceCurrentVersion = false;
            console.warn(JSON.stringify({
              msg: 'complete_txt_artifact_absent_pointer_not_advanced',
              jobId, caseId: existing.caseId, version: existing.version,
              txtKeyBasename: parsed.artifactTxtS3Key.split('/').pop(),
              note: 'runComplete /complete had no resolvable txt artifact in S3; left Case.currentVersion at the last good version to avoid stranding the prior letter',
            }));
          }
        } else {
          // Unconfigured S3 (local dev / render-less env): cannot HeadObject. Preserve the legacy
          // happy-path behavior (advance) — the verification is a cloud-side safety net, and a render-
          // less env never produced the partial-upload failure mode this guards against.
          advanceCurrentVersion = true;
          console.warn(JSON.stringify({ msg: 'complete_artifact_check_skipped_unconfigured', jobId, caseId: existing.caseId, version: existing.version }));
        }
      }

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
            // F4 semantics (Ryan, 2026-05-26): currentVersion = last *attempted* version with a
            // PROVEN artifact. NARROWED (Puller, CLM-CCFDA1BCC3, 2026-06-25): we advance the pointer
            // ONLY when this run's txt artifact was HeadObject-confirmed present in S3 (advanceCurrentVersion).
            // A failed/partial run that wrote no txt leaves currentVersion at the last good version so it
            // can never strand the prior good letter behind a dead pointer (the editor's mutating paths
            // would 409 `no_letter` on a stranded version). The operator "vN failed, retry" UI is driven by
            // the DraftJob row (state/version/errorMessage), not currentVersion, so it is unaffected.
            // The physician-routing gate stays separate (runComplete && shipRecommendation==='ship').
            ...(advanceCurrentVersion ? { currentVersion: existing.version } : {}),
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
        //
        // HOTFIX (2026-06-20): ONLY mirror a revision for a SUCCESSFUL run. A FAILED run wrote no letter,
        // and parseCompleteBody forces it to send canonical (never-uploaded) txt/pdf keys — pre-hotfix the
        // backfill THREW before this ran, so no phantom revision existed; now that failed runs complete the
        // transaction, mirroring here would create a revision pointing at artifacts that don't exist, which
        // resolveCurrent() would surface as the "current" letter → a 404 in the editor. A failed run still
        // bumps currentVersion on the DraftJob (operator UI shows "vN failed, retry") but writes NO revision.
        //
        // TIMELINE HYGIENE (QA SHOULD-FIX, 2026-06-25): gate the mirror on `advanceCurrentVersion` — the
        // SAME HeadObject-confirmed result that gates the pointer — not on runComplete alone. The FIX-B
        // partial-upload case (runComplete=true but the txt was never written to S3) correctly does NOT
        // advance currentVersion; mirroring a LetterRevision there would write a PHANTOM row pointing at the
        // never-written artifact (inert — reads/edits HeadObject-skip it — but still timeline noise). So a
        // proven-absent artifact now writes NEITHER the pointer NOR the revision row. The DraftJob row update
        // above stays unconditional (the attempt is always recorded for the operator UI). The unconfigured-S3
        // legacy-advance branch sets advanceCurrentVersion=true, so it still mirrors (it can't hit the
        // partial-upload mode — there is no S3 to upload to).
        if (advanceCurrentVersion) {
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

      // ── PRESERVE A PRODUCED DRAFT (option A, no-FRN-change path, 2026-06-22) ──
      // A body-quality park is the ONE halt class where a FULL letter WAS produced. The FRN drafter
      // does not POST an artifact key on /halt, so reconstruct the CANONICAL key the wrapper would have
      // uploaded — drafter-artifacts/<caseId>/v<N>/v<N>.txt — validate it, and HeadObject-check it.
      // ONLY when the object ACTUALLY exists do we persist artifactTxtS3Key onto the DraftJob row AND
      // advance Case.currentVersion to the halted version, so resolveCurrentTxtKey (DraftJob fallback)
      // and getLetter reach the held letter. When it does NOT exist — the genuine no-draft case (incl.
      // every dx/event verification hold) OR S3/bucket unconfigured (local dev) — we change NOTHING about
      // version/key: the case stays no-draft so the dx-halt confirm/halt panel is untouched. Fail-SAFE
      // default: never advance currentVersion onto a draft we cannot prove exists. Done BEFORE the
      // transaction (a HeadObject is a network call; the DB txn stays short).
      let preservedTxtKey: string | null = null;
      if (haltShouldCarryDraft(parsed.reasonCode, parsed.haltGate)) {
        const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;
        const s3 = deps.s3;
        if (s3 !== undefined && typeof bucketName === 'string' && bucketName.length > 0) {
          const artifactPrefix = (process.env['DRAFTER_ARTIFACTS_S3_PREFIX'] || 'drafter-artifacts/').replace(/^\/+/, '');
          const candidate = `${artifactPrefix}${existing.caseId}/v${existing.version}/v${existing.version}.txt`;
          if (isDrafterArtifactS3Key(candidate)) {
            try {
              await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: candidate }));
              preservedTxtKey = candidate; // object confirmed present → safe to surface
            } catch {
              // NoSuchKey / NotFound / network: treat as no-draft (fail-safe). Logged so a body-quality
              // park whose txt is genuinely missing leaves a CloudWatch trace (vs. a silent no-op).
              console.warn(JSON.stringify({ msg: 'halt_draft_artifact_absent', jobId, caseId: existing.caseId, version: existing.version, candidate: candidate.split('/').pop() }));
            }
          }
        } else {
          console.warn(JSON.stringify({ msg: 'halt_draft_check_skipped_unconfigured', jobId, caseId: existing.caseId, version: existing.version }));
        }
      }

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
            // Surface the produced letter ONLY when its txt object was confirmed present in S3.
            ...(preservedTxtKey !== null ? { artifactTxtS3Key: preservedTxtKey } : {}),
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
            // Advance the "current letter" pointer to the held version ONLY when a real draft exists, so
            // getLetter/editor reach it. status stays 'needs_rn_decision' (the gate) — currentVersion is
            // NOT a delivery/sign-off authority (F4 invariant). Absent → pointer untouched (no-draft).
            ...(preservedTxtKey !== null ? { currentVersion: existing.version } : {}),
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
            decision: isPauseDecisionReason(parsed.reasonCode) ? 'pause' : 'no',
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

  /**
   * GET /api/v1/internal/drafter/resolve-case?vet=<name>&condition=<cond>   (drafter-principal)
   *
   * PLAIN-SPEAKING case resolver for the ops window (2026-07-22). Turns a veteran NAME (+ optional
   * condition) into a single caseId so an operator can push a letter by "John Smith / OSA" instead
   * of a CLM id. RDS is the source of truth — unlike the S3 case_lookup stopgap this resolves a
   * LETTERLESS case too (a case with no rendered letter yet). Strictly READ-ONLY: no writes, no
   * render, no token/NCBI spend.
   *
   *   exactly one match  -> 200 { data: { caseId, veteranName, condition, status, assignedPhysician } }
   *   multiple matches   -> 409 conflict  details:{ reason:'ambiguous', candidates:[...] }  (ops picks)
   *   no match           -> 404 not_found details:{ reason:'no_match' } ( + nameMatches[] when the
   *                             NAME matched but the condition filter excluded every case — a useful
   *                             hint so the operator sees "found John Smith, but no OSA case; his are…")
   *
   * Name match: EVERY whitespace-separated token of `vet` must appear (case-insensitive substring) in
   * firstName OR lastName. "John Smith" => firstName~John AND lastName~Smith; "Smith" => either field.
   * Condition match (optional): loose substring against claimedCondition OR any claimedConditions member.
   */
  router.get(
    '/internal/drafter/resolve-case',
    asyncHandler(async (req: Request, res: Response) => {
      const vetRaw = req.query['vet'];
      const vet = typeof vetRaw === 'string' ? vetRaw.trim() : '';
      if (vet.length === 0) badRequest('vet is required (veteran name; first/last, substring ok)', { field: 'vet' });
      if (vet.length > 120) badRequest('vet is too long (max 120 chars)', { field: 'vet' });
      let condition: string | undefined;
      const condRaw = req.query['condition'];
      if (condRaw !== undefined && condRaw !== null) {
        if (typeof condRaw !== 'string' || condRaw.length > 120) badRequest('condition must be a string under 120 chars', { field: 'condition' });
        if ((condRaw as string).trim().length > 0) condition = (condRaw as string).trim();
      }

      // Every token must substring-match firstName OR lastName (case-insensitive). Cap at 6 tokens so
      // a pathological query can't explode the AND. On Postgres, `mode: 'insensitive'` is applied by
      // Prisma; the hand-written delegate takes `unknown` args so this stays type-clean.
      const tokens = vet.split(/\s+/).filter(Boolean).slice(0, 6);
      const nameAnd = tokens.map((t) => ({
        OR: [
          { firstName: { contains: t, mode: 'insensitive' } },
          { lastName: { contains: t, mode: 'insensitive' } },
        ],
      }));
      const vets = await db.veteran.findMany({ where: { inactive: false, AND: nameAnd }, take: 50 });
      if (vets.length === 0) {
        throw new HttpError(404, 'not_found', `No veteran matches "${vet}".`, { reason: 'no_match', vet, condition: condition ?? null });
      }
      const vetById = new Map(vets.map((v) => [v.id, v]));

      // Name-matched, non-archived cases (RDS = source of truth; a letterless case still resolves).
      const nameCases = await db.case.findMany({
        where: { veteranId: { in: [...vetById.keys()] }, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      });

      // Optional loose condition narrowing (claimedCondition OR any claimedConditions member contains cond).
      const matched = condition === undefined
        ? nameCases
        : nameCases.filter((c) => {
            const needle = condition.toLowerCase();
            if ((c.claimedCondition ?? '').toLowerCase().includes(needle)) return true;
            return (c.claimedConditions ?? []).some((x) => x.toLowerCase().includes(needle));
          });

      // Resolve assigned-physician display names in one query (id -> fullName).
      const physIds = [...new Set(
        (matched.length > 0 ? matched : nameCases)
          .map((c) => c.assignedPhysicianId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )];
      const physById = new Map<string, string>();
      if (physIds.length > 0) {
        const phys = await db.physician.findMany({ where: { id: { in: physIds } } });
        for (const p of phys) physById.set(p.id, p.fullName);
      }
      const toCandidate = (c: (typeof nameCases)[number]) => {
        const v = vetById.get(c.veteranId);
        return {
          caseId: c.id,
          veteranName: v ? `${v.firstName} ${v.lastName}`.trim() : '',
          condition: c.claimedCondition,
          status: c.status,
          assignedPhysician: (c.assignedPhysicianId && physById.get(c.assignedPhysicianId)) || null,
        };
      };

      if (matched.length === 1) { res.json({ data: toCandidate(matched[0]) }); return; }
      if (matched.length > 1) {
        throw new HttpError(409, 'conflict', `Multiple cases match "${vet}"${condition !== undefined ? ` / "${condition}"` : ''}; pass --case CLM-… to disambiguate.`, {
          reason: 'ambiguous', vet, condition: condition ?? null, candidates: matched.map(toCandidate),
        });
      }
      // No case survived the (optional) condition filter. When the NAME matched cases, hand them back
      // as a hint so the operator can see the real conditions and re-run with the right term (or --case).
      throw new HttpError(404, 'not_found', `No case matches "${vet}"${condition !== undefined ? ` with condition "${condition}"` : ''}.`, {
        reason: 'no_match', vet, condition: condition ?? null,
        ...(nameCases.length > 0 ? { nameMatches: nameCases.map(toCandidate) } : {}),
      });
    }),
  );

  /**
   * POST /api/v1/internal/drafter/cases/:id/revised-letter   (drafter-principal)
   *
   * REVISED-LETTER RECOVERY (2026-07-16). Push an OUT-OF-BAND, physician-corrected nexus-letter TXT
   * into the physician-review queue WITHOUT a full re-draft. Used when a letter was fixed outside the
   * pipeline (e.g. a hand-corrected TXT) and must become the current, editor-resolvable letter that
   * the physician signs — cheaply, and without spending drafting tokens.
   *
   * Fail-safe, waste-minimal ordering (see the numbered steps inline):
   *   - EVERY blocking check that can reject a bad push runs BEFORE the render, so a bad push costs
   *     ZERO render spend (PMID fabrication + SSN-PHI + status + in-flight all gate pre-render).
   *   - The PMID gate + NCBI verify FAILS CLOSED (a verify error or an unconfigured verifier BLOCKS)
   *     — a recovery push must never smuggle an unverified/fabricated citation through a transient
   *     NCBI outage.
   *   - A 409 draft_in_flight guard is LOAD-BEARING: without it a later /complete for an in-flight run
   *     would move Case.currentVersion backward and BURY the recovery letter.
   *   - The unique [caseId,version] backstop yields 409 version_conflict (NOT an idempotent no-op):
   *     two DIFFERENT revised bodies at the same version must never silently collapse into one.
   */
  router.post(
    '/internal/drafter/cases/:id/revised-letter',
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);

      // 1. Auth is the requireDrafterPrincipal middleware (mounted in front of this router); actor is
      //    the drafter service principal. 2. Parse + bound the body.
      const body = req.body;
      if (!isRecord(body)) badRequest('Request body must be an object');
      const b = body as Record<string, unknown>;
      const rawLetter = b['letterText'];
      if (typeof rawLetter !== 'string' || rawLetter.trim().length === 0) {
        badRequest('letterText is required (non-empty)', { field: 'letterText' });
      }
      const letterText = rawLetter as string;
      // ~200KB ceiling: a finished nexus letter is a few KB of prose; 200KB is far past any real letter
      // but bounds a pathological payload (the internal JSON parser already caps at 50mb).
      if (letterText.length > 200_000) {
        badRequest('letterText exceeds the 200KB limit', { field: 'letterText', max: 200_000 });
      }
      let reason: string | undefined;
      const rawReason = b['reason'];
      if (rawReason !== undefined && rawReason !== null) {
        if (typeof rawReason !== 'string' || rawReason.length > 2000) {
          badRequest('reason must be a string under 2000 chars', { field: 'reason' });
        }
        if ((rawReason as string).trim().length > 0) reason = (rawReason as string).trim();
      }

      // Config guards (fail fast, before any DB read or NCBI spend). renderLetter + bucket are required
      // to produce the triple artifact; a render-less env cannot accept a recovery push.
      const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;
      if (deps.renderLetter === undefined || bucketName === undefined || bucketName.length === 0) {
        throw new HttpError(503, 'internal_error', 'Revised-letter recovery is not configured in this environment (render/bucket).', { reason: 'render_unavailable', caseId });
      }

      // 3. Load Case + Veteran (name/last/claimedCondition for the render caseData).
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(404, 'not_found', 'Veteran not found for case', { caseId });

      // 4. 409 draft_in_flight — an active DraftJob (queued, or running+heartbeating within the stale
      //    window) is still producing/racing a letter. Accepting a recovery push now would be clobbered
      //    when that run's /complete later advances currentVersion (possibly BACKWARD onto its version),
      //    burying the recovery letter. A stale/crashed run (heartbeat past the window) is NOT active —
      //    the watcher will sweep it — so recovery may proceed over it.
      const staleBoundary = new Date(Date.now() - STALE_THRESHOLD_MS);
      const activeJob = await db.draftJob.findFirst({
        where: {
          caseId,
          OR: [
            { state: 'queued' },
            { state: 'running', lastHeartbeatAt: { gte: staleBoundary } },
          ],
        },
      });
      if (activeJob !== null) {
        throw new HttpError(409, 'conflict', 'A draft is currently in flight for this case; retry the revised-letter push once it settles.', { reason: 'draft_in_flight', caseId, jobId: activeJob.id, state: activeJob.state });
      }

      // 5. 409 on an illegal case-status transition — the push lands the case in physician_review, so
      //    the current status must legally reach it (e.g. a 'rejected' case cannot). A case ALREADY in
      //    physician_review is the norm for this endpoint (Davis thyroid, 2026-07-18): replacing the
      //    letter under a case that is already in the doctor's queue is the ENTIRE POINT of the recovery
      //    endpoint, so a physician_review->physician_review self-replace is legal even though the generic
      //    transition table (correctly) omits the self-edge for the /status route. Only a status that can
      //    neither reach nor already BE physician_review is refused.
      const alreadyInReview = c.status === 'physician_review';
      if (!alreadyInReview && !isValidCaseStatusTransition(c.status, 'physician_review')) {
        throw new HttpError(409, 'conflict', `Case cannot move to physician_review from status '${c.status}'.`, { reason: 'illegal_status_transition', caseId, from: c.status });
      }

      // 6. Deterministic FRN-style prose cleanup (em dashes, smart quotes, ...). Same as every editor save.
      const cleaned = cleanProseForSave(letterText);

      // 7. PMID GATE + SSN — MUST BLOCK, and BEFORE the render so a bad push costs zero render spend.
      //    7a. SSN scan (cheap, local) first.
      if (/\b\d{3}-\d{2}-\d{4}\b/.test(cleaned)) {
        // 'unprocessable_entity' is not in the ErrorCode union — 422 + 'bad_request' + a reason detail.
        throw new HttpError(422, 'bad_request', 'The revised letter appears to contain an SSN; nothing was saved.', { reason: 'phi_ssn_detected', caseId });
      }
      //    7b. Re-verify every PMID against NCBI. Still FAILS CLOSED on a genuinely unverifiable /
      //        retracted citation, but is now THROTTLE-RESILIENT. verifyPmidById makes ~2 unkeyed NCBI
      //        calls per PMID (esummary + efetch), so firing N citations back-to-back trips NCBI's
      //        ~3 req/s unkeyed cap; the later calls error out and the verifier returns verified:false
      //        with a TRANSIENT reason (efetch_error / no_summary), which the old loop misread as a
      //        fabricated PMID and blocked valid 5-citation letters (PMID 20086074 on the Tanner push,
      //        2026-07-17; shared/outbox/20260717_EMR_revised_letter_pmid_verifier_throttle_bypass.md).
      //        Fix, endpoint-side only (the vendored verifier is untouched): (a) a delay BETWEEN
      //        citations keeps us under the rate cap; (b) a TRANSIENT failure is retried with backoff
      //        before we fail closed. A DEFINITIVE reject (invalid_pmid / retracted / real-but-
      //        ungroundable) still fails closed on the first answer, so nothing fabricated slips through.
      const pmids = [...extractCitationTokenMap(cleaned).values()]
        .filter((t) => t.kind === 'pmid')
        .map((t) => t.key.replace(/^pmid:/, ''));
      const verifiedPmids: string[] = [];
      if (pmids.length > 0) {
        if (deps.verifyPmid === undefined) {
          throw new HttpError(503, 'internal_error', 'Citation verification is not configured; refusing to accept a revised letter that carries citations.', { reason: 'verifier_not_configured', caseId });
        }
        const verifyPmid = deps.verifyPmid;
        const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
        // This push carries a PHYSICIAN'S deliberately-chosen citations (the ops window pre-verifies each
        // one). So this gate is NOT the auto-RETRIEVAL grounding contract — it is a narrow anti-FABRICATION
        // floor: block ONLY a PMID that does not resolve to a REAL, non-retracted PubMed record. This
        // mirrors the by-PMID Citation Enricher picker, which DELIBERATELY passes no condition so
        // verifyPmidById skips the on-topic gate ("the physician's explicit choice is the relevance
        // authority"). Reusing the full retrieval-grade gate here branded REAL physician-chosen papers as
        // "fabricated" and blocked legit pushes (Davis thyroid moles 11-13; architect QA 2026-07-18).
        // Reason taxonomy — ground truth = citationFallback.cjs verifyPmidById L318-352:
        //   ACCEPT — a REAL, non-retracted paper that merely fails the retrieval-grade grounding heuristics
        //     (short/absent abstract, no verbatim killer stat, off-topic token-match). These are NOT
        //     fabrication and MUST NOT block a physician's chosen citation. (off_topic can't even fire now
        //     — we pass no condition — but is kept here for defence-in-depth.)
        const ACCEPT_ANYWAY = new Set(['no_abstract', 'no_grounded_stat', 'off_topic']);
        //   RETRYABLE — a possibly-transient NCBI hiccup; retry with backoff. verify_error/efetch_error are
        //     the real throttle/transport paths (a sustained 429 throws → surfaces as verify_error).
        //     no_summary (200-OK, no record) usually means the PMID does not exist, but we retry it
        //     defensively in case a rate-limit body ever reads empty (Tanner-safe); if it persists it is
        //     branded fabricated below, never a false outage.
        const RETRYABLE = new Set(['efetch_error', 'verify_error', 'no_summary']);
        //   OUTAGE — of the retryable reasons, the genuine TRANSPORT failures worth a "retry in a moment".
        const OUTAGE = new Set(['efetch_error', 'verify_error']);
        for (let i = 0; i < pmids.length; i++) {
          if (i > 0) await sleep(800); // keep under NCBI's unkeyed ~3 req/s between citations
          const pmid = pmids[i];
          let ok = false;
          let lastReason: string | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await sleep(700 * attempt); // 700ms, then 1400ms backoff on retry
            let v: { verified?: boolean; reason?: string };
            // No condition arg — skip the on-topic gate; the physician's citation choice is the relevance
            // authority (identical policy to the by-PMID enricher). '' explicitly skips it in the verifier.
            try { v = await verifyPmid(pmid, ''); }
            catch { v = { verified: false, reason: 'verify_error' }; } // verifier never throws, but guard
            if (v.verified === true || ACCEPT_ANYWAY.has(v.reason ?? '')) { ok = true; break; } // real paper → accept
            lastReason = v.reason;
            if (!RETRYABLE.has(v.reason ?? '')) break; // definitive reject (invalid_pmid / retracted / persistent no_summary) → fail closed
            // else: possibly-transient → loop and retry with backoff
          }
          if (!ok) {
            // Classify the definitive/persistent failure into an honest reason + message.
            let reason: string;
            let message: string;
            if (lastReason === 'retracted') {
              reason = 'cites_retracted_paper';
              message = `The revised letter cites PMID ${pmid}, which PubMed lists as RETRACTED; nothing was saved.`;
            } else if (OUTAGE.has(lastReason ?? '')) {
              reason = 'ncbi_unavailable';
              message = `PubMed verification is temporarily unavailable for PMID ${pmid} (${lastReason ?? 'ncbi_error'}); nothing was saved — please retry in a moment.`;
            } else {
              reason = 'fabricated_pmid';
              message = `The revised letter cites PMID ${pmid}, which does not resolve to a real PubMed record; nothing was saved.`;
            }
            throw new HttpError(422, 'bad_request', message, { reason, caseId, pmid, verifyReason: lastReason });
          }
          verifiedPmids.push(pmid);
        }
      }

      // 8. Next version = one past the highest of (the latest DraftJob version, Case.currentVersion).
      const maxJob = await db.draftJob.findFirst({ where: { caseId }, orderBy: { version: 'desc' } });
      const parentVersion = c.currentVersion ?? 0;
      const version = Math.max(maxJob?.version ?? 0, c.currentVersion ?? 0) + 1;

      // 9. Render the triple artifact into the letter-revisions keyspace, then assert all three landed.
      const keys = {
        txtKey: buildLetterRevisionKey(caseId, version, 'txt'),
        pdfKey: buildLetterRevisionKey(caseId, version, 'pdf'),
        docxKey: buildLetterRevisionKey(caseId, version, 'docx'),
      };
      const caseData = {
        id: caseId,
        veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(),
        veteran_last: veteran.lastName,
        claimed_condition: c.claimedCondition,
      };
      const rendered = await deps.renderLetter({ caseData, letterText: cleaned, version, draft: true, bucket: bucketName, keys });
      if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Render failed; nothing saved.', { reason: 'render_failed', caseId, version });
      assertTripleArtifacts(keys, { caseId, version });

      // 10. Warn-only sanity findings (never block; stored on the revision for the UI). No prior text
      //     to diff against on an out-of-band import, so compare the cleaned letter to an empty base.
      const warnings: SanityFinding[] = sanityCheckLetterText('', cleaned);

      // 11. Persist atomically: the revision, the case pointer/status advance, and the audit row. The
      //     unique [caseId,version] backstop → 409 version_conflict (two different revised bodies at the
      //     same version must not silently collapse — deliberately NOT an idempotent no-op).
      try {
        await db.$transaction(async (tx) => {
          await tx.letterRevision.create({
            data: {
              caseId,
              version,
              parentVersion,
              source: 'revised_import',
              artifactTxtS3Key: keys.txtKey,
              artifactPdfS3Key: keys.pdfKey,
              artifactDocxS3Key: keys.docxKey,
              editedBy: SERVICE_ACTORS.DRAFTER,
              editorRole: 'drafter',
              sanityJson: warnings,
            },
          });
          await tx.case.update({
            where: { id: caseId },
            data: {
              currentVersion: version,
              status: 'physician_review',
              version: { increment: 1 },
            },
          });
          await tx.activityLog.create({
            data: {
              actorUserId: SERVICE_ACTORS.DRAFTER,
              caseId,
              action: 'revised_letter_imported',
              detailsJson: { version, parentVersion, ...(reason !== undefined ? { reason } : {}), verifiedPmids },
            },
          });
        });
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
          throw new HttpError(409, 'conflict', 'Another revision already claimed this version; reload and retry.', { reason: 'version_conflict', caseId, version });
        }
        throw err;
      }

      // 12. Grade the pushed letter (reuse the editor-save regrade mechanism, Ryan 2026-07-08) so it shows
      //     a Grade like a drafter letter. FAIL-OPEN, DECOUPLED, and strictly AFTER the persist above: the
      //     letter is ALREADY saved+editable+in physician_review, so nothing here can block or roll back the
      //     push. gradeLetterText is fail-open (null on LLM error/timeout/too-short, never throws) and
      //     persistLetterGrade is a best-effort try/catch write (Case.grade + LetterRevision.gradeJson).
      //     A null/failed grade just leaves the letter ungraded until the first editor-save regrades it.
      let grade: string | null = null;
      let probativeScore: number | null = null;
      try {
        const doGrade = deps.gradeLetter ?? gradeLetterText;
        const regrade = await doGrade({ letterText: cleaned, claimedCondition: c.claimedCondition });
        if (regrade !== null) { grade = regrade.grade; probativeScore = regrade.probative_score; }
        await persistLetterGrade(db, caseId, version, regrade);
      } catch (gradeErr) {
        // Defence-in-depth: neither gradeLetterText nor persistLetterGrade should throw, but a thrown grade
        // must NEVER 500 a push whose letter already landed. Swallow with a warning (grade stays absent).
        console.warn(JSON.stringify({ msg: 'revised_letter_regrade_failed_open', caseId, version, error: gradeErr instanceof Error ? gradeErr.message : String(gradeErr) }));
      }

      res.json({ ok: true, version, warnings, verifiedPmids, grade, probativeScore });
    }),
  );

  return router;
}

// Atomic triple-artifact invariant (mirrors letter.ts assertTripleArtifacts): a LetterRevision MUST
// point at all three non-null/non-empty artifact keys. Throw 502 BEFORE any persist so a partial
// render can never produce a revision row pointing at a missing artifact. A structural belt — the keys
// are always built by buildLetterRevisionKey — but it makes the invariant impossible to regress.
function assertTripleArtifacts(
  keys: { txtKey?: string | null; pdfKey?: string | null; docxKey?: string | null },
  ctx: { caseId: string; version: number },
): asserts keys is { txtKey: string; pdfKey: string; docxKey: string } {
  const missing = (['txtKey', 'pdfKey', 'docxKey'] as const).filter((k) => typeof keys[k] !== 'string' || (keys[k] as string).trim() === '');
  if (missing.length > 0) {
    throw new HttpError(502, 'internal_error', 'Refusing to persist a letter revision with a missing artifact key.', { reason: 'partial_artifacts', caseId: ctx.caseId, version: ctx.version, missing });
  }
}
