import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { requireRole } from '../auth/roles.js';
import { isCaseDocumentS3Key } from '../services/s3-key-safety.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
      return error(res, 400, 'unsupported_content_type', 'Only PDF, JPG, PNG, DOC, and DOCX uploads are supported.');
    }
    if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      return error(res, 400, 'file_too_large', 'Uploads must be greater than 0 bytes and no larger than 5 MB.', { maxBytes: MAX_UPLOAD_BYTES });
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

  router.get('/documents/:id/download', requireRole(['admin', 'ops_staff']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const document = await prisma.document.findUnique({ where: { id: String(req.params.id) }, select: { id: true, s3Key: true, filename: true } });
    if (!document) return error(res, 404, 'document_not_found', 'Document was not found.');

    const command = new GetObjectCommand({ Bucket: bucketName, Key: document.s3Key, ResponseContentDisposition: `attachment; filename="${sanitizeFilename(document.filename)}"` });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
    res.json({ data: { downloadUrl, expiresInSeconds: DOWNLOAD_TTL_SECONDS } });
  });

  router.delete('/documents/:id', requireRole(['admin']), async (req, res) => {
    if (!bucketName) return error(res, 500, 'missing_bucket_config', 'PHI_BUCKET_NAME is not configured.');
    const document = await prisma.document.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, caseId: true, s3Key: true, case: { select: { veteranId: true } } },
    });
    if (!document) return error(res, 404, 'document_not_found', 'Document was not found.');

    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: document.s3Key }));
    await prisma.$transaction(async (tx) => {
      await tx.document.delete({ where: { id: document.id } });
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
