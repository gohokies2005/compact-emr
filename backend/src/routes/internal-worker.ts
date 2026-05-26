import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
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

  return router;
}
