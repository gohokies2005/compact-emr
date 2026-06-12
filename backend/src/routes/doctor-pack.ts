import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppDb, KeyDocClassification, KeyDocType } from '../services/db-types.js';

// Chunk D (2026-06-11): presigned GET for the assembled pack PDF (mirrors the drafter
// artifact-pdf-url pattern). Client cached module-wide; injectable for tests.
let cachedS3Client: S3Client | null = null;
function getS3ForDoctorPacks(): S3Client {
  if (cachedS3Client !== null) return cachedS3Client;
  cachedS3Client = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' });
  return cachedS3Client;
}
const DOCTOR_PACK_PDF_TTL_SECONDS = 5 * 60;

// Path-traversal guard. The Doctor Pack PDF lives at a deterministic S3 key derived from the
// caseId + caseVersion + doctorPackId. We construct the key server-side and refuse to honor
// any client-supplied key. Task #107a (later) extracted the validator into a shared module
// so the worker-callback path (PATCH /internal/doctor-packs/:id) uses the same check.
// (Key CONSTRUCTION lives in services/doctor-pack-generate.ts since the Package 7 extraction.)
function isSafeS3Key(s3Key: string): boolean {
  return isDoctorPackS3Key(s3Key);
}

// Items 3+4 (2026-06-11): shared KeyDoc enrichment. KeyDoc.filePath stores the raw S3 key;
// Document.s3Key is @unique, so one IN-query maps each key to its human filename (display),
// documentId (the presigned "Open" viewer), and pageCount ("N of M pages"). Used by BOTH the
// per-case key-docs list and the cross-case RN review queue.
async function keyDocEnrichmentByS3Key(
  db: AppDb,
  s3Keys: readonly string[],
): Promise<Map<string, { documentId: string; filename: string; pageCount: number | null }>> {
  if (s3Keys.length === 0) return new Map();
  const docs = (await db.document.findMany({
    where: { s3Key: { in: [...new Set(s3Keys)] } },
    select: { id: true, s3Key: true, filename: true, pageCount: true },
  })) as unknown as readonly { id: string; s3Key: string; filename: string; pageCount: number | null }[];
  return new Map(docs.map((d) => [d.s3Key, { documentId: d.id, filename: d.filename, pageCount: d.pageCount }]));
}

export function createDoctorPackRouter(db: AppDb, opts?: { s3?: Pick<S3Client, 'send'> }): Router {
  const router = Router();
  const s3ForPacks = (): Pick<S3Client, 'send'> => opts?.s3 ?? getS3ForDoctorPacks();

  /**
   * POST /api/v1/cases/:id/doctor-pack/generate
   *
   * Kicks off a Doctor Pack assembly. Three checks before queuing:
   *   1. Case exists.
   *   2. Chart-readiness gate is GREEN (OCR HARD-STOP — no Doctor Pack until every file is
   *      read or manual-summarized).
   *   3. The classified-files set is non-empty (no point assembling an empty pack).
   *
   * On success: writes one KeyDoc row per file (idempotent upsert on caseId+filePath), creates
   * a DoctorPack row in state='queued' with the manifest, returns the row to the caller.
   *
   * The actual PDF assembly is a downstream SQS-triggered Lambda worker (deployed via
   * workers-stack.ts as compact-emr-<env>-doctor-pack-assembler) that reads the manifest from
   * the SQS message body, pulls source PDFs from S3, extracts the manifest's page ranges,
   * concatenates, uploads to the computed s3 key, and PATCHes the row to state='ready' +
   * page_count.
   *
   * Package 7 (2026-06-11): the body was EXTRACTED to services/doctor-pack-generate.ts
   * (generateDoctorPackForCase) so the case status route auto-fires the SAME logic on
   * rn_review/drafting -> physician_review. This route is the manual trigger ('manual' mode:
   * 409 on in-flight, regenerate-over-ready allowed) — the panel's "Generate now" escape hatch
   * + Regenerate-on-failure.
   */
  router.post(
    '/cases/:id/doctor-pack/generate',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);
      const result = await generateDoctorPackForCase(db, { caseId, actorSub: actor.sub, trigger: 'manual' });
      // 'manual' either queues or throws — 'skipped' is the auto-trigger's outcome. Type-narrow
      // defensively rather than non-null-assert.
      if (result.outcome !== 'queued') {
        throw new HttpError(409, 'conflict', 'A Doctor Pack already exists for this case version.', {
          caseId,
          existingPackId: result.existingPackId,
          state: result.existingState,
        });
      }
      res.status(201).json({ data: result.pack });
    }),
  );


  /**
   * GET /api/v1/cases/:id/doctor-pack/latest
   *
   * Returns the most recent DoctorPack row for the case (any state). Used by the UI to render
   * "Doctor Pack: generating | ready | failed" and the signed URL when ready.
   */
  router.get(
    '/cases/:id/doctor-pack/latest',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const row = await db.doctorPack.findFirst({
        where: { caseId },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ data: row });
    }),
  );

  /**
   * GET /api/v1/cases/:id/doctor-pack/:packId/pdf-url
   *
   * Chunk D (2026-06-11): 5-min presigned GET URL for the assembled Doctor Pack PDF. Mirrors
   * the letter-artifact presign (drafter.ts artifact-pdf-url). No prior route could serve the
   * pack — it lives in the SEPARATE doctorPacksBucket (DOCTOR_PACKS_BUCKET_NAME env; the API
   * Lambda already has the env + grantRead via api-stack.ts, unread until now).
   *
   * Access: same as the other doctor-pack GETs (admin / ops_staff / physician).
   * Validates: pack exists, belongs to the URL case, is ready with a pdfS3Key, key passes the
   * doctor-packs path validator; HeadObject confirms the object exists before signing.
   */
  router.get(
    '/cases/:id/doctor-pack/:packId/pdf-url',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const packId = String(req.params.packId);

      const bucket = process.env['DOCTOR_PACKS_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'DOCTOR_PACKS_BUCKET_NAME not configured');
      }

      const pack = await db.doctorPack.findFirst({ where: { id: packId } });
      if (pack === null || pack.caseId !== caseId) {
        throw new HttpError(404, 'not_found', 'Doctor Pack not found for this case', { caseId, packId });
      }
      if (pack.state !== 'ready' || typeof pack.pdfS3Key !== 'string' || pack.pdfS3Key.length === 0) {
        throw new HttpError(404, 'not_found', 'No Doctor Pack PDF exists yet (pack is not ready)', { caseId, packId, state: pack.state });
      }
      if (!isSafeS3Key(pack.pdfS3Key)) {
        throw new HttpError(500, 'internal_error', 'Stored Doctor Pack S3 key fails safety check', { caseId, packId });
      }

      const s3 = s3ForPacks();
      // Confirm the object exists before signing — a ready row whose PDF was lifecycle-deleted
      // should 404 cleanly, not hand back a URL that resolves to S3 NoSuchKey XML.
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: pack.pdfS3Key }));
      } catch {
        throw new HttpError(404, 'not_found', 'The Doctor Pack PDF object is missing from storage', { caseId, packId });
      }
      const url = await getSignedUrl(s3 as S3Client, new GetObjectCommand({ Bucket: bucket, Key: pack.pdfS3Key }), {
        expiresIn: DOCTOR_PACK_PDF_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + DOCTOR_PACK_PDF_TTL_SECONDS * 1000).toISOString();

      res.json({ data: { url, expiresAt, ttlSeconds: DOCTOR_PACK_PDF_TTL_SECONDS } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/key-docs
   *
   * Returns the classified key-docs list for the case, importance descending. Used by the UI
   * to show "what's in the Doctor Pack" before / instead of opening the PDF.
   * Chunk D: each row is enriched with `docPageCount` (the source Document's total pages,
   * joined on s3Key) so the panel can render "3 of 25 pages".
   */
  router.get(
    '/cases/:id/key-docs',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.keyDoc.findMany({
        where: { caseId },
        orderBy: [{ importance: 'desc' }, { filePath: 'asc' }],
      });
      // Item 4: documentId added (shared helper) so the panel can open the source PDF inline.
      const docByKey = await keyDocEnrichmentByS3Key(db, rows.map((r) => r.filePath));
      const enriched = rows.map((r) => ({
        ...r,
        docPageCount: docByKey.get(r.filePath)?.pageCount ?? null,
        filename: docByKey.get(r.filePath)?.filename ?? null,
        documentId: docByKey.get(r.filePath)?.documentId ?? null,
      }));
      res.json({ data: enriched });
    }),
  );

  /**
   * GET /api/v1/rn/key-docs-needing-review
   *
   * Closeout item #5: cross-case queue of KeyDocs the page-selector flagged for RN review
   * (needsRnReview=true). Oldest first (FIFO). Optional ?limit (default 50, max 200).
   * admin + ops_staff only. The RN page surfaces this alongside the manual-summary queue;
   * RNs ack via POST /api/v1/key-docs/:id/acknowledge.
   */
  router.get(
    '/rn/key-docs-needing-review',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const limitRaw = req.query['limit'];
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      }
      const rows = await db.keyDoc.findMany({
        where: { needsRnReview: true },
        orderBy: { updatedAt: 'asc' },
      });
      // Item 3 (2026-06-11): the queue used to ship raw S3 keys with no way to open the file.
      // Enrich the returned page (not the full set) with filename + documentId via the shared
      // helper so the RN sees a human name and gets a presigned "Open" affordance.
      const page = rows.slice(0, limit);
      const docByKey = await keyDocEnrichmentByS3Key(db, page.map((r) => r.filePath));
      const enriched = page.map((r) => ({
        ...r,
        filename: docByKey.get(r.filePath)?.filename ?? null,
        documentId: docByKey.get(r.filePath)?.documentId ?? null,
      }));
      res.json({ data: enriched, total: rows.length });
    }),
  );

  /**
   * POST /api/v1/key-docs/:id/acknowledge
   *
   * Architect QA finding (REVIEW.md 0cd4df0, Build 1 follow-up): RN-durable clearance.
   * Marks a KeyDoc as RN-reviewed. Clears needsRnReview AND stamps selectorAcknowledgedAt
   * so the next /generate doesn't reset the flag. Body: optional `notes` (free text).
   */
  router.post(
    '/key-docs/:id/acknowledge',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const id = String(req.params.id);
      const notesRaw = (req.body as { notes?: unknown })?.notes;
      const notesUpdate = typeof notesRaw === 'string' && notesRaw.trim().length > 0
        ? notesRaw.trim().slice(0, 2000)
        : undefined;

      const existing = await db.keyDoc.findUnique({ where: { id } });
      if (existing === null) throw new HttpError(404, 'not_found', 'KeyDoc not found', { keyDocId: id });

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.keyDoc.update({
          where: { id },
          data: {
            needsRnReview: false,
            selectorAcknowledgedAt: new Date(),
            selectorAcknowledgedBy: actor.sub,
            version: { increment: 1 },
            ...(notesUpdate !== undefined ? { notes: notesUpdate } : {}),
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'key_doc_rn_acknowledged',
            caseId: existing.caseId,
            detailsJson: { keyDocId: id, caseId: existing.caseId, filePath: existing.filePath },
          },
        });
        return row;
      });

      res.json({ data: updated });
    }),
  );

  return router;
}

export type { KeyDocType, KeyDocClassification };
