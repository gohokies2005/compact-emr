import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';
import { parseChartNoteCreate, parseChartNotePatch } from '../services/chart-note-validation.js';

interface RequestActor { readonly sub: string; readonly roles: readonly Role[]; readonly role: Role; }

function currentUser(req: Request): RequestActor {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const priority: readonly Role[] = ['admin', 'physician', 'ops_staff'];
  const role = priority.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role found in JWT');
  return { sub: u.sub, roles: u.roles, role };
}

export function createChartNotesRouter(db: AppDb): Router {
  const router = Router();

  router.get(
    '/veterans/:veteranId/chart-notes',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const veteranId = String(req.params.veteranId);
      const rows = await db.chartNote.findMany({ where: { veteranId }, orderBy: { createdAt: 'desc' } });
      // Resolve the author's Cognito sub → a real NAME, not a UUID (Ryan 2026-06-20, recurring).
      // Batch-look-up the distinct authors; fall back to email, then (last resort) the raw id.
      const subs = [...new Set(rows.map((r) => (r as { createdBy?: string }).createdBy).filter((s): s is string => typeof s === 'string' && s.length > 0))];
      const users = subs.length > 0
        ? await db.appUser.findMany({ where: { cognitoSub: { in: subs } }, select: { cognitoSub: true, name: true, email: true } })
        : [];
      const nameBySub = new Map(users.map((u) => [u.cognitoSub, (u.name && u.name.trim()) || u.email]));
      res.json({ data: rows.map((r) => ({ ...r, createdByName: nameBySub.get((r as { createdBy?: string }).createdBy ?? '') ?? (r as { createdBy?: string }).createdBy ?? 'Staff' })) });
    }),
  );

  router.post(
    '/veterans/:veteranId/chart-notes',
    requireRole(['admin', 'ops_staff', 'physician']), // physician leaves a note when sending a letter back
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const veteranId = String(req.params.veteranId);
      const parsed = parseChartNoteCreate(req.body);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.findUnique({ where: { id: veteranId }, select: { id: true } });
        if (veteran === null) throw new HttpError(404, 'not_found', 'Veteran not found', { veteranId });

        const row = await tx.chartNote.create({ data: { veteranId, body: parsed.body, createdBy: user.sub } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'chart_note_created', veteranId, detailsJson: { noteId: row.id, veteranId } } });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.patch(
    '/chart-notes/:id',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseChartNotePatch(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.chartNote.findFirst({ where: { id }, select: { id: true, veteranId: true, createdBy: true, version: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Chart note not found', { noteId: id });
        if (user.role !== 'admin' && existing.createdBy !== user.sub) {
          throw new HttpError(403, 'forbidden', 'Only the author or an admin may edit this note', { noteId: id });
        }
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Chart note version is stale', { noteId: id, expectedVersion: existing.version, receivedVersion: parsed.version });
        }
        const row = await tx.chartNote.update({ where: { id }, data: { body: parsed.body, version: { increment: 1 } } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'chart_note_updated', veteranId: existing.veteranId, detailsJson: { noteId: id, veteranId: existing.veteranId } } });
        return row;
      });

      res.json({ data: updated });
    }),
  );

  router.delete(
    '/chart-notes/:id',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);

      await db.$transaction(async (tx) => {
        const existing = await tx.chartNote.findFirst({ where: { id }, select: { id: true, veteranId: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Chart note not found', { noteId: id });
        await tx.chartNote.delete({ where: { id } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'chart_note_deleted', veteranId: existing.veteranId, detailsJson: { noteId: id, veteranId: existing.veteranId } } });
      });

      res.status(204).send();
    }),
  );

  return router;
}
