import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { requireRole } from '../auth/roles.js';
import { isCaseDocumentS3Key } from '../services/s3-key-safety.js';
import { nudgeDocumentReocr } from '../services/document-reocr.js';
import { TERMINAL_READ_STATUSES, isScreeningSummaryKey } from '../services/chart-build-state.js';
import { maybeEnqueueChartExtract } from '../services/chart-extract-trigger.js';
import type { AppDb } from '../services/db-types.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/html', // .html — VA Rated-Disabilities / Blue Button; native-read strips tags → text (E4, 2026-06-13)
]);

interface DocumentsRouterDeps {
  prisma?: PrismaClient;
  s3?: S3Client;
  bucketName?: string;
}

interface ErrorDetails {
  readonly [key: string]: string | number | boolean | null | ErrorDetails | readonly ErrorDetails[];
}

function error(res: Response, status: number, code: string, message: string, details?: ErrorDetails) {
  return res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 180);
}

async function assertCaseBelongsToVeteran(prisma: PrismaClient, caseId: string, veteranId: string) {
  return prisma.case.findFirst({ where: { id: caseId, veteranId }, select: { id: true } });
}

export function createDocumentsRouter(deps: DocumentsRouterDeps = {}) {
  const router = Router();
  const prisma = (deps.prisma ?? defaultPrisma) as unknown as PrismaClient;
  const s3 = deps.s3 ?? new S3Client({});
  const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  router.get('/veterans/:id/documents', requireRole(['admin', 'ops_staff']), async (req, res) => {
    const veteranId = String(req.params.id);
    const documents = await prisma.document.findMany({
      where: { case: { veteranId } },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        caseId: true,
        filename: true,
        sizeBytes: true,
        contentType: true,
        docTag: true,
        s3Key: true,
        uploadedAt: true,
        uploadedBy: true,
        updatedAt: true,
        version: true,
      },
    });
    res.json({ data: documents.map((doc) => ({ ...doc, sizeBytes: doc.sizeBytes.toString() })) });
  });

  router.post('/veterans/:id/documents/presign', requireRole(['admin', 'ops_staff']), async (req: Request, res: Response) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const veteranId = String(req.params.id);
    const filename = asString(req.body?.filename);
    const contentType = asString(req.body?.contentType);
    const caseId = asString(req.body?.caseId);
    const sizeBytes = asNumber(req.body?.sizeBytes);

    if (!filename || !contentType || !caseId || sizeBytes === undefined) {
      return error(res, 400, 'invalid_presign_request', 'filename, contentType, sizeBytes, and caseId are required.');
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return error(res, 400, 'unsupported_content_type', 'Only PDF, JPG, PNG, DOC, DOCX, and TXT uploads are supported.');
    }
    if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      return error(res, 400, 'file_too_large', 'Uploads must be greater than 0 bytes and no larger than 50 MB.', { maxBytes: MAX_UPLOAD_BYTES });
    }
    const owningCase = await assertCaseBelongsToVeteran(prisma, caseId, veteranId);
    if (!owningCase) return error(res, 404, 'case_not_found', 'Case was not found for this veteran.');

    const s3Key = `cases/${caseId}/${randomUUID()}-${sanitizeFilename(filename)}`;
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      ServerSideEncryption: 'aws:kms',
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_TTL_SECONDS });

    res.json({
      data: {
        uploadUrl,
        s3Key,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
        requiredHeaders: {
          'content-type': contentType,
          'x-amz-server-side-encryption': 'aws:kms',
        },
      },
    });
  });

  router.post('/veterans/:id/documents', requireRole(['admin', 'ops_staff']), async (req: Request, res: Response) => {
    const veteranId = String(req.params.id);
    const filename = asString(req.body?.filename);
    const contentType = asString(req.body?.contentType);
    const docTag = asString(req.body?.docTag);
    const s3Key = asString(req.body?.s3Key);
    const caseId = asString(req.body?.caseId);
    const sizeBytes = asNumber(req.body?.sizeBytes);

    if (!filename || !contentType || !s3Key || !caseId || sizeBytes === undefined) {
      return error(res, 400, 'invalid_document_request', 'filename, contentType, sizeBytes, s3Key, and caseId are required.');
    }
    // Task #107a: path-traversal guard on document-registration callback. The presign
    // endpoint computes a canonical key `cases/<caseId>/<uuid>-<filename>`; the client
    // must echo the SAME key back. Without this check, a compromised admin/ops_staff
    // client (or leaked token) could register a Document row pointing at any phiBucket
    // key and then download/delete it via /documents/:id/{download,DELETE}.
    if (!isCaseDocumentS3Key(s3Key)) {
      return error(res, 400, 'invalid_s3_key', 's3Key does not match the safe cases/<caseId>/<uuid>-<filename> pattern.');
    }
    const owningCase = await assertCaseBelongsToVeteran(prisma, caseId, veteranId);
    if (!owningCase) return error(res, 404, 'case_not_found', 'Case was not found for this veteran.');

    const actorUserId = req.user?.sub;
    const created = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          caseId,
          filename,
          sizeBytes: BigInt(sizeBytes),
          contentType,
          ...(docTag !== undefined && { docTag }),
          s3Key,
          uploadedBy: actorUserId ?? 'unknown',
        },
      });
      await tx.activityLog.create({
        data: {
          caseId,
          veteranId,
          actorUserId,
          action: 'document_created',
          detailsJson: { documentId: document.id, s3Key },
        },
      });
      return document;
    });

    res.status(201).json({ data: { ...created, sizeBytes: created.sizeBytes.toString() } });
  });

  router.get('/documents/:id/download', requireRole(['admin', 'ops_staff', 'physician']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const document = await prisma.document.findUnique({ where: { id: String(req.params.id) }, select: { id: true, s3Key: true, filename: true, contentType: true } });
    if (!document) return error(res, 404, 'document_not_found', 'Document was not found.');

    // disposition=inline → render in-page (the EMR's PDF viewer iframe) instead of downloading.
    // Setting ResponseContentType makes the browser render the PDF rather than save it. Default
    // (no param) keeps the attachment/download behavior for any existing callers.
    const inline = req.query['disposition'] === 'inline';
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: document.s3Key,
      ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${sanitizeFilename(document.filename)}"`,
      ...(inline && document.contentType ? { ResponseContentType: document.contentType } : {}),
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
    res.json({ data: { downloadUrl, expiresInSeconds: DOWNLOAD_TTL_SECONDS } });
  });

  // POST /documents/:id/reocr — re-run OCR on a file (e.g. one stuck in "needs review" before the
  // Claude fallback shipped). Re-fires the deployed pipeline by COPYING the object onto itself
  // (MetadataDirective REPLACE) → a fresh S3 ObjectCreated event → ocr-start → Textract → Claude
  // fallback. No extra Textract/Anthropic perms on the API; reuses everything. (admin/ops_staff.)
  router.post('/documents/:id/reocr', requireRole(['admin', 'ops_staff']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const document = await prisma.document.findUnique({ where: { id: String(req.params.id) }, select: { id: true, s3Key: true, contentType: true } });
    if (!document) return error(res, 404, 'document_not_found', 'Document was not found.');
    await nudgeDocumentReocr(s3, bucketName, document);
    res.json({ data: { ok: true, reocrTriggered: true } });
  });

  // POST /cases/:id/reprocess — keystone 4b: the case-level "unstick everything" button. Two
  // idempotent actions in one call:
  //   1. RE-OCR every document on the case that has NO terminal FileReadStatus (the orphan-race /
  //      lost-callback victims) via the shared CopyObject nudge — same primitive as
  //      /documents/:id/reocr, one copy (document-reocr.ts).
  //   2. FORCE a chart re-extract by salting the triggerHash (`<hash>:manual:<requestId>`), which
  //      breaks BOTH the all-terminal wedge's P2002 silent-skip AND the "same doc set → no new
  //      run" latch. The force RIDES THE EXISTING TRIGGER: if docs are still mid-OCR (including
  //      ones nudged in action 1), the enqueue honestly reports 'ocr_in_progress' and the next
  //      /pages completion re-triggers extraction naturally.
  // requestId is minted once per request → the salt is deterministic within the request (a retry
  // P2002s into 'already_enqueued', benign) and unique across requests (a new reprocess always
  // forces a fresh run). Cost note: a forced extract spends real Anthropic tokens — RN-triggered
  // only, never automatic; the run row records costUsd as usual.
  router.post('/cases/:id/reprocess', requireRole(['admin', 'ops_staff']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const caseId = String(req.params.id);
    const caseRow = await prisma.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true } });
    if (!caseRow) return error(res, 404, 'case_not_found', 'Case was not found.');

    const [documents, readStatuses] = await Promise.all([
      prisma.document.findMany({ where: { caseId }, select: { id: true, s3Key: true, contentType: true } }),
      prisma.fileReadStatus.findMany({ where: { caseId }, select: { filePath: true, terminalStatus: true } }),
    ]);
    const terminalKeys = new Set(
      readStatuses.filter((r) => TERMINAL_READ_STATUSES.has(r.terminalStatus)).map((r) => r.filePath),
    );

    // Optional explicit selection (the "Reprocess documents" modal — Ryan 2026-06-16). When the caller
    // names documentIds, this is a FORCE re-read of exactly those docs: clear each one's prior OCR pages
    // first so ocr-start's hasPages guard can't skip a doc that was previously marked 'read' (Textract
    // may have read the printed text but DROPPED the handwriting — the Stephens class). That re-runs the
    // doc through the now-vision pipeline. NO selection = the legacy auto/unstick behavior, untouched:
    // nudge only docs that never reached a terminal read outcome, never disturbing a good read.
    const body = (req.body ?? {}) as { documentIds?: unknown };
    const selectedIds = Array.isArray(body.documentIds)
      ? new Set(body.documentIds.filter((x): x is string => typeof x === 'string'))
      : null;
    const forced = selectedIds !== null;

    // Action 1 — re-OCR the target docs. Per-file failures are collected, never silent (a doc whose
    // nudge failed would otherwise look "reprocessed" and stay stuck).
    let reocrQueued = 0;
    const reocrFailed: { documentId: string; reason: string }[] = [];
    for (const doc of documents) {
      // The screening-summary OUTPUT file is not an OCR input (ocr-start skips it) — never re-OCR it.
      if (isScreeningSummaryKey(doc.s3Key)) continue;
      if (forced) {
        if (!selectedIds.has(doc.id)) continue; // only the picked docs
      } else if (terminalKeys.has(doc.s3Key)) {
        continue; // legacy: leave a good read alone
      }
      try {
        if (forced) {
          // hasPages → false so ocr-start re-reads this doc fresh (vision), even if it was already 'read'.
          await prisma.documentPage.deleteMany({ where: { documentId: doc.id } });
        }
        await nudgeDocumentReocr(s3, bucketName, doc);
        reocrQueued += 1;
      } catch (err) {
        reocrFailed.push({ documentId: doc.id, reason: err instanceof Error ? err.message : 'copy failed' });
      }
    }

    // Action 2 — force the extract with a salted hash (see computeTriggerHash's salt contract).
    const requestId = randomUUID();
    const extract = await maybeEnqueueChartExtract(prisma as unknown as AppDb, caseId, { forceSalt: `manual:${requestId}` });

    await prisma.activityLog.create({
      data: {
        caseId,
        veteranId: caseRow.veteranId,
        actorUserId: req.user?.sub,
        action: 'case_reprocessed',
        detailsJson: {
          caseId,
          requestId,
          reocrQueued,
          ...(reocrFailed.length > 0 ? { reocrFailed } : {}),
          extractEnqueued: extract.enqueued,
          ...(extract.reason !== undefined ? { extractReason: extract.reason } : {}),
        },
      },
    });

    res.json({
      data: {
        reocrQueued,
        ...(reocrFailed.length > 0 ? { reocrFailed } : {}),
        extractEnqueued: extract.enqueued,
        ...(extract.reason !== undefined ? { extractReason: extract.reason } : {}),
        requestId,
      },
    });
  });

  // Delete a misuploaded file (Ryan 2026-06-04: "if a file were ever accidentally uploaded to the
  // wrong chart, i need a delete function"). ops_staff may delete too — fixing one's own misupload
  // is RN self-service, not an admin-only escalation. Now that the drafter bundle is veteran-wide, a
  // stray file would pollute EVERY case's draft, so the delete also removes the file's read-status
  // and key-doc rows (keyed by caseId + s3Key) — otherwise an orphan would linger in the bundle and
  // the RN manual-summary queue. Document.delete cascades its OCR pages.
  router.delete('/documents/:id', requireRole(['admin', 'ops_staff']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const document = await prisma.document.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, caseId: true, s3Key: true, case: { select: { veteranId: true } } },
    });
    if (!document) return error(res, 404, 'document_not_found', 'Document was not found.');

    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: document.s3Key }));
    await prisma.$transaction(async (tx) => {
      await tx.document.delete({ where: { id: document.id } });
      // Remove the orphan read-status + key-doc rows for this exact file (filePath === s3Key).
      await tx.fileReadStatus.deleteMany({ where: { caseId: document.caseId, filePath: document.s3Key } });
      await (tx as unknown as { keyDoc: { deleteMany: (a: { where: { caseId: string; filePath: string } }) => Promise<unknown> } })
        .keyDoc.deleteMany({ where: { caseId: document.caseId, filePath: document.s3Key } });
      await tx.activityLog.create({
        data: {
          caseId: document.caseId,
          veteranId: (document as unknown as { case: { veteranId: string } }).case.veteranId,
          actorUserId: req.user?.sub,
          action: 'document_deleted',
          detailsJson: { documentId: document.id, s3Key: document.s3Key },
        },
      });
    });

    res.status(204).send();
  });

  return router;
}
