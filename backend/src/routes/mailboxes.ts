import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { currentActor } from '../services/request-actor.js';
import { normalizeEmailAddress } from '../services/email-matching.js';
import type { AppDb } from '../services/db-types.js';

// Feature B — admin management of the Google Workspace mailboxes the gmail-ingest poller monitors
// (Ryan 2026-06-06: "add an email profile to the EMR"). Admin-only. The ingester reads the ACTIVE
// addresses via the internal route (internal-worker.ts). Methods are GET/POST/PATCH/DELETE only — the
// API Gateway does not route PUT (lesson from the quick-note CORS miss).
export function createMailboxesRouter(db: AppDb): Router {
  const router = Router();
  const ADMIN = ['admin'] as const;
  const cleanLabel = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

  router.get('/mailboxes', requireRole([...ADMIN]), asyncHandler(async (_req: Request, res: Response) => {
    const rows = await db.monitoredMailbox.findMany({ orderBy: [{ active: 'desc' }, { address: 'asc' }] });
    res.json({ data: rows });
  }));

  router.post('/mailboxes', requireRole([...ADMIN]), asyncHandler(async (req: Request, res: Response) => {
    const actor = currentActor(req);
    const body = (req.body ?? {}) as { address?: unknown; label?: unknown };
    const address = normalizeEmailAddress(typeof body.address === 'string' ? body.address : '');
    if (!address) throw new HttpError(400, 'bad_request', 'A valid email address is required.', { field: 'address' });
    try {
      const row = await db.monitoredMailbox.create({ data: { address, label: cleanLabel(body.label), addedBy: actor.email ?? actor.id } });
      res.status(201).json({ data: row });
    } catch (e) {
      const isP2002 = typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';
      if (isP2002) throw new HttpError(409, 'conflict', 'That mailbox is already tracked.', { address });
      throw e;
    }
  }));

  router.patch('/mailboxes/:id', requireRole([...ADMIN]), asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { active?: unknown; label?: unknown };
    const data: Record<string, unknown> = {};
    if (typeof body.active === 'boolean') data.active = body.active;
    if (body.label !== undefined) data.label = cleanLabel(body.label);
    if (Object.keys(data).length === 0) throw new HttpError(400, 'bad_request', 'Provide active and/or label.');
    const existing = await db.monitoredMailbox.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw new HttpError(404, 'not_found', 'Mailbox not found', { id });
    const row = await db.monitoredMailbox.update({ where: { id }, data });
    res.json({ data: row });
  }));

  router.delete('/mailboxes/:id', requireRole([...ADMIN]), asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = await db.monitoredMailbox.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw new HttpError(404, 'not_found', 'Mailbox not found', { id });
    await db.monitoredMailbox.delete({ where: { id } });
    res.status(204).end(); // existing logged emails from this mailbox are kept; we just stop polling it
  }));

  return router;
}
