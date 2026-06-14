import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { buildContentHintText, displayFileName, generateDoctorPackForCase, keyDocDisplayLabel } from '../services/doctor-pack-generate.js';
import { classifyDocument, CLASSIFIER_VERSION_NUM } from '../services/key-docs-classifier.js';
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
// WAVE 2 (assessment 2026-06-12 §3): also emits displayLabel ('<DocType human name> —
// <original filename>'; unspecified → just the filename) — which needs the row's docType, so
// the helper now takes the rows (filePath + docType), not bare keys. Date extraction is
// deliberately deferred (medium confidence per the assessment).
async function keyDocEnrichmentByS3Key(
  db: AppDb,
  rows: readonly { readonly filePath: string; readonly docType: string }[],
): Promise<Map<string, { documentId: string | null; filename: string | null; pageCount: number | null; displayLabel: string }>> {
  if (rows.length === 0) return new Map();
  const docs = (await db.document.findMany({
    where: { s3Key: { in: [...new Set(rows.map((r) => r.filePath))] } },
    select: { id: true, s3Key: true, filename: true, pageCount: true },
  })) as unknown as readonly { id: string; s3Key: string; filename: string; pageCount: number | null }[];
  const docByKey = new Map(docs.map((d) => [d.s3Key, d]));
  return new Map(rows.map((r) => {
    const d = docByKey.get(r.filePath);
    return [r.filePath, {
      documentId: d?.id ?? null,
      filename: d?.filename ?? null,
      pageCount: d?.pageCount ?? null,
      displayLabel: keyDocDisplayLabel(r.docType, displayFileName(r.filePath, d?.filename ?? null)),
    }];
  }));
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
      // WAVE 2 §3: displayLabel rides along (panel renders it; falls back when absent).
      const docByKey = await keyDocEnrichmentByS3Key(db, rows);
      const enriched = rows.map((r) => ({
        ...r,
        docPageCount: docByKey.get(r.filePath)?.pageCount ?? null,
        filename: docByKey.get(r.filePath)?.filename ?? null,
        documentId: docByKey.get(r.filePath)?.documentId ?? null,
        displayLabel: docByKey.get(r.filePath)?.displayLabel ?? null,
      }));
      res.json({ data: enriched });
    }),
  );

  // REMOVED (C7 lifecycle, 2026-06-13): the RN-facing "Confirm pack pages" review queue —
  // GET /rn/key-docs-needing-review + POST /key-docs/:id/acknowledge — was vestigial. The
  // page-selector's needsRnReview flag is still set + carried by the live classifier and the
  // /cases/:id/key-docs panel, but the standalone cross-case RN review/ack tab is gone. The
  // KeyDoc GENERATION + classification code (key-docs-classifier, page-selector, /generate,
  // /cases/:id/key-docs, reclassify-stale) is untouched.

  // ============================================================================================
  // STALE-ROW BACKFILL (assessment 2026-06-12 §2 — appended as a SEPARATE block; the routes
  // above are owned by the doctor-pack/budget work stream).
  // ============================================================================================

  /**
   * POST /api/v1/rn/key-docs/reclassify-stale  (admin only)
   *
   * ROOT CAUSE: classifier upgrades never retrofit stored KeyDoc rows — Hatfield's
   * Intake_Summary.pdf sat in the RN queue as "unspecified" a day after the classifier learned
   * the pattern, because nothing re-classifies the installed base. (Rejected alternative per
   * the assessment: re-classify on queue READ — a surprising read-path mutation; an explicit
   * admin backfill is auditable.)
   *
   * Contract:
   *   - Loads every KeyDoc row with classifierVersion < CLASSIFIER_VERSION_NUM (0 = legacy).
   *   - Re-runs classifyDocument against the SAME inputs generation uses: the Document's
   *     docTag (human override) + the stored document_pages text fed through the shared
   *     buildContentHintText slice (first 2 pages x 4000 chars) + the filename. A row whose
   *     Document/pages are gone re-classifies on filename alone — same fallback as generation.
   *   - docType UNCHANGED: refreshes classification/importance, stamps classifierVersion.
   *     needsRnReview and any RN acknowledgement are left alone — the RN's decision was made
   *     under semantics that still hold.
   *   - docType CHANGED: writes the new docType/classification/importance and REPLICATES the
   *     generate-path docTypeChanged semantics (doctor-pack-generate.ts): the stale RN
   *     acknowledgement is wiped (selectorAcknowledgedAt/By = null) because the RN cleared a
   *     file that meant something different. needsRnReview clears when the row is now a KNOWN
   *     type (the reason it was queued — unknown identity — is resolved); a row that flips TO
   *     'unspecified' keeps its flag.
   *   - All updates + one summary activity-log row commit in a single transaction; returns
   *     counts: { classifierVersion, scanned, reclassified, stampedOnly, rnReviewCleared,
   *     acksCleared }.
   *
   * NOTE: page RANGES are deliberately NOT recomputed here — that is the page-selector's job
   * and runs on the next pack generation (the cleared ack ensures the fresh selector verdict
   * is honored there). This route only fixes what the row SAYS the document is.
   */
  router.post(
    '/rn/key-docs/reclassify-stale',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const staleRows = await db.keyDoc.findMany({
        where: { classifierVersion: { lt: CLASSIFIER_VERSION_NUM } },
        orderBy: { updatedAt: 'asc' },
      });

      // Batch-load the classification inputs: Document (docTag) by unique s3Key, then the
      // first 2 OCR pages per document — the exact feed generation gives the classifier.
      const s3Keys = [...new Set(staleRows.map((r) => r.filePath))];
      const docs = s3Keys.length > 0
        ? ((await db.document.findMany({
            where: { s3Key: { in: s3Keys } },
            select: { id: true, s3Key: true, docTag: true },
          })) as unknown as readonly { id: string; s3Key: string; docTag: string | null }[])
        : [];
      const docByKey = new Map(docs.map((d) => [d.s3Key, d]));
      const pagesByDocId = new Map<string, { pageNumber: number; text: string }[]>();
      if (docs.length > 0) {
        const pageRows = await db.documentPage.findMany({
          where: { documentId: { in: docs.map((d) => d.id) }, pageNumber: { lte: 2 } },
          orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
        });
        for (const p of pageRows) {
          const arr = pagesByDocId.get(p.documentId) ?? [];
          arr.push({ pageNumber: p.pageNumber, text: p.text });
          pagesByDocId.set(p.documentId, arr);
        }
      }

      let reclassified = 0;
      let stampedOnly = 0;
      let rnReviewCleared = 0;
      let acksCleared = 0;

      await db.$transaction(async (tx) => {
        for (const row of staleRows) {
          const doc = docByKey.get(row.filePath);
          const contentText = doc ? buildContentHintText(pagesByDocId.get(doc.id) ?? []) : '';
          const cls = classifyDocument({
            filePath: row.filePath,
            docTag: doc?.docTag ?? null,
            contentText,
          });
          const docTypeChanged = cls.docType !== row.docType;

          if (!docTypeChanged) {
            stampedOnly += 1;
            await tx.keyDoc.update({
              where: { id: row.id },
              data: {
                classification: cls.classification,
                importance: cls.importance,
                classifierVersion: CLASSIFIER_VERSION_NUM,
                version: { increment: 1 },
              },
            });
            continue;
          }

          reclassified += 1;
          const newNeedsRnReview = cls.docType === 'unspecified' ? row.needsRnReview : false;
          if (row.needsRnReview && !newNeedsRnReview) rnReviewCleared += 1;
          if (row.selectorAcknowledgedAt !== null) acksCleared += 1;
          await tx.keyDoc.update({
            where: { id: row.id },
            data: {
              docType: cls.docType,
              classification: cls.classification,
              importance: cls.importance,
              needsRnReview: newNeedsRnReview,
              classifierVersion: CLASSIFIER_VERSION_NUM,
              // Replicates the generate-path docTypeChanged ack-clear (doctor-pack-generate.ts):
              // the RN acknowledged a row that claimed to be a different kind of document.
              selectorAcknowledgedAt: null,
              selectorAcknowledgedBy: null,
              version: { increment: 1 },
            },
          });
        }

        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'key_docs_reclassified_stale',
            detailsJson: {
              classifierVersion: CLASSIFIER_VERSION_NUM,
              scanned: staleRows.length,
              reclassified,
              stampedOnly,
              rnReviewCleared,
              acksCleared,
            },
          },
        });
        // 120s timeout (architect post-QA 2026-06-12): the first run sweeps the WHOLE legacy
        // installed base (every row < CLASSIFIER_VERSION_NUM) in this one transaction — Prisma's
        // default 5s would P2028-rollback on a large table with zero progress. Chunking is the
        // long-term shape if key_docs ever grows past ~10k rows.
      }, { timeout: 120_000 });

      res.json({
        data: {
          classifierVersion: CLASSIFIER_VERSION_NUM,
          scanned: staleRows.length,
          reclassified,
          stampedOnly,
          rnReviewCleared,
          acksCleared,
        },
      });
    }),
  );

  return router;
}

export type { KeyDocType, KeyDocClassification };
