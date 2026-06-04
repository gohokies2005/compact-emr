import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import { classifyReadAttempt } from '../services/chart-readiness.js';
import { maybeEnqueueChartExtract } from '../services/chart-extract-trigger.js';
import { applyExtractionMerge } from '../services/chart-merge-apply.js';
import { loadBundleDocuments } from '../services/chart-extract-docs.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import type { AppDb, DoctorPackState } from '../services/db-types.js';
import type { FinalExtractedItem } from '../services/chart-extract-llm.js';
import type { ExtractCategory } from '../services/chart-extractor.js';

const EXTRACT_CATEGORIES: ReadonlySet<string> = new Set(['sc_condition', 'active_problem', 'active_medication']);

/** Coerce the worker's POSTed extraction items defensively (worker is token-trusted, but validate
 *  shape + drop malformed entries rather than trust blindly). */
function coerceExtractedItems(raw: readonly unknown[]): FinalExtractedItem[] {
  const out: FinalExtractedItem[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    if (typeof r['category'] !== 'string' || !EXTRACT_CATEGORIES.has(r['category'])) continue;
    if (typeof r['name'] !== 'string' || (r['name'] as string).trim().length === 0) continue;
    if (typeof r['sourceDocumentId'] !== 'string' || typeof r['sourcePage'] !== 'number' || typeof r['sourceQuote'] !== 'string') continue;
    if (typeof r['confidence'] !== 'number') continue;
    const disposition = r['disposition'] === 'needs_review' ? 'needs_review' : 'autofill';
    out.push({
      category: r['category'] as ExtractCategory,
      name: (r['name'] as string).trim(),
      ...(typeof r['status'] === 'string' ? { status: r['status'] as FinalExtractedItem['status'] } : {}),
      ...(typeof r['dcCode'] === 'string' ? { dcCode: r['dcCode'] as string } : {}),
      ...(typeof r['ratingPct'] === 'number' ? { ratingPct: r['ratingPct'] as number } : {}),
      ...(typeof r['icd10'] === 'string' ? { icd10: r['icd10'] as string } : {}),
      ...(typeof r['dose'] === 'string' ? { dose: r['dose'] as string } : {}),
      ...(typeof r['frequency'] === 'string' ? { frequency: r['frequency'] as string } : {}),
      ...(typeof r['indication'] === 'string' ? { indication: r['indication'] as string } : {}),
      sourceDocumentId: r['sourceDocumentId'] as string,
      sourcePage: Math.trunc(r['sourcePage'] as number),
      sourceQuote: r['sourceQuote'] as string,
      confidence: Math.max(0, Math.min(1, r['confidence'] as number)),
      disposition,
      needsReview: disposition === 'needs_review',
    });
  }
  return out;
}

/**
 * Phase 7B-revised Build 3: worker callback routes.
 *
 * The OCR worker (Textract Lambda) and Doctor Pack assembler (PDF concatenation Lambda) call
 * these endpoints to:
 *   - POST per-page extracted text after Textract returns (writes to document_pages)
 *   - PATCH Document.pageCount once Textract has counted pages
 *   - PATCH DoctorPack.state transitions (queued -> generating -> ready | failed)
 *
 * All routes here require the service-principal token (see middleware/service-principal.ts).
 * NEVER exposed to end users. Mount path: /api/v1/internal/*
 */

const VALID_DOCTOR_PACK_TARGET_STATES: readonly DoctorPackState[] = ['generating', 'ready', 'failed'];

interface PageUpsertEntry {
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number | null;
}

function parsePageUpsertBody(body: unknown): { pages: readonly PageUpsertEntry[]; documentPageCount: number | null } {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const raw = body['pages'];
  if (!Array.isArray(raw)) badRequest('pages is required (array)', { field: 'pages' });
  if (raw.length === 0) badRequest('pages must contain at least one entry', { field: 'pages' });
  if (raw.length > 2000) badRequest('pages exceeds maximum of 2000 entries per request', { field: 'pages', max: 2000 });

  const pages: PageUpsertEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) badRequest('each page must be an object', { field: 'pages[]' });
    const pageNumber = item['pageNumber'];
    const text = item['text'];
    const confidence = item['confidence'];
    if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1) {
      badRequest('pageNumber must be a positive integer', { field: 'pages[].pageNumber' });
    }
    if (typeof text !== 'string') badRequest('text must be a string', { field: 'pages[].text' });
    if (text.length > 100_000) badRequest('text exceeds 100000 chars per page', { field: 'pages[].text' });
    if (confidence !== null && confidence !== undefined && typeof confidence !== 'number') {
      badRequest('confidence must be number or null', { field: 'pages[].confidence' });
    }
    pages.push({
      pageNumber,
      text: text as string,
      confidence: typeof confidence === 'number' ? confidence : null,
    });
  }

  const pageCountRaw = body['documentPageCount'];
  let documentPageCount: number | null = null;
  if (pageCountRaw !== undefined && pageCountRaw !== null) {
    if (typeof pageCountRaw !== 'number' || !Number.isInteger(pageCountRaw) || pageCountRaw < 0) {
      badRequest('documentPageCount must be a non-negative integer', { field: 'documentPageCount' });
    }
    documentPageCount = pageCountRaw as number;
  }

  return { pages, documentPageCount };
}

interface ParsedDoctorPackPatch {
  state: DoctorPackState;
  pdfS3Key?: string;
  pageCount?: number;
  errorMessage?: string;
}

function parseDoctorPackPatchBody(body: unknown): ParsedDoctorPackPatch {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const state = body['state'];
  if (typeof state !== 'string' || !(VALID_DOCTOR_PACK_TARGET_STATES as readonly string[]).includes(state)) {
    badRequest(`state must be one of: ${VALID_DOCTOR_PACK_TARGET_STATES.join(', ')}`, { field: 'state' });
  }
  const result: ParsedDoctorPackPatch = { state: state as DoctorPackState };
  const pdfS3Key = body['pdfS3Key'];
  if (pdfS3Key !== undefined && pdfS3Key !== null) {
    if (typeof pdfS3Key !== 'string' || pdfS3Key.length === 0 || pdfS3Key.length > 500) {
      badRequest('pdfS3Key must be a non-empty string under 500 chars', { field: 'pdfS3Key' });
    }
    // Task #107a: path-traversal guard on worker callback. Without this, a compromised
    // assembler could redirect the DoctorPack row to an arbitrary S3 key (cross-case
    // read, exfil, or DoS via dangling pointer). Validator rejects '..', leading '/',
    // and anything outside the doctor-packs/<caseId>/v<N>/<uuid>.pdf pattern.
    if (!isDoctorPackS3Key(pdfS3Key)) {
      badRequest('pdfS3Key does not match the safe doctor-packs/<caseId>/v<N>/<uuid>.pdf pattern', { field: 'pdfS3Key' });
    }
    result.pdfS3Key = pdfS3Key as string;
  }
  const pageCount = body['pageCount'];
  if (pageCount !== undefined && pageCount !== null) {
    if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 0) {
      badRequest('pageCount must be a non-negative integer', { field: 'pageCount' });
    }
    result.pageCount = pageCount as number;
  }
  const errorMessage = body['errorMessage'];
  if (errorMessage !== undefined && errorMessage !== null) {
    if (typeof errorMessage !== 'string') badRequest('errorMessage must be a string', { field: 'errorMessage' });
    if ((errorMessage as string).length > 2000) badRequest('errorMessage exceeds 2000 chars', { field: 'errorMessage' });
    result.errorMessage = errorMessage as string;
  }
  return result;
}

interface ParsedFailedReadAttempt {
  textractStatus: string;
  jobId: string;
  errorMessage?: string;
}

function parseFailedReadAttemptBody(body: unknown): ParsedFailedReadAttempt {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const textractStatus = body['textractStatus'];
  const jobId = body['jobId'];
  if (typeof textractStatus !== 'string' || textractStatus.length === 0 || textractStatus.length > 50) {
    badRequest('textractStatus is required (string, <=50 chars)', { field: 'textractStatus' });
  }
  if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 200) {
    badRequest('jobId is required (string, <=200 chars)', { field: 'jobId' });
  }
  const result: ParsedFailedReadAttempt = { textractStatus: textractStatus as string, jobId: jobId as string };
  const errorMessage = body['errorMessage'];
  if (errorMessage !== undefined && errorMessage !== null) {
    if (typeof errorMessage !== 'string') badRequest('errorMessage must be a string', { field: 'errorMessage' });
    if ((errorMessage as string).length > 2000) badRequest('errorMessage exceeds 2000 chars', { field: 'errorMessage' });
    result.errorMessage = errorMessage as string;
  }
  return result;
}

export function createInternalWorkerRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/internal/documents/:id/pages
   *
   * Worker callback for the OCR Textract async job. Body:
   *   { pages: [{ pageNumber, text, confidence }, ...], documentPageCount? }
   *
   * Upserts one row per page in `document_pages`, keyed by (documentId, pageNumber). Also
   * optionally patches the parent Document's `pageCount` field (the OCR worker knows this
   * once Textract returns the block index).
   *
   * Idempotent: retries of the same Textract job overwrite existing rows in place. Atomic
   * within a single $transaction so partial writes don't leave half-extracted documents.
   */
  router.post(
    '/internal/documents/:id/pages',
    asyncHandler(async (req: Request, res: Response) => {
      const documentId = String(req.params.id);
      const parsed = parsePageUpsertBody(req.body);

      const now = new Date();

      const result = await db.$transaction(async (tx) => {
        for (const page of parsed.pages) {
          await tx.documentPage.upsert({
            where: { documentId_pageNumber: { documentId, pageNumber: page.pageNumber } },
            create: {
              documentId,
              pageNumber: page.pageNumber,
              text: page.text,
              confidence: page.confidence,
            },
            update: {
              text: page.text,
              confidence: page.confidence,
              extractedAt: new Date(),
            },
          });
        }

        // Architect final QA finding #1 (REVIEW.md 0f8b64a): patch Document.pageCount so the
        // page-selector's per-file caps work meaningfully. The worker is the source of truth
        // for page count; the route's manifest builder reads from documents.page_count.
        if (parsed.documentPageCount !== null) {
          await (tx as unknown as { document: { update: (args: { where: { id: string }; data: { pageCount: number } }) => Promise<unknown> } }).document.update({
            where: { id: documentId },
            data: { pageCount: parsed.documentPageCount },
          });
        }

        // C1 (audit 2026-05-27): bridge the Textract success path into the chart-readiness
        // gate. Before this, a successful OCR wrote ONLY document_pages — never a
        // file_read_status row — so evaluateChartReadiness() never saw the file as read
        // (the gate reads file_read_status exclusively). The only writer of
        // terminalStatus='read' was POST /cases/:id/files/read-attempts, which nothing in
        // the cloud tree calls. Result: OCR failure blocked correctly, OCR success was
        // invisible (empty set => ready=true). Here we resolve the document's caseId + s3Key
        // (same join as the read-attempt-failed route below), run the concatenated page text
        // through classifyReadAttempt so a "successful" Textract job with garbled / too-few
        // words still lands as manual_summary_required (NOT a false 'read'), and upsert the
        // file_read_status row keyed (caseId, s3Key) in the SAME transaction.
        const doc = await (tx as unknown as {
          document: { findUnique: (args: { where: { id: string }; select?: Record<string, true> }) => Promise<{ id: string; caseId: string; s3Key: string } | null> };
        }).document.findUnique({
          where: { id: documentId },
          select: { id: true, caseId: true, s3Key: true },
        });

        let readStatus: { terminalStatus: string; wordCount: number; corruptedTokenRatio: number } | null = null;
        if (doc !== null) {
          const concatenatedText = parsed.pages.map((p) => p.text).join('\n');
          const outcome = classifyReadAttempt({ method: 'textract', extractedText: concatenatedText });

          const existing = await tx.fileReadStatus.findFirst({ where: { caseId: doc.caseId, filePath: doc.s3Key } });
          const newAttempt = {
            method: 'textract' as const,
            wordCount: outcome.wordCount,
            corruptedTokenRatio: outcome.corruptedTokenRatio,
            attemptedAt: now.toISOString(),
            note: outcome.succeeded
              ? `Textract read OK (${outcome.wordCount} words)`
              : `Textract read insufficient: ${outcome.reason}`,
          };
          const prior: readonly unknown[] = (existing?.attemptsJson as readonly unknown[] | undefined) ?? [];
          const attempts = [...prior, newAttempt];

          // Don't overwrite an RN's manual_summary_provided clearance (mirror the
          // read-attempt-failed route's guard). Otherwise: read on success, else
          // manual_summary_required (garbled / too-few-words).
          const terminalStatus =
            existing?.terminalStatus === 'manual_summary_provided'
              ? 'manual_summary_provided'
              : outcome.succeeded
                ? 'read'
                : 'manual_summary_required';

          if (existing) {
            await tx.fileReadStatus.update({
              where: { id: existing.id },
              data: {
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: now,
                version: { increment: 1 },
              },
            });
          } else {
            await tx.fileReadStatus.create({
              data: {
                caseId: doc.caseId,
                filePath: doc.s3Key,
                fileSha256: '',
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: now,
              },
            });
          }
          readStatus = { terminalStatus, wordCount: outcome.wordCount, corruptedTokenRatio: outcome.corruptedTokenRatio };
        }

        await tx.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.WORKER,
            action: 'document_pages_extracted',
            ...(doc !== null ? { caseId: doc.caseId } : {}),
            detailsJson: {
              documentId,
              pageCount: parsed.pages.length,
              ...(parsed.documentPageCount !== null && { documentPageCount: parsed.documentPageCount }),
              ...(readStatus !== null && { readTerminalStatus: readStatus.terminalStatus, readWordCount: readStatus.wordCount }),
            },
          },
        });

        return {
          documentId,
          caseId: doc !== null ? doc.caseId : null,
          pagesUpserted: parsed.pages.length,
          documentPageCount: parsed.documentPageCount,
          ...(readStatus !== null && { readTerminalStatus: readStatus.terminalStatus }),
        };
      },
      // A 1,182-page Blue Button means 1,182 sequential upserts + the readiness logic, all in one
      // interactive transaction. Prisma's default 5s timeout would roll the whole commit back
      // (P2028) on a big record — trading the old PayloadTooLarge for a different 500. Raise the
      // ceiling so large legitimate records commit. (2026-06-03, with the 50mb body-limit fix.)
      { timeout: 30_000, maxWait: 10_000 });

      // Chart auto-extract trigger. Runs AFTER the page-write transaction has COMMITTED, in a
      // log-only try/catch: an enqueue/latch failure can never roll back or affect the OCR write
      // above. Fires exactly once per (case, doc-set) once all docs are OCR-terminal. (2026-06-03)
      if (result.caseId !== null) {
        try {
          await maybeEnqueueChartExtract(db, result.caseId);
        } catch (err) {
          console.error(JSON.stringify({
            msg: 'chart_extract_enqueue_failed',
            documentId,
            caseId: result.caseId,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }

      res.status(201).json({ data: result });
    }),
  );

  /**
   * GET /api/v1/internal/documents/by-s3-key?key=<urlencoded s3Key>
   *
   * The OCR worker (start_handler) only has the S3 object key from the EventBridge event —
   * the upload key `cases/<caseId>/<uuid>-<filename>` embeds NO documentId (the Document row
   * id is minted after the key is chosen). The worker calls this to resolve the real
   * documentId, which it then stamps as the Textract JobTag so the completion callback can
   * post pages/failures to the right document.
   *
   * Returns { data: { documentId, caseId, s3Key } } or 404 if no Document has that s3Key.
   */
  router.get(
    '/internal/documents/by-s3-key',
    asyncHandler(async (req: Request, res: Response) => {
      const key = req.query['key'];
      if (typeof key !== 'string' || key.length === 0) {
        badRequest('key query parameter is required', { field: 'key' });
        return;
      }
      const doc = await (db as unknown as {
        document: { findFirst: (args: { where: { s3Key: string }; select?: Record<string, true> }) => Promise<{ id: string; caseId: string; s3Key: string } | null> };
      }).document.findFirst({
        where: { s3Key: key },
        select: { id: true, caseId: true, s3Key: true },
      });
      if (doc === null) {
        throw new HttpError(404, 'not_found', 'No document found for that s3Key', { s3Key: key });
      }
      res.json({ data: { documentId: doc.id, caseId: doc.caseId, s3Key: doc.s3Key } });
    }),
  );

  /**
   * PATCH /api/v1/internal/doctor-packs/:id
   *
   * Worker callback for the Doctor Pack assembler. Body:
   *   { state: 'generating' | 'ready' | 'failed', pdfS3Key?, pageCount?, errorMessage? }
   *
   * Only forward state transitions allowed:
   *   queued -> generating
   *   generating -> ready
   *   generating -> failed
   *
   * On 'ready': stamps `generatedAt`, requires `pdfS3Key`. On 'failed': requires
   * `errorMessage`. Activity row written for every transition.
   */
  router.patch(
    '/internal/doctor-packs/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const parsed = parseDoctorPackPatchBody(req.body);

      const existing = await db.doctorPack.findUnique({ where: { id } });
      if (existing === null) throw new HttpError(404, 'not_found', 'DoctorPack not found', { doctorPackId: id });

      const validTransitions: Record<string, readonly DoctorPackState[]> = {
        queued: ['generating'],
        generating: ['ready', 'failed'],
        ready: [],
        failed: [],
      };
      const allowed = validTransitions[existing.state] ?? [];
      if (!allowed.includes(parsed.state)) {
        throw new HttpError(409, 'conflict', `Invalid state transition: ${existing.state} -> ${parsed.state}`, {
          doctorPackId: id,
          currentState: existing.state,
          requestedState: parsed.state,
          allowedTargets: allowed,
        });
      }

      if (parsed.state === 'ready' && parsed.pdfS3Key === undefined) {
        throw new HttpError(400, 'bad_request', 'state=ready requires pdfS3Key', { field: 'pdfS3Key' });
      }
      if (parsed.state === 'failed' && parsed.errorMessage === undefined) {
        throw new HttpError(400, 'bad_request', 'state=failed requires errorMessage', { field: 'errorMessage' });
      }

      // Task #107a: confirm-only, no-redirect. At POST /generate the server computed the
      // canonical s3Key and wrote it to the row + the SQS body. The worker's PATCH should
      // pass that SAME key back as a sanity check. If it doesn't match, treat as tampering
      // and reject — never let a worker repoint the row at an arbitrary key.
      if (parsed.pdfS3Key !== undefined && existing.pdfS3Key !== null && existing.pdfS3Key !== '' && parsed.pdfS3Key !== existing.pdfS3Key) {
        throw new HttpError(409, 'conflict', 'Worker pdfS3Key does not match the server-computed key on the DoctorPack row.', {
          doctorPackId: id,
          expected: existing.pdfS3Key,
          provided: parsed.pdfS3Key,
        });
      }

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.doctorPack.update({
          where: { id },
          data: {
            state: parsed.state,
            ...(parsed.pdfS3Key !== undefined ? { pdfS3Key: parsed.pdfS3Key } : {}),
            ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
            ...(parsed.errorMessage !== undefined ? { errorMessage: parsed.errorMessage } : {}),
            ...(parsed.state === 'ready' ? { generatedAt: new Date() } : {}),
            version: { increment: 1 },
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.WORKER,
            action: 'doctor_pack_state_changed',
            caseId: existing.caseId,
            detailsJson: {
              doctorPackId: id,
              from: existing.state,
              to: parsed.state,
              ...(parsed.errorMessage !== undefined && { errorMessage: parsed.errorMessage }),
            },
          },
        });
        return row;
      });

      res.json({ data: updated });
    }),
  );

  /**
   * POST /api/v1/internal/documents/:id/read-attempt-failed
   *
   * Architect final QA finding #3 (REVIEW.md 0f8b64a): when Textract returns
   * status != SUCCEEDED, the OCR worker calls this so the file lands in
   * file_read_status with terminalStatus='manual_summary_required'. Without this,
   * Textract failures silently stall the pipeline because no FileReadStatus row
   * ever gets the failed-attempt note.
   *
   * Body: { textractStatus, jobId, errorMessage? }
   *
   * The route resolves the documentId → its parent caseId server-side (the worker
   * doesn't have the caseId without a round-trip; this saves the trip). On success,
   * upserts/creates a FileReadStatus row keyed by (caseId, filePath) where filePath
   * is the document's s3Key. terminalStatus = 'manual_summary_required'.
   */
  router.post(
    '/internal/documents/:id/read-attempt-failed',
    asyncHandler(async (req: Request, res: Response) => {
      const documentId = String(req.params.id);
      const parsed = parseFailedReadAttemptBody(req.body);

      // Resolve documentId → caseId + s3Key + sha256-if-present. Cast through unknown
      // because the Document delegate is not declared on the AppDb interface (it's
      // accessed read-side through Case.documents in other routes).
      const doc = await (db as unknown as {
        document: { findUnique: (args: { where: { id: string }; select?: Record<string, true> }) => Promise<{ id: string; caseId: string; s3Key: string } | null> };
      }).document.findUnique({
        where: { id: documentId },
        select: { id: true, caseId: true, s3Key: true },
      });
      if (doc === null) {
        throw new HttpError(404, 'not_found', 'Document not found', { documentId });
      }

      const now = new Date();
      const noteText = parsed.errorMessage
        ? `Textract ${parsed.textractStatus} (job ${parsed.jobId}): ${parsed.errorMessage.slice(0, 500)}`
        : `Textract ${parsed.textractStatus} (job ${parsed.jobId})`;

      const result = await db.$transaction(async (tx) => {
        const existing = await tx.fileReadStatus.findFirst({ where: { caseId: doc.caseId, filePath: doc.s3Key } });
        const newAttempt = {
          method: 'textract' as const,
          wordCount: 0,
          corruptedTokenRatio: 0,
          attemptedAt: now.toISOString(),
          note: noteText,
        };
        const prior: readonly unknown[] = (existing?.attemptsJson as readonly unknown[] | undefined) ?? [];
        const attempts = [...prior, newAttempt];

        // Don't overwrite a manual_summary_provided state — that's the RN's clearance.
        const terminalStatus =
          existing?.terminalStatus === 'manual_summary_provided'
            ? 'manual_summary_provided'
            : 'manual_summary_required';

        const row = existing
          ? await tx.fileReadStatus.update({
              where: { id: existing.id },
              data: {
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: now,
                version: { increment: 1 },
              },
            })
          : await tx.fileReadStatus.create({
              data: {
                caseId: doc.caseId,
                filePath: doc.s3Key,
                fileSha256: '',
                terminalStatus,
                attemptsJson: attempts,
                lastCheckedAt: now,
              },
            });

        await tx.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.WORKER,
            action: 'file_read_textract_failed',
            caseId: doc.caseId,
            detailsJson: {
              documentId,
              caseId: doc.caseId,
              filePath: doc.s3Key,
              textractStatus: parsed.textractStatus,
              jobId: parsed.jobId,
              ...(parsed.errorMessage !== undefined && { errorMessage: parsed.errorMessage }),
            },
          },
        });

        return row;
      });

      res.status(201).json({ data: result });
    }),
  );

  /**
   * POST /api/v1/internal/cases/:caseId/extracted-chart-items
   *
   * The chart-extract worker POSTs its grounded extraction here. This is the SINGLE writer of
   * source='extracted' chart rows. Always records the run (result_json + status=complete + counts);
   * writes chart rows only when CHART_AUTOFILL='on' (shadow mode otherwise). Body:
   *   { runId: string, items: FinalExtractedItem[], costUsd?: number }
   */
  router.post(
    '/internal/cases/:caseId/extracted-chart-items',
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const body = req.body;
      if (!isRecord(body)) { badRequest('Request body must be an object'); return; }
      const runId = body['runId'];
      if (typeof runId !== 'string' || runId.length === 0) { badRequest('runId is required', { field: 'runId' }); return; }
      const rawItems = body['items'];
      if (!Array.isArray(rawItems)) { badRequest('items is required (array)', { field: 'items' }); return; }
      if (rawItems.length > 500) { badRequest('items exceeds maximum of 500', { field: 'items', max: 500 }); return; }
      const costUsd = typeof body['costUsd'] === 'number' ? (body['costUsd'] as number) : undefined;

      const c = await (db as unknown as {
        case: { findFirst: (a: { where: { id: string }; select: { veteranId: true } }) => Promise<{ veteranId: string } | null> };
      }).case.findFirst({ where: { id: caseId }, select: { veteranId: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const items = coerceExtractedItems(rawItems);
      const result = await applyExtractionMerge(db, { caseId, veteranId: c.veteranId, runId, items, costUsd });
      res.json({ data: result });
    }),
  );

  /**
   * GET /api/v1/internal/cases/:caseId/extract-documents
   * The chart-extract worker pulls the case's documents + OCR'd pages here (so the worker needs no
   * Prisma — it stays a lightweight HTTP+LLM Lambda), runs the extractor, and POSTs results to
   * .../extracted-chart-items.
   */
  router.get(
    '/internal/cases/:caseId/extract-documents',
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const documents = await loadBundleDocuments(db, caseId);
      res.json({ data: { caseId, documents } });
    }),
  );

  /**
   * POST /api/v1/internal/cases/:caseId/chart-extract-failed  { runId, error? }
   * Worker marks a run failed so the build-state derivation shows extract_failed (a retry message),
   * never a stuck "still building" — no silent dead-end.
   */
  router.post(
    '/internal/cases/:caseId/chart-extract-failed',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isRecord(body)) { badRequest('Request body must be an object'); return; }
      const runId = body['runId'];
      if (typeof runId !== 'string' || runId.length === 0) { badRequest('runId is required', { field: 'runId' }); return; }
      const errorMessage = typeof body['error'] === 'string' ? (body['error'] as string).slice(0, 2000) : 'extraction failed';
      await (db as unknown as {
        chartExtractionRun: { update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> };
      }).chartExtractionRun.update({ where: { id: runId }, data: { status: 'failed', errorMessage, completedAt: new Date() } });
      res.json({ data: { runId, status: 'failed' } });
    }),
  );

  // PATCH /internal/intakes/:id — the jotform-ingest worker reports completion. On success it sets
  // status=ready + the parsed fields + the file manifest (the worker is the sole writer of these,
  // per spec §2/P1-6). On failure it sets status=failed + errorMessage (surfaced to the RN with a
  // Retry button — never a silent drop). Only a 'pending' intake may transition. (Service principal.)
  router.patch(
    '/internal/intakes/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = body['status'];
      if (status !== 'ready' && status !== 'failed') {
        throw new HttpError(400, 'bad_request', "status must be 'ready' or 'failed'", { field: 'status' });
      }
      const existing = await db.intake.findUnique({ where: { id } });
      if (existing === null) throw new HttpError(404, 'not_found', 'Intake not found', { intakeId: id });

      if (status === 'failed') {
        const errorMessage = typeof body['errorMessage'] === 'string' ? (body['errorMessage'] as string).slice(0, 2000) : 'ingest failed';
        const updated = await db.intake.update({ where: { id }, data: { status: 'failed', errorMessage } });
        res.json({ data: updated });
        return;
      }

      // status === 'ready' — accept the parsed fields + file manifest the worker fetched by ID.
      const data: Record<string, unknown> = { status: 'ready', errorMessage: null };
      const strOrUndef = (k: string): string | undefined => (typeof body[k] === 'string' && (body[k] as string).length > 0 ? (body[k] as string) : undefined);
      const name = strOrUndef('submittedName'); if (name !== undefined) data['submittedName'] = name;
      const email = strOrUndef('submittedEmail'); if (email !== undefined) data['submittedEmail'] = email;
      const phone = strOrUndef('submittedPhone'); if (phone !== undefined) data['submittedPhone'] = phone;
      const state = strOrUndef('submittedState'); if (state !== undefined) data['submittedState'] = (state as string).slice(0, 2).toUpperCase();
      const condition = strOrUndef('submittedCondition'); if (condition !== undefined) data['submittedCondition'] = condition;
      if (Array.isArray(body['fileManifest'])) data['fileManifestJson'] = body['fileManifest'];
      if (body['rawAnswers'] !== undefined && body['rawAnswers'] !== null) data['rawAnswersJson'] = body['rawAnswers'];
      if (typeof body['submittedAt'] === 'string') {
        const d = new Date(body['submittedAt'] as string);
        if (!Number.isNaN(d.getTime())) data['submittedAt'] = d;
      }
      const updated = await db.intake.update({ where: { id }, data });
      res.json({ data: updated });
    }),
  );

  return router;
}
