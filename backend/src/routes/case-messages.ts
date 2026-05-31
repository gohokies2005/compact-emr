import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';
import { isAssignedPhysicianForCase } from '../services/physician-resolver.js';
import { parseCaseMessageCreate, parseMarkRead } from '../services/case-message-validation.js';

interface Actor { readonly sub: string; readonly roles: readonly Role[]; readonly role: Role }

function currentUser(req: Request): Actor {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const priority: readonly Role[] = ['admin', 'physician', 'ops_staff'];
  const role = priority.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role in JWT');
  return { sub: u.sub, roles: u.roles, role };
}

export function createCaseMessagesRouter(db: AppDb): Router {
  const router = Router();

  // Participant gate: admin (all) OR the assigned physician OR the assigned RN. ops_staff who is
  // NOT the liaison must not read another case's clinical thread (it can contain PHI back-and-forth).
  async function assertParticipant(req: Request): Promise<{ caseId: string; user: Actor }> {
    const user = currentUser(req);
    const caseId = String(req.params.id);
    const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, assignedPhysicianId: true, assignedRnId: true } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
    if (user.role === 'admin') return { caseId, user };
    if (user.role === 'physician') {
      if (!(await isAssignedPhysicianForCase(db, user.sub, c.assignedPhysicianId))) {
        throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
      }
      return { caseId, user };
    }
    // ops_staff: must be the assigned RN (resolve AppUser.id from cognito sub).
    const me = await db.appUser.findUnique({ where: { cognitoSub: user.sub } });
    if (me === null || me.id !== c.assignedRnId) {
      throw new HttpError(403, 'forbidden', 'You are not the assigned RN for this case.', { caseId });
    }
    return { caseId, user };
  }

  // List the thread (chronological) + unread-for-me count.
  router.get('/cases/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const { caseId, user } = await assertParticipant(req);
    const messages = await db.caseMessage.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
    const unreadCount = await db.caseMessage.count({ where: { caseId, readAt: null, senderSub: { not: user.sub } } });
    res.json({ data: messages, unreadCount });
  }));

  router.post('/cases/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const { caseId, user } = await assertParticipant(req);
    const parsed = parseCaseMessageCreate(req.body);
    const row = await db.caseMessage.create({ data: { caseId, senderSub: user.sub, senderRole: user.role, body: parsed.body } });
    res.status(201).json({ data: row });
  }));

  // Mark counterparty messages read (never self-authored). Optional upToMessageId caps by created_at.
  router.post('/cases/:id/messages/mark-read', asyncHandler(async (req: Request, res: Response) => {
    const { caseId, user } = await assertParticipant(req);
    const { upToMessageId } = parseMarkRead(req.body);
    let createdAtCutoff: Date | undefined;
    if (upToMessageId !== null) {
      const target = await db.caseMessage.findFirst({ where: { id: upToMessageId, caseId } });
      if (target === null) throw new HttpError(404, 'not_found', 'Message not found', { messageId: upToMessageId });
      createdAtCutoff = target.createdAt;
    }
    const result = await db.caseMessage.updateMany({
      where: { caseId, senderSub: { not: user.sub }, readAt: null, ...(createdAtCutoff ? { createdAt: { lte: createdAtCutoff } } : {}) },
      data: { readAt: new Date(), readBySub: user.sub },
    });
    res.json({ data: { markedCount: result.count } });
  }));

  return router;
}
