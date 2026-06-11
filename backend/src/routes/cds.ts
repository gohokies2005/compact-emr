import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';
import { evaluateAndPersistCds } from '../services/cds-run.js';

function actorSub(req: Request): string {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return u.sub;
}

export function createCdsRouter(db: AppDb): Router {
  const router = Router();

  router.post(
    '/cases/:id/cds',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const sub = actorSub(req);
      const id = String(req.params.id);

      // CDS is UNWIRED by default (Ryan 2026-06-03 — removed as a workflow + error surface; the
      // stale "not supportable" verdict confused more than it helped). All the engine code is kept
      // intact (cdsEngine.ts); flip CDS_ENABLED='on' to restore. When off, the route no-ops with a
      // disabled marker so the UI can hide the panel and the "Re-run CDS" button can't error.
      if (process.env.CDS_ENABLED !== 'on') {
        res.json({ data: { disabled: true, verdict: 'disabled', message: 'Clinical Decision Support is turned off.' } });
        return;
      }

      // Evaluate + persist via the shared core (cds-run.ts — keystone pkg 5: one copy for this
      // route and the post-merge restamp hook). The RN-triggered run is an explicit staff action →
      // cdsStampSource='manual', which makes the verdict immutable to the hook's auto-refresh.
      const rationale = await evaluateAndPersistCds(db, id, { actorUserId: sub, stampSource: 'manual' });
      if (rationale === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

      res.json({ data: rationale });
    }),
  );

  return router;
}
