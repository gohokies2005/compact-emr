import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { badRequest, isRecord } from '../services/validation-helpers.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import { classifyReadAttempt } from '../services/chart-readiness.js';
import { applyExtractionMerge } from '../services/chart-merge-apply.js';
import { loadBundleDocuments } from '../services/chart-extract-docs.js';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { writeScreeningSummary } from '../services/screening-summary-write.js';
import type { ScreeningResult } from '../services/chart-extract-llm.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { refreshDerivedStamps } from '../services/case-stamp-refresh.js';
import { deriveIntakeFields } from '../services/intake-derive.js';
import { deriveFramingFromEvidence } from '../services/case-framing.js';
import { writeDocumentPages } from '../services/document-pages-writer.js';
import { candidateAddresses, decideVeteranMatch, deriveEmailId, makeSnippet, normalizeEmailAddress } from '../services/email-matching.js';
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
      // Medication temporality (Ryan 2026-06-13). MUST pass through here — the writer + the
      // (drug,status,year) dedup key depend on these. Dropping them writes every med as 'active'
      // and collapses the treatment timeline at merge (architect pre-flip BLOCKER).
      ...(typeof r['medStatus'] === 'string' ? { medStatus: r['medStatus'] as FinalExtractedItem['medStatus'] } : {}),
      ...(typeof r['startDate'] === 'string' ? { startDate: r['startDate'] as string } : {}),
      ...(typeof r['lastSeenDate'] === 'string' ? { lastSeenDate: r['lastSeenDate'] as string } : {}),
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

/** Coerce the worker's POSTed screenings defensively (token-trusted, but validate shape). */
function coerceScreeningPayload(raw: readonly unknown[]): ScreeningResult[] {
  const out: ScreeningResult[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    if (typeof r['instrument'] !== 'string' || (r['instrument'] as string).trim().length === 0) continue;
    if (typeof r['sourcePage'] !== 'number' || typeof r['sourceQuote'] !== 'string') continue;
    out.push({
      instrument: (r['instrument'] as string).trim(),
      score: typeof r['score'] === 'string' ? r['score'] : typeof r['score'] === 'number' ? String(r['score']) : '',
      date: typeof r['date'] === 'string' && (r['date'] as string).trim().length > 0 ? (r['date'] as string).trim() : null,
      sourceDocumentId: typeof r['sourceDocumentId'] === 'string' ? (r['sourceDocumentId'] as string) : '',
      sourcePage: Math.trunc(r['sourcePage'] as number),
      sourceQuote: r['sourceQuote'] as string,
      confidence: typeof r['confidence'] === 'number' ? Math.max(0, Math.min(1, r['confidence'] as number)) : 1,
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
      // Single-source side-effect (extracted to document-pages-writer.ts so the parse-at-intake
      // assign path copies text forward through the EXACT same pages + readiness-bridge + chart-
      // extract logic — #8 v2). Behavior is byte-for-byte the prior inline transaction.
      const result = await writeDocumentPages(db, documentId, parsed.pages, parsed.documentPageCount);
      res.status(201).json({ data: result });
    }),
  );

  /**
   * POST /api/v1/internal/emails/ingest — Feature B inbound email ingest (gmail-ingest Lambda).
   * Body: { messageId, mailbox, subject, body, fromAddress, toAddress, toAddresses?, ccAddresses?,
   *         frnAddresses?, receivedAt?, rawS3Key?, attachments? }.
   * IDEMPOTENT (architect C3/C4): the row id derives from the Message-ID, so a retry / a copy from a
   * second monitored mailbox collides on the PK or the message_id unique → we return {deduped:true}
   * (200) and LOG the dropped mailbox (C2 — never a silent skip). Matching (architect I1): normalized,
   * non-FRN party only, NEVER auto-assign on >1-veteran ambiguity → unmatched queue.
   */
  router.post(
    '/internal/emails/ingest',
    asyncHandler(async (req: Request, res: Response) => {
      const b = req.body;
      if (!isRecord(b)) { badRequest('Request body must be an object'); return; }
      const str = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');
      const arr = (k: string): string[] => (Array.isArray(b[k]) ? (b[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      const messageId = str('messageId').trim();
      if (!messageId) { badRequest('messageId is required', { field: 'messageId' }); return; }
      const id = deriveEmailId(messageId);

      // Resolve the veteran (or leave unmatched). Candidate = non-FRN addresses on From+To+Cc.
      const candidates = candidateAddresses({ from: str('fromAddress'), to: [str('toAddress'), ...arr('toAddresses')], cc: arr('ccAddresses'), frnAddresses: [str('mailbox'), ...arr('frnAddresses')] });
      const byAddr = new Map<string, { id: string }[]>();
      for (const addr of candidates) {
        const vets = await db.veteran.findMany({ where: { email: { equals: addr, mode: 'insensitive' }, inactive: false }, select: { id: true } });
        byAddr.set(addr, (vets as { id: string }[]).map((v) => ({ id: v.id })));
      }
      const match = decideVeteranMatch(candidates, (addr) => byAddr.get(normalizeEmailAddress(addr)) ?? byAddr.get(addr) ?? []);
      const veteranId = match.status === 'matched' ? match.veteranId : null;

      const body = str('body');
      const receivedAt = str('receivedAt') ? new Date(str('receivedAt')) : new Date();
      const attachments = Array.isArray(b['attachments']) ? b['attachments'] : [];
      try {
        const row = await db.email.create({
          data: {
            id, messageId, veteranId, caseId: null, direction: 'inbound',
            subject: str('subject'), body, snippet: makeSnippet(body),
            fromAddress: str('fromAddress'), toAddress: str('toAddress'), mailbox: str('mailbox') || null,
            receivedAt, status: 'received',
            ...(str('rawS3Key') ? { rawS3Key: str('rawS3Key') } : {}),
            ...(attachments.length ? { attachmentsJson: attachments } : {}),
          },
          select: { id: true, veteranId: true },
        });
        await db.activityLog.create({ data: { actorUserId: SERVICE_ACTORS.DRAFTER, action: 'email_ingested', veteranId: row.veteranId ?? undefined, detailsJson: { emailId: id, mailbox: str('mailbox'), match: match.status, ...(match.status === 'unmatched' ? { reason: match.reason } : {}) } } });
        res.status(201).json({ data: { emailId: id, deduped: false, match: match.status, veteranId: row.veteranId } });
      } catch (e) {
        const isP2002 = typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';
        if (!isP2002) throw e;
        // Same Message-ID already ingested (a retry, or the message also landed in another monitored
        // mailbox). Surface the dropped mailbox so the dedupe is observable, never a silent skip (C2).
        await db.activityLog.create({ data: { actorUserId: SERVICE_ACTORS.DRAFTER, action: 'email_ingest_deduped', detailsJson: { emailId: id, droppedMailbox: str('mailbox') } } });
        res.json({ data: { emailId: id, deduped: true } });
      }
    }),
  );

  // GET /api/v1/internal/monitored-mailboxes — the gmail-ingest poller asks which mailboxes to poll
  // (the in-EMR admin list, active only). Replaces the SSM-parameter approach with the DB-backed list.
  router.get(
    '/internal/monitored-mailboxes',
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await db.monitoredMailbox.findMany({ where: { active: true }, select: { address: true } });
      res.json({ data: rows.map((r) => r.address) });
    }),
  );

  // ===== Parse-at-intake (#8 v2): intake-time OCR cache (IntakePage) =====
  // intakePage is not on the AppDb hand-rolled delegate — cast like `document` elsewhere.
  type IntakePageRow = { id: string; intakeS3Key: string; pageNumber: number; jobTag: string | null };
  const intakePageDb = db as unknown as {
    intakePage: {
      upsert: (a: { where: { intakeS3Key_pageNumber: { intakeS3Key: string; pageNumber: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<IntakePageRow>;
      findFirst: (a: { where: Record<string, unknown>; select?: Record<string, true> }) => Promise<{ intakeS3Key: string } | null>;
    };
  };

  /**
   * POST /api/v1/internal/intakes/ocr-start  { intakeS3Key, jobTag }
   * The OCR worker records the Textract jobTag -> intake s3Key mapping BEFORE starting Textract on an
   * intake/ object (Textract's JobTag can't carry the slash-bearing s3Key). Written as the
   * pageNumber=0 placeholder row; the async completion resolves the s3Key back via jobTag. Idempotent.
   */
  router.post(
    '/internal/intakes/ocr-start',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isRecord(body)) { badRequest('Request body must be an object'); return; }
      const intakeS3Key = body['intakeS3Key'];
      const jobTag = body['jobTag'];
      if (typeof intakeS3Key !== 'string' || intakeS3Key.length === 0) { badRequest('intakeS3Key is required', { field: 'intakeS3Key' }); return; }
      if (typeof jobTag !== 'string' || jobTag.length === 0 || jobTag.length > 64) { badRequest('jobTag is required (<=64 chars)', { field: 'jobTag' }); return; }
      await intakePageDb.intakePage.upsert({
        where: { intakeS3Key_pageNumber: { intakeS3Key, pageNumber: 0 } },
        create: { intakeS3Key, pageNumber: 0, text: '', jobTag, readStatus: 'processing' },
        update: { jobTag, readStatus: 'processing' },
      });
      res.status(201).json({ data: { ok: true } });
    }),
  );

  /**
   * POST /api/v1/internal/intakes/by-job-tag/pages  { jobTag, pages:[{pageNumber,text,confidence}], documentPageCount? }
   * Worker callback when intake-time Textract SUCCEEDS with text. Resolves jobTag -> intakeS3Key via
   * the placeholder, then upserts the real IntakePage rows (pageNumber >= 1) + computes readStatus the
   * same way the case path does (classifyReadAttempt, so a garbled/too-short read isn't a false 'read').
   * 404 if the jobTag is unknown. At assign these rows are copied forward into document_pages.
   */
  router.post(
    '/internal/intakes/by-job-tag/pages',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = parsePageUpsertBody(req.body); // validates pages (pageNumber>=1) + documentPageCount
      const body = req.body as Record<string, unknown>;
      const jobTag = body['jobTag'];
      if (typeof jobTag !== 'string' || jobTag.length === 0) { badRequest('jobTag is required', { field: 'jobTag' }); return; }
      const placeholder = await intakePageDb.intakePage.findFirst({ where: { jobTag, pageNumber: 0 }, select: { intakeS3Key: true } });
      if (placeholder === null) {
        throw new HttpError(404, 'not_found', 'No intake OCR job for that jobTag', { jobTag });
      }
      const intakeS3Key = placeholder.intakeS3Key;
      const concatenatedText = parsed.pages.map((p) => p.text).join('\n');
      const outcome = classifyReadAttempt({ method: 'textract', extractedText: concatenatedText });
      const readStatus = outcome.succeeded ? 'read' : 'manual_summary_required';
      const txDb = db as unknown as { $transaction: (fn: (tx: typeof intakePageDb) => Promise<unknown>) => Promise<unknown> };
      await txDb.$transaction(async (tx) => {
        for (const p of parsed.pages) {
          await tx.intakePage.upsert({
            where: { intakeS3Key_pageNumber: { intakeS3Key, pageNumber: p.pageNumber } },
            create: { intakeS3Key, pageNumber: p.pageNumber, text: p.text, confidence: p.confidence, pageCount: parsed.documentPageCount, readStatus },
            update: { text: p.text, confidence: p.confidence, pageCount: parsed.documentPageCount, readStatus },
          });
        }
        // Stamp the placeholder so the pool can show "parsed" / "needs manual" without scanning pages.
        await tx.intakePage.upsert({
          where: { intakeS3Key_pageNumber: { intakeS3Key, pageNumber: 0 } },
          create: { intakeS3Key, pageNumber: 0, text: '', jobTag, readStatus },
          update: { readStatus },
        });
      });
      res.status(201).json({ data: { intakeS3Key, pagesUpserted: parsed.pages.length, readStatus } });
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
   * Returns { data: { documentId, caseId, s3Key, hasPages } } or 404 if no Document has that s3Key.
   * `hasPages` lets ocr-start SKIP Textract when the document already carries OCR text — the
   * double-OCR guard (#8 v1): a re-fired ObjectCreated event, an assign-time CopyObject of a file
   * whose text was already transplanted from intake, or a retry will not re-spend on Textract. The
   * /pages upsert is idempotent so correctness never depends on the skip — it's pure cost-saving.
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
      const pageCount = await (db as unknown as {
        documentPage: { count: (args: { where: { documentId: string } }) => Promise<number> };
      }).documentPage.count({ where: { documentId: doc.id } });
      res.json({ data: { documentId: doc.id, caseId: doc.caseId, s3Key: doc.s3Key, hasPages: pageCount > 0 } });
    }),
  );

  /**
   * GET /api/v1/internal/documents/:id/source
   *
   * Resolves a documentId → its S3 key + content type so the OCR worker's Claude fallback can
   * fetch the file bytes (when Textract couldn't read it). Service-principal only.
   * Returns { data: { s3Key, contentType } } or 404.
   */
  router.get(
    '/internal/documents/:id/source',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const doc = await (db as unknown as {
        document: { findUnique: (args: { where: { id: string }; select?: Record<string, true> }) => Promise<{ s3Key: string; contentType: string | null } | null> };
      }).document.findUnique({ where: { id }, select: { s3Key: true, contentType: true } });
      if (doc === null) throw new HttpError(404, 'not_found', 'Document not found', { documentId: id });
      res.json({ data: { s3Key: doc.s3Key, contentType: doc.contentType } });
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
      // Cap is a payload-abuse backstop, not a clinical limit. 500 truncated large extractions — a
      // 1,000+ page Blue Button report legitimately yields hundreds of problems/meds/SC rows across
      // three categories. Raised to 2000 so a complete extraction is never silently rejected at the
      // door (the dedup/merge downstream collapses duplicates). (Ryan 2026-06-13, $500-stakes.)
      if (rawItems.length > 2000) { badRequest('items exceeds maximum of 2000', { field: 'items', max: 2000 }); return; }
      const costUsd = typeof body['costUsd'] === 'number' ? (body['costUsd'] as number) : undefined;

      const c = await (db as unknown as {
        case: { findFirst: (a: { where: { id: string }; select: { veteranId: true } }) => Promise<{ veteranId: string } | null> };
      }).case.findFirst({ where: { id: caseId }, select: { veteranId: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const items = coerceExtractedItems(rawItems);
      const result = await applyExtractionMerge(db, { caseId, veteranId: c.veteranId, runId, items, costUsd });

      // Keystone 4c — post-merge restamp hook: new chart rows can stale the derived framing/
      // viability/cds stamps from an earlier draft. Re-derive + restamp under the pkg-5 provenance
      // rule (only 'derived'-sourced values may be overwritten; 'manual' and legacy-null never).
      // Log-only try/catch AFTER the merge committed — a restamp failure can never fail this
      // worker callback. (refreshDerivedStamps also isolates per-group internally.)
      if (result.written > 0) {
        try {
          const stamps = await refreshDerivedStamps(db, caseId);
          console.log(JSON.stringify({ msg: 'post-merge restamp', caseId, runId, written: result.written, ...stamps }));
        } catch (err) {
          console.error(JSON.stringify({
            msg: 'post-merge restamp failed (merge unaffected)',
            caseId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }

      // Auto-generate the abridged notes ("Doctor Pack") the moment the records finish parsing
      // (Ryan 2026-06-12: available to EVERYONE from the start, not only on send-to-physician).
      // Post-commit + log-only — a pack failure can NEVER fail this worker callback. The service is
      // idempotent + readiness-gated: it queues only when the chart is fully read AND no
      // queued/generating/ready pack already exists for this case version (so a re-extraction with a
      // pack already present is a no-op; the RN's Regenerate button handles "new notes came in").
      try {
        const gen = await generateDoctorPackForCase(db, { caseId, actorSub: SERVICE_ACTORS.WORKER, trigger: 'auto_chart_parsed' });
        console.log(JSON.stringify({
          event: gen.outcome === 'queued' ? 'doctor_pack_autogen_queued' : 'doctor_pack_autogen_skipped',
          caseId, source: 'chart_parsed', runId,
          ...(gen.outcome === 'queued' ? { doctorPackId: gen.pack.id } : { existingPackId: gen.existingPackId, existingState: gen.existingState }),
        }));
      } catch (err) {
        console.warn(JSON.stringify({ event: 'doctor_pack_autogen_failed', caseId, source: 'chart_parsed', message: err instanceof Error ? err.message : String(err) }));
      }

      res.json({ data: result });
    }),
  );

  /**
   * POST /api/v1/internal/cases/:caseId/screening-summary
   *
   * The chart-extract worker POSTs the screenings it captured; this renders the consolidated
   * Screening Summary text file + upserts its Document row (idempotent on the stable s3Key). Body:
   *   { runId: string, screenings: ScreeningResult[] }
   * No-op when screenings is empty. Best-effort from the worker's side (a failure here must never
   * fail the chart-extract callback — the chart rows already committed).
   */
  router.post(
    '/internal/cases/:caseId/screening-summary',
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.caseId);
      const body = req.body;
      if (!isRecord(body)) { badRequest('Request body must be an object'); return; }
      const runId = body['runId'];
      if (typeof runId !== 'string' || runId.length === 0) { badRequest('runId is required', { field: 'runId' }); return; }
      const rawScreenings = body['screenings'];
      if (!Array.isArray(rawScreenings)) { badRequest('screenings is required (array)', { field: 'screenings' }); return; }
      if (rawScreenings.length > 2000) { badRequest('screenings exceeds maximum of 2000', { field: 'screenings', max: 2000 }); return; }
      const screenings = coerceScreeningPayload(rawScreenings);
      const result = await writeScreeningSummary(db, caseId, screenings, runId);
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

      // Forward-only guard: only a 'pending' or previously-'failed' (retry) intake may be set to
      // ready/failed. An SQS/DLQ replay must NEVER resurrect an 'assigned' or 'dismissed' intake
      // back into the pool (that would double-assign / undo an RN action). (Architect P1-B.)
      const currentStatus = (existing as { status?: string }).status;
      if (currentStatus !== 'pending' && currentStatus !== 'failed') {
        throw new HttpError(409, 'conflict', `Intake is '${currentStatus}', not pending/failed — refusing to overwrite.`, { intakeId: id, currentStatus });
      }

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
      const dob = strOrUndef('submittedDob'); if (dob !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(dob)) data['submittedDob'] = dob;
      const claimType = strOrUndef('submittedClaimType'); if (claimType !== undefined) data['submittedClaimType'] = (claimType as string).slice(0, 20);
      const formTitle = strOrUndef('submittedFormTitle'); if (formTitle !== undefined) data['submittedFormTitle'] = (formTitle as string).slice(0, 300);
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

  // One-time BACKFILL: re-derive the veteran's SECONDARY framing + stated theory from each assigned
  // intake's raw answers and fill them onto the case — NULL fields only, never overwriting an RN edit.
  // Fixes every case created before the secondary-framing parser shipped (Ryan 2026-06-07: cases read
  // "direct" though the veteran wrote "secondary to PTSD"). Idempotent (re-running is a no-op once filled).
  router.post('/internal/admin/backfill-intake-framing', asyncHandler(async (_req: Request, res: Response) => {
    const intakes = await db.intake.findMany({ where: { assignedCaseId: { not: null } } });
    let scanned = 0;
    const changes: Array<Record<string, unknown>> = [];
    for (const intakeRow of intakes) {
      const i = intakeRow as { assignedCaseId: string | null; rawAnswersJson?: unknown };
      if (i.assignedCaseId === null) continue;
      scanned++;
      const derived = deriveIntakeFields(i.rawAnswersJson);
      const c = await db.case.findFirst({
        where: { id: i.assignedCaseId },
        select: {
          id: true, upstreamScCondition: true, framingChoice: true, veteranStatement: true, claimedCondition: true,
          veteran: { select: { scConditions: { select: { condition: true, status: true } } } },
        },
      });
      if (c === null) continue;
      const cc = c as unknown as { id: string; upstreamScCondition: string | null; framingChoice: string | null; veteranStatement: string | null; claimedCondition: string; veteran: { scConditions: Array<{ condition: string; status: string }> } | null };
      const grantedSc = (cc.veteran?.scConditions ?? []).filter((s) => s.status === 'service_connected').map((s) => s.condition);
      const data: Record<string, unknown> = {};
      if (derived.veteranTheory && (cc.veteranStatement ?? '').trim().length === 0) data.veteranStatement = derived.veteranTheory;
      // Anchor: the SHARED SSOT evidence ladder (case-framing.ts deriveFramingFromEvidence) — the same
      // derivation the bundle producer uses, so the backfill and the stamped bundle.caseFraming can never
      // diverge (SSOT build plan §5.2; a second independent derivation is the bug class this eliminates).
      // Branch→write mapping preserves the original :753-773 behavior exactly:
      //   storedScoreable (derived + upstream unchanged)        → no write (keep the stored anchor)
      //   authoritative   (derived + upstream changed)          → write upstream + secondary/aggravation
      //   text-parse hint (text_parse_fallback)                 → write upstream + parsed framing
      //   garbage stored anchor (default_direct + cleared)      → write null + 'direct'
      //   nothing fired   (default_direct, nothing to clear)    → no write
      const decision = deriveFramingFromEvidence({
        claimedCondition: cc.claimedCondition,
        upstreamScCondition: cc.upstreamScCondition,
        grantedScConditionNames: grantedSc,
        aggravationWording: /aggravat/.test((cc.framingChoice ?? '').toLowerCase()),
        textParseHint: derived.upstreamCondition
          ? { upstream: derived.upstreamCondition, framing: derived.framing ?? 'secondary' }
          : undefined,
      });
      if (decision.source === 'derived' && decision.upstreamScCondition !== cc.upstreamScCondition) {
        data.upstreamScCondition = decision.upstreamScCondition;
        data.framingChoice = decision.framing;
      } else if (decision.source === 'text_parse_fallback') {
        data.upstreamScCondition = decision.upstreamScCondition;
        data.framingChoice = decision.framing;
      } else if (decision.source === 'default_direct' && decision.upstreamScCondition === null && cc.upstreamScCondition !== null) {
        data.upstreamScCondition = null;
        data.framingChoice = 'direct';
      }
      // Provenance (keystone pkg 5): every branch above is machine-derived (evidence ladder /
      // intake text-parse / garbage-clear) → stamp 'derived' whenever the pair is written, so the
      // post-merge restamp hook may refresh these backfilled values later.
      if ('framingChoice' in data) data.framingStampSource = 'derived';
      if (Object.keys(data).length > 0) {
        await db.case.update({ where: { id: cc.id }, data: data as never });
        changes.push({ caseId: cc.id, condition: cc.claimedCondition, ...data });
      }
    }
    res.json({ data: { scanned, updated: changes.length, changes } });
  }));

  return router;
}
