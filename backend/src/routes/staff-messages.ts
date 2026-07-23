import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role, StaffMessageRecipientRecord } from '../services/db-types.js';
import { isAssignedPhysicianForCase } from '../services/physician-resolver.js';
import { isRecord, badRequest, requiredNonEmptyString, optionalString } from '../services/validation-helpers.js';
import {
  isStaffMessageAttachmentS3Key,
  resolveRoleAlias,
  expandRecipients,
  countUnreadThreads,
  canAccessThread,
  type ActiveMember,
  type RawRecipient,
  type RoleAlias,
} from '../services/staff-message-access.js';

interface Actor { readonly sub: string; readonly roles: readonly Role[]; readonly role: Role }

const MAX_BODY = 4000;
const MAX_SUBJECT = 200;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const INBOX_PAGE_SIZE = 50;

// Mirror the documents.ts / intakes.ts allowlist + extension-inference for .txt (Jotform/S3 often
// stamp a .txt as application/octet-stream). Same map as intakes.effectiveContentType.
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/html',
]);
const EXT_CONTENT_TYPE: Record<string, string> = {
  txt: 'text/plain', pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html', htm: 'text/html', // VA Rated-Disabilities / Blue Button HTML (E4, 2026-06-13)
};
function effectiveContentType(name: string | undefined, declared: string): string {
  if (ALLOWED_CONTENT_TYPES.has(declared)) return declared;
  const ext = (name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext !== undefined && EXT_CONTENT_TYPE[ext] !== undefined ? EXT_CONTENT_TYPE[ext] : declared;
}
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 180) || 'file';
}

function currentUser(req: Request): Actor {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const priority: readonly Role[] = ['admin', 'physician', 'ops_staff'];
  const role = priority.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role in JWT');
  return { sub: u.sub, roles: u.roles, role };
}

interface StaffMessagesDeps {
  s3?: { send: (cmd: unknown) => Promise<unknown> } | S3Client;
  bucketName?: string | undefined;
}

export function createStaffMessagesRouter(db: AppDb, deps: StaffMessagesDeps = {}): Router {
  const router = Router();
  const s3 = deps.s3;
  const bucketName = deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // ── Case-access gate (mirrors case-messages.ts assertParticipant). Returns whether the user has
  //    case-collaboration access; throws 404 only when the case truly does not exist. Used both as a
  //    hard gate (case-scoped routes) and as a soft fact (thread access on a linked thread). ──
  async function caseAccess(caseId: string, user: Actor): Promise<boolean> {
    const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, assignedPhysicianId: true, assignedRnId: true } });
    if (c === null) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'physician') {
      return isAssignedPhysicianForCase(db, user.sub, (c as { assignedPhysicianId: string | null }).assignedPhysicianId);
    }
    // ops_staff (RN liaisons + ops) work the WHOLE pipeline and can already SEE every case in the EMR, so for
    // messaging COLLABORATION any ops_staff may link/discuss any case. Restricting to the assigned RN blocked a
    // legitimate "message Kim about case X" flow with a 403 (Ryan 2026-07-23, Johnson case). The case must
    // exist (checked above). This is case-collaboration access, not a new PHI grant beyond what ops_staff has.
    if (user.role === 'ops_staff') return true;
    // Any other staff role: fall back to the assigned-RN match (defensive — ops_staff is the only non-admin/
    // non-physician role today).
    const me = await db.appUser.findUnique({ where: { cognitoSub: user.sub } });
    return me !== null && (me as { id: string }).id === (c as { assignedRnId: string | null }).assignedRnId;
  }

  // Build the active-member pool used to expand role aliases ('all_rns'|'all_physicians'|'admin').
  async function activeMembers(): Promise<ActiveMember[]> {
    const staff = await db.appUser.findMany({ where: { active: true }, include: { roles: true } });
    const physicians = await db.physician.findMany({ where: { active: true } });
    const members: ActiveMember[] = [];
    for (const u of staff) {
      const roles = (u.roles ?? []).map((r) => r.role);
      if (roles.includes('ops_staff')) members.push({ sub: u.cognitoSub, alias: 'all_rns' });
      if (roles.includes('admin')) members.push({ sub: u.cognitoSub, alias: 'admin' });
    }
    for (const p of physicians) {
      if (p.cognitoSub) members.push({ sub: p.cognitoSub, alias: 'all_physicians' });
    }
    return members;
  }

  // Load a thread's recipient rows + messages + (the live access decision) for `user`. Throws 404 if
  // the thread does not exist, 403 if access is denied.
  async function loadThreadForAccess(threadId: string, user: Actor): Promise<{
    messages: readonly { id: string; caseId: string | null; authorSub: string; subject: string | null; body: string; createdAt: Date }[];
    recipients: readonly StaffMessageRecipientRecord[];
    caseId: string | null;
    myRecipient: StaffMessageRecipientRecord | null;
  }> {
    const messages = await db.staffMessage.findMany({ where: { threadId }, orderBy: { createdAt: 'asc' } });
    if (messages.length === 0) throw new HttpError(404, 'not_found', 'Thread not found', { threadId });
    const recipients = await db.staffMessageRecipient.findMany({ where: { threadId } });
    const caseId = messages[0]!.caseId;
    const isAuthor = messages.some((m) => m.authorSub === user.sub);
    const myRecipient = recipients.find((r) => r.recipientSub === user.sub) ?? null;
    const isRecipient = myRecipient !== null;
    const isCaseLinked = caseId !== null;
    const hasCaseAccess = isCaseLinked ? await caseAccess(caseId, user) : false;
    if (!canAccessThread({ isCaseLinked, hasCaseAccess, isAuthor, isRecipient })) {
      throw new HttpError(403, 'forbidden', 'You do not have access to this thread.', { threadId });
    }
    return { messages, recipients, caseId, myRecipient };
  }

  function parseAttachmentIds(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) badRequest('attachmentIds must be an array of strings', { field: 'attachmentIds' });
    const ids: string[] = [];
    for (const v of value as unknown[]) {
      if (typeof v !== 'string' || v.trim() === '') badRequest('each attachmentId must be a non-empty string', { field: 'attachmentIds' });
      ids.push((v as string).trim());
    }
    return ids;
  }

  // ── POST /messages — send a NEW thread ──
  router.post('/messages', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    if (!isRecord(req.body)) badRequest('Request body must be an object');
    const body = requiredNonEmptyString(req.body, 'body', MAX_BODY);
    const subject = requiredNonEmptyString(req.body, 'subject', MAX_SUBJECT); // required on a new thread
    const caseId = optionalString(req.body, 'caseId', 200);
    const rawRecipients = req.body.recipients;
    if (!Array.isArray(rawRecipients)) badRequest('recipients must be an array', { field: 'recipients' });
    const attachmentIds = parseAttachmentIds(req.body.attachmentIds);

    // A case-linked thread requires the author to have case access.
    if (caseId !== null && !(await caseAccess(caseId, user))) {
      throw new HttpError(403, 'forbidden', 'You do not have access to that case.', { caseId });
    }

    const members = await activeMembers();
    const expanded = expandRecipients(rawRecipients as RawRecipient[], user.sub, (alias: RoleAlias) => resolveRoleAlias(alias, members));
    if (expanded.selfOnly) throw new HttpError(400, 'bad_request', 'A message must have at least one recipient other than yourself.', { reason: 'self_only' });
    if (!expanded.hasTo) throw new HttpError(400, 'bad_request', 'At least one "to" recipient is required.', { reason: 'no_to' });

    const threadId = randomUUID();
    const created = await db.$transaction(async (tx) => {
      const message = await tx.staffMessage.create({ data: { threadId, caseId, authorSub: user.sub, subject, body } });
      // Snapshot recipient rows. The author is NOT a recipient row (implicit participant).
      await tx.staffMessageRecipient.createMany({
        data: expanded.recipients.map((r) => ({ threadId, recipientSub: r.sub, kind: r.kind, addedBySub: user.sub, readAt: null })),
      });
      if (attachmentIds.length > 0) {
        await tx.staffMessageAttachment.updateMany({ where: { id: { in: attachmentIds }, messageId: null, uploadedBySub: user.sub }, data: { messageId: message.id } });
      }
      await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'staff_message_sent', ...(caseId !== null ? { caseId } : {}), detailsJson: { threadId, messageId: message.id, recipientCount: expanded.recipients.length } } });
      return message;
    });
    res.status(201).json({ data: { threadId, messageId: created.id } });
  }));

  // ── POST /messages/:threadId/reply — reply-all (inherits recipients + caseId) ──
  router.post('/messages/:threadId/reply', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const threadId = String(req.params.threadId);
    if (!isRecord(req.body)) badRequest('Request body must be an object');
    const body = requiredNonEmptyString(req.body, 'body', MAX_BODY);
    const attachmentIds = parseAttachmentIds(req.body.attachmentIds);

    const { caseId, recipients } = await loadThreadForAccess(threadId, user); // access-gated

    const created = await db.$transaction(async (tx) => {
      const message = await tx.staffMessage.create({ data: { threadId, caseId, authorSub: user.sub, subject: null, body } });
      // Re-flip unread for every recipient EXCEPT the reply author; the reply author's own row -> read.
      await tx.staffMessageRecipient.updateMany({ where: { threadId, recipientSub: { not: user.sub } }, data: { readAt: null, archivedAt: null } });
      await tx.staffMessageRecipient.updateMany({ where: { threadId, recipientSub: user.sub }, data: { readAt: new Date() } });
      if (attachmentIds.length > 0) {
        await tx.staffMessageAttachment.updateMany({ where: { id: { in: attachmentIds }, messageId: null, uploadedBySub: user.sub }, data: { messageId: message.id } });
      }
      await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'staff_message_replied', ...(caseId !== null ? { caseId } : {}), detailsJson: { threadId, messageId: message.id } } });
      return message;
    });
    res.status(201).json({ data: { threadId, messageId: created.id, recipientCount: recipients.length } });
  }));

  // ── GET /messages/inbox — threads I participate in (recipient OR case-collaborator on linked) ──
  router.get('/messages/inbox', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const limit = Math.min(Number(req.query.limit) || INBOX_PAGE_SIZE, INBOX_PAGE_SIZE);

    // Threads where I am a recipient (the common case + the only source of unread badges).
    const myRecipientRows = await db.staffMessageRecipient.findMany({ where: { recipientSub: user.sub } });
    const threadIds = [...new Set(myRecipientRows.map((r) => r.threadId))];
    // Threads I authored (so I see my own sent threads even with no recipient row).
    const authored = await db.staffMessage.findMany({ where: { authorSub: user.sub }, orderBy: { createdAt: 'desc' } });
    for (const m of authored) if (!threadIds.includes(m.threadId)) threadIds.push(m.threadId);

    const threads: unknown[] = [];
    for (const threadId of threadIds) {
      const messages = await db.staffMessage.findMany({ where: { threadId }, orderBy: { createdAt: 'asc' } });
      if (messages.length === 0) continue;
      const last = messages[messages.length - 1]!;
      const first = messages[0]!;
      const myRow = myRecipientRows.find((r) => r.threadId === threadId) ?? null;
      if (myRow?.archivedAt != null) continue; // archived stays hidden until a reply un-archives it
      threads.push({
        threadId,
        subject: first.subject,
        caseId: first.caseId,
        lastMessageBody: last.body,
        lastMessageAt: last.createdAt,
        lastAuthorSub: last.authorSub,
        messageCount: messages.length,
        unread: myRow ? myRow.readAt === null : false,
      });
    }
    threads.sort((a, b) => (b as { lastMessageAt: Date }).lastMessageAt.getTime() - (a as { lastMessageAt: Date }).lastMessageAt.getTime());
    res.json({ data: threads.slice(0, limit), unreadCount: countUnreadThreads(myRecipientRows) });
  }));

  // ── GET /messages/unread-count — distinct unread THREADS for me ──
  router.get('/messages/unread-count', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const myRecipientRows = await db.staffMessageRecipient.findMany({ where: { recipientSub: user.sub, readAt: null } });
    res.json({ data: { unreadCount: countUnreadThreads(myRecipientRows) } });
  }));

  // ── GET /messages/threads/:threadId — full thread (access-gated) ──
  router.get('/messages/threads/:threadId', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const threadId = String(req.params.threadId);
    const { messages, recipients } = await loadThreadForAccess(threadId, user);

    const messageIds = messages.map((m) => m.id);
    const attachments = messageIds.length > 0
      ? await db.staffMessageAttachment.findMany({ where: { messageId: { in: messageIds } } })
      : [];
    res.json({
      data: {
        threadId,
        caseId: messages[0]!.caseId,
        subject: messages[0]!.subject,
        messages: messages.map((m) => ({
          id: m.id, authorSub: m.authorSub, body: m.body, subject: m.subject, createdAt: m.createdAt,
          attachments: attachments.filter((a) => a.messageId === m.id).map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: String(a.sizeBytes) })),
        })),
        recipients: recipients.map((r) => ({ recipientSub: r.recipientSub, kind: r.kind, readAt: r.readAt })),
      },
    });
  }));

  // ── POST /messages/threads/:threadId/read — mark read up to messageId for me ──
  router.post('/messages/threads/:threadId/read', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const threadId = String(req.params.threadId);
    await loadThreadForAccess(threadId, user); // access-gated
    const result = await db.staffMessageRecipient.updateMany({ where: { threadId, recipientSub: user.sub, readAt: null }, data: { readAt: new Date() } });
    res.json({ data: { markedCount: result.count } });
  }));

  // ── GET /cases/:id/staff-messages — case-linked threads for a case (case-access gated) ──
  router.get('/cases/:id/staff-messages', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    const caseId = String(req.params.id);
    const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
    if (!(await caseAccess(caseId, user))) throw new HttpError(403, 'forbidden', 'You do not have access to that case.', { caseId });

    const messages = await db.staffMessage.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
    const byThread = new Map<string, typeof messages[number][]>();
    for (const m of messages) {
      const arr = byThread.get(m.threadId) ?? [];
      arr.push(m);
      byThread.set(m.threadId, arr);
    }
    const myRows = await db.staffMessageRecipient.findMany({ where: { recipientSub: user.sub } });
    const threads = [...byThread.entries()].map(([threadId, msgs]) => {
      const last = msgs[msgs.length - 1]!;
      const myRow = myRows.find((r) => r.threadId === threadId) ?? null;
      return { threadId, subject: msgs[0]!.subject, caseId, lastMessageBody: last.body, lastMessageAt: last.createdAt, lastAuthorSub: last.authorSub, messageCount: msgs.length, unread: myRow ? myRow.readAt === null : false };
    });
    threads.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
    res.json({ data: threads });
  }));

  // ── POST /messages/attachments/presign — presign a PUT (mirror documents presign) ──
  router.post('/messages/attachments/presign', asyncHandler(async (req: Request, res: Response) => {
    currentUser(req);
    if (!s3 || !bucketName) throw new HttpError(500, 'internal_error', 'PHI_BUCKET_NAME / S3 is not configured.', { reason: 'missing_bucket_config' });
    if (!isRecord(req.body)) badRequest('Request body must be an object');
    const filename = requiredNonEmptyString(req.body, 'filename', 255);
    const declared = typeof req.body.contentType === 'string' ? req.body.contentType : '';
    const sizeBytes = typeof req.body.sizeBytes === 'number' && Number.isFinite(req.body.sizeBytes) ? req.body.sizeBytes : undefined;
    if (sizeBytes === undefined) badRequest('sizeBytes is required', { field: 'sizeBytes' });
    if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) throw new HttpError(400, 'bad_request', 'Uploads must be greater than 0 bytes and no larger than 50 MB.', { reason: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES });
    const contentType = effectiveContentType(filename, declared);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new HttpError(400, 'bad_request', 'Only PDF, JPG, PNG, DOC, DOCX, and TXT uploads are supported.', { reason: 'unsupported_content_type' });

    const s3Key = `message-attachments/${randomUUID()}/${randomUUID()}-${sanitizeFilename(filename)}`;
    const command = new PutObjectCommand({ Bucket: bucketName, Key: s3Key, ContentType: contentType, ContentLength: sizeBytes, ServerSideEncryption: 'aws:kms' });
    const uploadUrl = await getSignedUrl(s3 as S3Client, command, { expiresIn: UPLOAD_TTL_SECONDS });
    res.json({ data: { uploadUrl, s3Key, contentType, expiresInSeconds: UPLOAD_TTL_SECONDS, requiredHeaders: { 'content-type': contentType, 'x-amz-server-side-encryption': 'aws:kms' } } });
  }));

  // ── POST /messages/attachments/register — create a pending (messageId=null) attachment row ──
  router.post('/messages/attachments/register', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    if (!isRecord(req.body)) badRequest('Request body must be an object');
    const filename = requiredNonEmptyString(req.body, 'filename', 255);
    const s3Key = requiredNonEmptyString(req.body, 's3Key', 500);
    const declared = typeof req.body.contentType === 'string' ? req.body.contentType : '';
    const sizeBytes = typeof req.body.sizeBytes === 'number' && Number.isFinite(req.body.sizeBytes) ? req.body.sizeBytes : undefined;
    if (sizeBytes === undefined) badRequest('sizeBytes is required', { field: 'sizeBytes' });
    if (!isStaffMessageAttachmentS3Key(s3Key)) throw new HttpError(400, 'bad_request', 's3Key does not match the safe message-attachments/<uuid>/<uuid>-<filename> pattern.', { reason: 'invalid_s3_key' });
    const contentType = effectiveContentType(filename, declared);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new HttpError(400, 'bad_request', 'Unsupported attachment content type.', { reason: 'unsupported_content_type' });

    const row = await db.staffMessageAttachment.create({ data: { messageId: null, filename, contentType, sizeBytes: BigInt(sizeBytes), s3Key, uploadedBySub: user.sub } });
    res.status(201).json({ data: { attachmentId: row.id, filename: row.filename, contentType: row.contentType, sizeBytes: String(row.sizeBytes) } });
  }));

  // ── GET /messages/attachments/:id/download — participant-gated signed GET ──
  router.get('/messages/attachments/:id/download', asyncHandler(async (req: Request, res: Response) => {
    const user = currentUser(req);
    if (!s3 || !bucketName) throw new HttpError(500, 'internal_error', 'PHI_BUCKET_NAME / S3 is not configured.', { reason: 'missing_bucket_config' });
    const id = String(req.params.id);
    const att = await db.staffMessageAttachment.findUnique({ where: { id } });
    if (att === null) throw new HttpError(404, 'not_found', 'Attachment not found', { id });
    if (att.messageId === null) throw new HttpError(404, 'not_found', 'Attachment is not yet bound to a message.', { id });
    // Resolve the owning thread, then run the SAME thread-access check BEFORE signing.
    const message = await db.staffMessage.findUnique({ where: { id: att.messageId } });
    if (message === null) throw new HttpError(404, 'not_found', 'Owning message not found', { id });
    await loadThreadForAccess(message.threadId, user); // throws 403 if not a participant

    const command = new GetObjectCommand({ Bucket: bucketName, Key: att.s3Key, ResponseContentDisposition: `attachment; filename="${sanitizeFilename(att.filename)}"` });
    const downloadUrl = await getSignedUrl(s3 as S3Client, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
    res.json({ data: { downloadUrl, expiresInSeconds: DOWNLOAD_TTL_SECONDS } });
  }));

  return router;
}
