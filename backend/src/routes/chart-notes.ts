import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';
import { parseChartNoteCreate, parseChartNotePatch } from '../services/chart-note-validation.js';
import { resolveActorNames, pickDisplayName } from '../services/actor-name-resolver.js';

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
      // Resolve the author's Cognito sub → a real NAME, not a UUID (Ryan 2026-06-20/24, recurring).
      // Shared resolver checks BOTH app_users AND the physician directory (a physician-authored note
      // used to leak its sub) and never returns a raw id (unknown → "Staff", system → "System").
      const nameBySub = await resolveActorNames(db, rows.map((r) => (r as { createdBy?: string }).createdBy));
      res.json({ data: rows.map((r) => {
        const sub = (r as { createdBy?: string }).createdBy ?? '';
        return { ...r, createdByName: nameBySub.get(sub) ?? pickDisplayName(sub, { users: new Map(), physicians: new Map() }) };
      }) });
    }),
  );

  // Latest quick note for a veteran (dashboard / case Overview surfaces the MOST-RECENT quick note,
  // Ryan 2026-06-21). Uses the (veteran_id, is_quick_note, created_at) index; returns null when the
  // veteran has no quick note yet. Cheaper than pulling the whole notes list just to read the latest.
  router.get(
    '/veterans/:veteranId/chart-notes/latest-quick',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const veteranId = String(req.params.veteranId);
      const row = await db.chartNote.findFirst({ where: { veteranId, isQuickNote: true }, orderBy: { createdAt: 'desc' } });
      if (row === null) { res.json({ data: null }); return; }
      const sub = (row as { createdBy?: string }).createdBy ?? '';
      const nameBySub = await resolveActorNames(db, [sub]);
      const createdByName = nameBySub.get(sub) ?? pickDisplayName(sub, { users: new Map(), physicians: new Map() });
      res.json({ data: { ...row, createdByName } });
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

        const row = await tx.chartNote.create({ data: { veteranId, body: parsed.body, createdBy: user.sub, isQuickNote: parsed.isQuickNote } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: parsed.isQuickNote ? 'quick_note_created' : 'chart_note_created', veteranId, detailsJson: { noteId: row.id, veteranId, isQuickNote: parsed.isQuickNote } } });
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
        const existing = await tx.chartNote.findFirst({ where: { id }, select: { id: true, veteranId: true, createdBy: true, version: true, isQuickNote: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Chart note not found', { noteId: id });
        // A QUICK note is a SHARED operational scratchpad (the case-header tag, e.g. "Free intake-
        // Facebook."), so ANY ops_staff/admin may edit it regardless of who wrote it — an RN must be able
        // to fix another RN's or the system's quick note (Ryan 2026-07-18, 403 on a free-FB intake).
        // A regular clinical chart note stays author-or-admin for documentation-integrity.
        if (!existing.isQuickNote && user.role !== 'admin' && existing.createdBy !== user.sub) {
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
