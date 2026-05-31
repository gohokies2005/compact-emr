import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, PhysicianRecord } from '../services/db-types.js';
import { parsePhysicianCreate, parsePhysicianPatch, parseSignaturePresign } from '../services/physician-validation.js';
import { buildPhysicianSignatureKey, isPhysicianSignatureS3Key } from '../services/s3-key-safety.js';

const SIGNATURE_TTL_SECONDS = 5 * 60;
// Setting a physician inactive while they hold a case in one of these states would lock them
// out of their own assigned work (resolveCurrentPhysician returns null for inactive). Block it.
const IN_FLIGHT_STATUSES = ['drafting', 'physician_review', 'correction_requested', 'correction_review'];

interface PhysiciansRouterDeps { s3?: S3Client; bucketName?: string }

/** Public projection: omit the raw signature key, expose a hasSignature flag instead.
 *  NPI/license are NOT PHI — they print on every letter — so they are returned. */
function toPublic(p: PhysicianRecord) {
  return {
    id: p.id,
    cognitoSub: p.cognitoSub,
    fullName: p.fullName,
    npi: p.npi,
    specialty: p.specialty,
    medicalLicense: p.medicalLicense,
    email: p.email,
    phone: p.phone,
    hasSignature: p.signatureImageS3Key !== null,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    version: p.version,
  };
}

/** Map a Prisma unique-constraint violation (P2002 on npi / cognito_sub) to a clear 409. */
function rethrowUnique(err: unknown): never {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e && e.code === 'P2002') {
    const target = JSON.stringify(e.meta?.target ?? '');
    if (target.includes('cognito')) throw new HttpError(409, 'conflict', 'This Cognito user is already linked to another physician.', { field: 'cognitoSub' });
    if (target.includes('npi')) throw new HttpError(409, 'conflict', 'A physician with this NPI already exists.', { field: 'npi' });
    throw new HttpError(409, 'conflict', 'A unique field already exists.', {});
  }
  throw err as Error;
}

export function createPhysiciansRouter(db: AppDb, deps: PhysiciansRouterDeps = {}): Router {
  const router = Router();
  const s3 = (): S3Client => deps.s3 ?? new S3Client({});
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // List (for assignment pickers). ops_staff needs read to assign a physician to a case.
  router.get('/physicians', requireRole(['admin', 'ops_staff']), asyncHandler(async (_req: Request, res: Response) => {
    const rows = await db.physician.findMany({ orderBy: { fullName: 'asc' } });
    res.json({ data: rows.map(toPublic) });
  }));

  router.get('/physicians/:id', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const row = await db.physician.findUnique({ where: { id: String(req.params.id) } });
    if (row === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId: String(req.params.id) });
    res.json({ data: toPublic(row) });
  }));

  router.post('/physicians', requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
    const parsed = parsePhysicianCreate(req.body);
    const row = await db.physician.create({
      data: {
        id: randomUUID(),
        fullName: parsed.fullName,
        npi: parsed.npi,
        specialty: parsed.specialty,
        medicalLicense: parsed.medicalLicense,
        email: parsed.email,
        phone: parsed.phone,
        cognitoSub: parsed.cognitoSub,
      },
    }).catch(rethrowUnique);
    res.status(201).json({ data: toPublic(row) });
  }));

  router.patch('/physicians/:id', requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { version, data, changedFields } = parsePhysicianPatch(req.body);
    const current = await db.physician.findUnique({ where: { id } });
    if (current === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId: id });
    if (current.version !== version) {
      throw new HttpError(409, 'conflict', 'Physician version is stale', { physicianId: id, expectedVersion: current.version, receivedVersion: version });
    }
    // Don't strand in-flight cases: refuse to deactivate a physician who still has assigned work.
    if (data.active === false && current.active === true) {
      const inFlight = await db.case.count({ where: { assignedPhysicianId: id, status: { in: IN_FLIGHT_STATUSES } } });
      if (inFlight > 0) {
        throw new HttpError(409, 'conflict', `Cannot deactivate: physician has ${inFlight} in-flight case(s). Reassign them first.`, { physicianId: id, inFlightCount: inFlight });
      }
    }
    const row = await db.physician.update({ where: { id }, data: { ...data, version: { increment: 1 } } }).catch(rethrowUnique);
    void changedFields;
    res.json({ data: toPublic(row) });
  }));

  // Signature upload: presign -> client PUTs the PNG -> register the key.
  router.post('/physicians/:id/signature/presign', requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
    const bucketName = bucket();
    if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
    const id = String(req.params.id);
    const exists = await db.physician.findUnique({ where: { id } });
    if (exists === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId: id });
    const { contentType, sizeBytes } = parseSignaturePresign(req.body);
    const s3Key = buildPhysicianSignatureKey(id, randomUUID());
    const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({
      Bucket: bucketName, Key: s3Key, ContentType: contentType, ContentLength: sizeBytes, ServerSideEncryption: 'aws:kms',
    }), { expiresIn: SIGNATURE_TTL_SECONDS });
    res.json({ data: { uploadUrl, s3Key, expiresInSeconds: SIGNATURE_TTL_SECONDS, requiredHeaders: { 'content-type': contentType, 'x-amz-server-side-encryption': 'aws:kms' } } });
  }));

  router.post('/physicians/:id/signature', requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key : '';
    if (!isPhysicianSignatureS3Key(s3Key) || !s3Key.startsWith(`physician-signatures/${id}/`)) {
      throw new HttpError(400, 'bad_request', 's3Key does not match the safe physician-signatures/<id>/<uuid>-signature.png pattern for this physician.', { field: 's3Key' });
    }
    const current = await db.physician.findUnique({ where: { id } });
    if (current === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId: id });
    const row = await db.physician.update({ where: { id }, data: { signatureImageS3Key: s3Key, version: { increment: 1 } } });
    res.json({ data: toPublic(row) });
  }));

  router.get('/physicians/:id/signature/download', requireRole(['admin']), asyncHandler(async (req: Request, res: Response) => {
    const bucketName = bucket();
    if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
    const row = await db.physician.findUnique({ where: { id: String(req.params.id) } });
    if (row === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId: String(req.params.id) });
    if (row.signatureImageS3Key === null) throw new HttpError(404, 'not_found', 'No signature on file for this physician.', { physicianId: row.id });
    const downloadUrl = await getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucketName, Key: row.signatureImageS3Key }), { expiresIn: SIGNATURE_TTL_SECONDS });
    res.json({ data: { downloadUrl, expiresInSeconds: SIGNATURE_TTL_SECONDS } });
  }));

  return router;
}
