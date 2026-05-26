import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import type { AppDb, DoctorPackState } from '../services/db-types.js';

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

        await tx.activityLog.create({
          data: {
            actorUserId: 'service:worker',
            action: 'document_pages_extracted',
            detailsJson: {
              documentId,
              pageCount: parsed.pages.length,
              ...(parsed.documentPageCount !== null && { documentPageCount: parsed.documentPageCount }),
            },
          },
        });

        return { documentId, pagesUpserted: parsed.pages.length, documentPageCount: parsed.documentPageCount };
      });

      res.status(201).json({ data: result });
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
            actorUserId: 'service:worker',
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
            actorUserId: 'service:worker',
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

  return router;
}
