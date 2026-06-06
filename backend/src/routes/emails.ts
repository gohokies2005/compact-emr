import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { currentActor } from '../services/request-actor.js';
import type { AppDb } from '../services/db-types.js';

// Feature B — Email Communications LOG (read-only) + unmatched-queue assignment (Ryan 2026-06-06).
// Port of the local EMR's email_log (ARCHITECTURE.md §3). This is documentation/audit, NOT a client —
// sending stays in the template/Resend path; this only reads + lets an RN assign an unmatched email.
//
// SORT: every list orders by createdAt DESC — the ONE effective-timestamp expression. createdAt is
// always non-null (so no NULLS-FIRST domination bug from inbound rows that use receivedAt not sentAt)
// and ≈ when we received/sent the message. The UI shows the true message time (receivedAt ?? sentAt).
const EMAIL_LOG_ORDER = { createdAt: 'desc' } as const;
const PRESIGN_TTL_SECONDS = 300;

// Fields returned to the log UI. Body is included (expanded view); the collapsed row uses snippet.
const EMAIL_LOG_SELECT = {
  id: true, caseId: true, veteranId: true, direction: true, subject: true, body: true, snippet: true,
  fromAddress: true, toAddress: true, mailbox: true, attachmentsJson: true, receivedAt: true,
  sentAt: true, status: true, createdAt: true,
} as const;

interface Attachment { readonly filename: string; readonly s3Key: string; readonly contentType?: string; readonly sizeBytes?: number }
function readAttachments(json: unknown): Attachment[] {
  if (!Array.isArray(json)) return [];
  return json.filter((a): a is Attachment => typeof a === 'object' && a !== null && typeof (a as Attachment).s3Key === 'string');
}

export function createEmailsRouter(db: AppDb, deps: { bucketName?: string; s3?: S3Client }): Router {
  const router = Router();
  const READ_ROLES = ['admin', 'ops_staff', 'physician'] as const;
  const ASSIGN_ROLES = ['admin', 'ops_staff'] as const;

  // Chart tab — all correspondence with a veteran.
  router.get(
    '/veterans/:id/emails',
    requireRole([...READ_ROLES]),
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await db.email.findMany({ where: { veteranId: String(req.params.id) }, orderBy: EMAIL_LOG_ORDER, select: EMAIL_LOG_SELECT });
      res.json({ data: rows });
    }),
  );

  // Claim tab — the subset tied to this specific claim (caseId match).
  router.get(
    '/cases/:id/emails',
    requireRole([...READ_ROLES]),
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await db.email.findMany({ where: { caseId: String(req.params.id) }, orderBy: EMAIL_LOG_ORDER, select: EMAIL_LOG_SELECT });
      res.json({ data: rows });
    }),
  );

  // Unmatched queue — inbound emails that matched no veteran. An RN assigns them.
  router.get(
    '/emails/unmatched',
    requireRole([...ASSIGN_ROLES]),
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await db.email.findMany({ where: { veteranId: null, direction: 'inbound' }, orderBy: EMAIL_LOG_ORDER, select: EMAIL_LOG_SELECT });
      res.json({ data: rows });
    }),
  );

  // Assign an (unmatched / veteran-level) email to a veteran and/or a claim. Idempotent re-assign OK.
  router.post(
    '/emails/:id/assign',
    requireRole([...ASSIGN_ROLES]),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as { veteranId?: unknown; caseId?: unknown };
      const data: Record<string, string | null> = {};
      if (body.veteranId !== undefined) data.veteranId = body.veteranId === null ? null : String(body.veteranId);
      if (body.caseId !== undefined) data.caseId = body.caseId === null ? null : String(body.caseId);
      if (Object.keys(data).length === 0) throw new HttpError(400, 'bad_request', 'Provide veteranId and/or caseId.');

      const existing = await db.email.findUnique({ where: { id }, select: { id: true } });
      if (existing === null) throw new HttpError(404, 'not_found', 'Email not found', { emailId: id });

      // If a caseId is assigned, derive/keep the veteran from that case so the two stay consistent.
      if (typeof data.caseId === 'string') {
        const c = await db.case.findFirst({ where: { id: data.caseId }, select: { id: true, veteranId: true } });
        if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: data.caseId });
        data.veteranId = c.veteranId;
      }
      const row = await db.email.update({ where: { id }, data, select: EMAIL_LOG_SELECT });
      await db.activityLog.create({ data: { actorUserId: actor.id, action: 'email_assigned', caseId: data.caseId ?? undefined, veteranId: data.veteranId ?? undefined, detailsJson: { emailId: id } } });
      res.json({ data: row });
    }),
  );

  // Presigned download for one attachment. Server re-derives the S3 key from attachmentsJson (never
  // trusts a client key) + validates the index bounds.
  router.get(
    '/emails/:id/attachments/:idx/download',
    requireRole([...READ_ROLES]),
    asyncHandler(async (req: Request, res: Response) => {
      if (!deps.s3 || !deps.bucketName) throw new HttpError(503, 'internal_error', 'Attachment storage is not configured.');
      const id = String(req.params.id);
      const idx = Number.parseInt(String(req.params.idx), 10);
      const row = await db.email.findUnique({ where: { id }, select: { id: true, attachmentsJson: true } });
      if (row === null) throw new HttpError(404, 'not_found', 'Email not found', { emailId: id });
      const attachments = readAttachments(row.attachmentsJson);
      if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) throw new HttpError(404, 'not_found', 'Attachment not found', { emailId: id, idx });
      const url = await getSignedUrl(deps.s3, new GetObjectCommand({ Bucket: deps.bucketName, Key: attachments[idx]!.s3Key }), { expiresIn: PRESIGN_TTL_SECONDS });
      res.json({ data: { url, filename: attachments[idx]!.filename } });
    }),
  );

  return router;
}
