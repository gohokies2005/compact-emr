// GET /cases/:id/viability-card — the RN CaseViabilityCard's data (build plan §4.1, mirrors
// strategy-preview.ts). Computes the caseViability v1 block LIVE via the SAME shared derivation
// the drafter-bundle stamp uses (deriveCaseViabilityForCase → deriveCaseFramingForCase — one
// derivation feeds both, G10). Read-only; never mutates. Info-light only (G9: no EMR chart-fact
// normalization yet); chart-refined is a documented follow-on.
//
// DARK behind EMR_CASE_VIABILITY_ENABLED: flag off → { data: null } (the card renders nothing —
// the flag controls the whole surface). Case vanished mid-derivation → { data: null } (fail open,
// design §5.3 "viability read unavailable"). Unknown case id → 404.

import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { caseViabilityEnabled, deriveCaseViabilityForCase } from '../services/case-viability-stamp.js';
import { deriveAiViability } from '../services/ai-viability.js';

export function createCaseViabilityRouter(db: AppDb): Router {
  const router = Router();
  router.get(
    '/cases/:id/viability-card',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      if (!caseViabilityEnabled()) {
        res.json({ data: null });
        return;
      }
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // The card prefers the AI route-picker plan (the SAME brain the drafter uses) when
      // AI_ROUTE_PICKER_ENABLED is on; deriveAiViability returns null when off / fail-open, and the
      // card falls back to the static M-tier engine. Both returned so the UI degrades gracefully.
      const aiViability = await deriveAiViability(db, caseId);
      res.json({ data: await deriveCaseViabilityForCase(db, caseId), aiViability });
    }),
  );
  return router;
}
