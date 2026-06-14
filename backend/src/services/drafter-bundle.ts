import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { evaluateChartReadiness } from './chart-readiness.js';
import { deriveChartBuildState, type ChartBuildState } from './chart-build-state.js';
import type { AppDb } from './db-types.js';
import type { CaseFraming } from './case-framing.js';
import type { CaseViability } from './case-viability.js';

/**
 * Architect QA F1: drafter materialization bundle.
 *
 * The drafter wrapper running on Fargate needs everything in one read: case + veteran +
 * granted SC list + active problems + meds + chart notes + key-doc index + per-document
 * OCR'd text + Doctor Pack manifest. On large cases this is 10-50 MB JSON — past
 * HttpApi/Lambda payload limits (6-10 MB hard cap).
 *
 * Solution: write the bundle JSON to S3 once per draft job, hand the wrapper the S3 key.
 * The wrapper reads from S3 directly using its Fargate task role's phiBucket read grant.
 * The GET /drafter-export endpoint returns a presigned URL for human ops/debugging.
 */

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 min — plenty for the wrapper to grab
const BUNDLE_SIZE_WARN_BYTES = 150 * 1024 * 1024; // 150 MB soft cap (Ryan, 2026-05-26)

/**
 * F1a typed errors (architect followup). Replaces string-prefix matching in routes —
 * `err instanceof CaseNotFoundError` is contract; `err.message.startsWith('Case not found')`
 * silently breaks if the message wording changes.
 */
export class CaseNotFoundError extends Error {
  constructor(public readonly caseId: string) {
    super(`Case not found: ${caseId}`);
    this.name = 'CaseNotFoundError';
  }
}

export class VeteranNotFoundError extends Error {
  constructor(public readonly veteranId: string) {
    super(`Veteran not found: ${veteranId}`);
    this.name = 'VeteranNotFoundError';
  }
}

let cachedClient: S3Client | null = null;

function getS3Client(): S3Client {
  if (cachedClient !== null) return cachedClient;
  cachedClient = new S3Client({});
  return cachedClient;
}

export interface DrafterBundle {
  readonly case: unknown;
  readonly veteran: unknown;
  readonly scConditions: readonly unknown[];
  readonly activeProblems: readonly unknown[];
  readonly activeMedications: readonly unknown[];
  readonly chartNotes: readonly unknown[];
  readonly keyDocs: readonly unknown[];
  readonly fileReadStatuses: readonly unknown[];
  readonly documents: readonly unknown[];
  readonly chartReadiness: {
    readonly ready: boolean;
    readonly manualSummaryRequired: number;
    // Real extraction phase for THIS case (deriveChartBuildState). `ready` is OCR-only; this lets the
    // Fargate drafter REFUSE on a failed/reaped/incomplete extraction (Bonnewitz) instead of trusting
    // the worker's fabricated stage2_semantic:'done'. Only 'chart_ready' is safe to draft on.
    readonly extractionState: ChartBuildState;
    // Extraction gap counts (P2-3, doc-set closure + sweep hardening, 2026-06-14). When the latest run
    // is `complete_with_gaps` the chart drafted on a chart the extractor could not fully read (windows
    // truncated / pages never covered). The RN sees a banner (chart-readiness route); the drafter saw
    // NOTHING. Carry the worker-recorded counts (mirrors chart-readiness.ts gap read) so the letter's
    // provenance can note a gapped chart. null = no gaps (or status !== complete_with_gaps).
    readonly extractionGaps: { readonly truncatedWindows: number; readonly uncoveredPages: number } | null;
  };
  readonly doctorPack: unknown;
  readonly activeJob: unknown;
  readonly bundleMeta: {
    readonly generatedAt: string;
    readonly schemaVersion: '2';
  };
  /**
   * SSOT case framing (caseFraming.v1.schema.json) — stamped at ROUTE level by
   * case-framing-stamp.ts, never by buildDrafterBundle (which stays pure-read).
   * Optional: absence = consumers fail-open to their legacy derivations.
   */
  readonly caseFraming?: CaseFraming;
  /**
   * SSOT anchor viability (caseViability.v1.schema.json) — SIBLING block to caseFraming, stamped
   * at ROUTE level by case-viability-stamp.ts in the same pass, DARK behind
   * EMR_CASE_VIABILITY_ENABLED. Worker copy-through (build plan §3.4): the Fargate drafter
   * wrapper reads bundle.caseViability if present; absence = legacy.
   */
  readonly caseViability?: CaseViability;
}

/**
 * Fetch every piece of state the drafter wrapper needs. Pure read; no mutations.
 */
export async function buildDrafterBundle(db: AppDb, caseId: string): Promise<DrafterBundle> {
  const c = await db.case.findFirst({ where: { id: caseId } });
  if (c === null) throw new CaseNotFoundError(caseId);
  const cw = c as typeof c & { veteranId: string };

  const veteran = await (db as unknown as {
    veteran: { findUnique: (args: { where: { id: string } }) => Promise<unknown> };
  }).veteran.findUnique({ where: { id: cw.veteranId } });
  if (veteran === null) throw new VeteranNotFoundError(cw.veteranId);

  // Returning-customer document reuse (Ryan 2026-06-04): a veteran's documents are parsed once and
  // stay useful across claims ("all files might have something hidden useful"). So the drafter
  // bundle pulls documents + their already-extracted pages across ALL of this veteran's cases, not
  // just the current one — no re-upload, no re-OCR. keyDocs stay case-scoped (per-case curation);
  // the drafter still has every page. chartReadiness below is computed from THIS case's files only
  // (empty file set = ready) so a new case is never blocked by an unrelated prior case's files.
  const veteranCaseRows = await db.case.findMany({ where: { veteranId: cw.veteranId }, select: { id: true } });
  const veteranCaseIds = veteranCaseRows.map((r) => r.id);

  const [
    scConditions,
    activeProblems,
    activeMedications,
    chartNotes,
    keyDocs,
    fileReadStatuses,
    documents,
    latestDoctorPack,
    activeJob,
    latestExtractionRun,
  ] = await Promise.all([
    (db as unknown as { scCondition: { findMany: (args: { where: { veteranId: string } }) => Promise<unknown[]> } })
      .scCondition.findMany({ where: { veteranId: cw.veteranId } }),
    db.activeProblem.findMany({ where: { veteranId: cw.veteranId } }),
    (db as unknown as { activeMedication: { findMany: (args: { where: { veteranId: string } }) => Promise<unknown[]> } })
      .activeMedication.findMany({ where: { veteranId: cw.veteranId } }),
    (db as unknown as { chartNote: { findMany: (args: { where: { veteranId: string }; orderBy: { createdAt: 'asc' } }) => Promise<unknown[]> } })
      .chartNote.findMany({ where: { veteranId: cw.veteranId }, orderBy: { createdAt: 'asc' } }),
    (db as unknown as { keyDoc: { findMany: (args: { where: { caseId: string } }) => Promise<unknown[]> } })
      .keyDoc.findMany({ where: { caseId } }),
    // Veteran-scoped: read status for every file across the veteran's cases (carries manual
    // summaries for inherited docs). chartReadiness is recomputed from this case's subset below.
    db.fileReadStatus.findMany({ where: { caseId: { in: veteranCaseIds } } }),
    (db as unknown as {
      document: {
        findMany: (args: {
          where: { caseId: { in: string[] } };
          include: { pages: { orderBy: { pageNumber: 'asc' } } };
        }) => Promise<unknown[]>;
      };
    }).document.findMany({
      // Veteran-scoped: all of this veteran's already-parsed documents (+ pages) across cases.
      where: { caseId: { in: veteranCaseIds } },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    }),
    db.doctorPack.findFirst({
      where: { caseId, state: 'ready' },
      orderBy: { generatedAt: 'desc' },
    }),
    db.draftJob.findFirst({
      where: { caseId, state: { in: ['queued', 'running'] as const } },
      orderBy: { enqueuedAt: 'desc' },
    }),
    // THIS case's latest extraction run, for the real build-state (extractionState below). Scoped to
    // caseId (not the veteran) — a prior case's failed run must not taint this draft.
    // resultJson added (P2-3, 2026-06-14): carries the worker-recorded gap counts for a
    // complete_with_gaps run so the drafter (not just the RN banner) learns the chart was gapped.
    (db as unknown as {
      chartExtractionRun: { findFirst: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { triggerHash: true; status: true; resultJson: true } }) => Promise<{ triggerHash: string; status: string; resultJson: unknown } | null> };
    }).chartExtractionRun.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { triggerHash: true, status: true, resultJson: true } }),
  ]);

  // Gate on THIS case's own files only (empty set = ready). The bundle payload still carries the
  // veteran-wide fileReadStatuses above so the drafter can use inherited manual summaries; a prior
  // case's unresolved file must not block this case's draft. (Ryan 2026-06-04 returning-customer.)
  const thisCaseReadStatuses = fileReadStatuses.filter((r) => r.caseId === caseId);
  const chartReadiness = evaluateChartReadiness(thisCaseReadStatuses);
  // Real extraction phase for this case (no_documents | ocr_in_progress | extracting | chart_ready |
  // extract_failed). The drafter must refuse on anything but chart_ready (Bonnewitz failed-extract).
  const buildStateDocs = (documents as ReadonlyArray<{ id: string; s3Key: string; caseId: string }>)
    .filter((d) => d.caseId === caseId)
    .map((d) => ({ id: d.id, s3Key: d.s3Key }));
  const extractionState = deriveChartBuildState(
    buildStateDocs,
    thisCaseReadStatuses.map((r) => ({ filePath: r.filePath, terminalStatus: r.terminalStatus })),
    latestExtractionRun,
  ).state;
  // Extraction gap counts (P2-3, 2026-06-14). Mirrors chart-readiness.ts:175-178 exactly: only a
  // `complete_with_gaps` run with a gaps block surfaces counts; everything else is null. The drafter
  // can then note a gapped chart in the letter provenance instead of silently drafting on a partial read.
  const rj = latestExtractionRun?.resultJson as { gaps?: { truncatedWindows?: number; uncoveredPages?: number } } | null | undefined;
  const extractionGaps = (latestExtractionRun?.status === 'complete_with_gaps' && rj?.gaps)
    ? { truncatedWindows: Number(rj.gaps.truncatedWindows ?? 0), uncoveredPages: Number(rj.gaps.uncoveredPages ?? 0) }
    : null;

  return {
    case: {
      id: c.id,
      veteranId: cw.veteranId,
      claimedCondition: c.claimedCondition,
      // Full clustered-claim set (schemaVersion 2). The drafter argues every condition in one
      // letter; claimedCondition (singular) stays the primary for the drafter's primary section.
      claimedConditions: c.claimedConditions,
      claimType: c.claimType,
      framingChoice: c.framingChoice,
      upstreamScCondition: c.upstreamScCondition,
      veteranStatement: c.veteranStatement,
      inServiceEvent: c.inServiceEvent,
      status: c.status,
      currentVersion: c.currentVersion,
      // CDS is unwired by default (Ryan 2026-06-03). When off, a persisted verdict is STALE and
      // unviewable/unoverridable (panel removed) — and the cloud drafter seeds letter confidence
      // from it. Neutralize it at this read boundary so a legacy 'accept'/'reject' can't silently
      // bias the cloud draft. Flip CDS_ENABLED='on' to carry it again. (architect MF-1)
      cdsVerdict: process.env['CDS_ENABLED'] === 'on' ? c.cdsVerdict : 'not_yet_run',
      cdsRationale: process.env['CDS_ENABLED'] === 'on' ? c.cdsRationale : null,
    },
    veteran,
    scConditions,
    activeProblems,
    activeMedications,
    chartNotes,
    keyDocs,
    fileReadStatuses,
    documents,
    chartReadiness: {
      ready: chartReadiness.ready,
      manualSummaryRequired: chartReadiness.manualSummaryRequired,
      extractionState,
      extractionGaps,
    },
    doctorPack: latestDoctorPack,
    activeJob,
    bundleMeta: {
      generatedAt: new Date().toISOString(),
      schemaVersion: '2',
    },
  };
}

/**
 * Compute the S3 key for a per-job bundle (referenced from DraftJob.bundleS3Key + SQS msg).
 * Path-safe caseId — same defensive sanitization as the Doctor Pack key builder.
 */
export function buildJobBundleS3Key(caseId: string, jobId: string): string {
  const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `drafter-exports/${safeCaseId}/${jobId}.json`;
}

/**
 * Compute an ad-hoc S3 key for a manual GET /drafter-export inspection. Includes the
 * timestamp so multiple inspections don't collide.
 */
export function buildManualBundleS3Key(caseId: string): string {
  const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `drafter-exports/${safeCaseId}/manual-${ts}.json`;
}

/**
 * F1b S3 lifecycle tagging (Ryan 2026-05-26): manual exports get bundle-kind=manual which
 * the PhiBucket's lifecycle rule auto-deletes after 14 days. Per-job exports get
 * bundle-kind=job (no expiry — kept indefinitely as medical-legal audit evidence per
 * Ryan's retention policy).
 */
export type BundleKind = 'job' | 'manual';

export async function writeBundleToS3(
  bucket: string,
  s3Key: string,
  bundle: DrafterBundle,
  kind: BundleKind,
  client?: S3Client,
): Promise<{ s3Key: string; sizeBytes: number; warnedLargeBundle: boolean }> {
  const s3 = client ?? getS3Client();
  const body = JSON.stringify(bundle);
  const sizeBytes = Buffer.byteLength(body, 'utf8');
  // F1c soft-cap warning (Ryan 2026-05-26): non-rejecting visibility — large bundles still
  // upload (S3 PutObject single-shot caps at 5 GB) but we want CloudWatch signal before a
  // case hits a real problem. Threshold 150 MB per Ryan's recall of seeing file sizes that
  // large on actual cases.
  const warnedLargeBundle = sizeBytes > BUNDLE_SIZE_WARN_BYTES;
  if (warnedLargeBundle) {
    console.warn(JSON.stringify({
      msg: 'drafter-bundle: large bundle warning',
      s3Key,
      sizeBytes,
      thresholdBytes: BUNDLE_SIZE_WARN_BYTES,
      kind,
    }));
  }
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: body,
    ContentType: 'application/json',
    ServerSideEncryption: 'aws:kms',
    Tagging: `bundle-kind=${kind}`,
  }));
  return { s3Key, sizeBytes, warnedLargeBundle };
}

export async function presignBundleUrl(
  bucket: string,
  s3Key: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  client?: S3Client,
): Promise<{ url: string; expiresAt: string; ttlSeconds: number }> {
  const s3 = client ?? getS3Client();
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
    expiresIn: ttlSeconds,
  });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return { url, expiresAt, ttlSeconds };
}
