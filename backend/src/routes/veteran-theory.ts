// GET /cases/:id/veteran-theory — the physician page's LLM restatement of the veteran's OWN causal theory
// (Part B of "Ankle nowhere", Ryan 2026-07-11). A lazy sub-resource (mirrors case-viability.ts): the
// letter-ready panel renders first, this lazy-loads, and on { data: null } the UI falls back to the
// deterministic Part A line. DISPLAY-ONLY and non-influencing — this route is the SINGLE IMPORTER of
// veteran-theory-ai.ts (the drafter-isolation invariant, enforced by veteran-theory-drafter-isolation.test.ts).
//
// DARK behind VETERAN_THEORY_AI_ENABLED: flag off -> { data: null } with NO case read and NO model call
// (zero spend). Unknown case id -> 404. Any failure inside the model call fails open to { data: null }.
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { runVeteranTheoryAi, veteranTheoryAiEnabled } from '../advisory/veteran-theory-ai.js';

export function createVeteranTheoryRouter(db: AppDb): Router {
  const router = Router();
  router.get(
    '/cases/:id/veteran-theory',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      // Flag off -> { data: null } (the UI shows the deterministic Part A line). No case read, no spend.
      if (!veteranTheoryAiEnabled()) {
        res.json({ data: null });
        return;
      }
      const c = await db.case.findFirst({
        where: { id: caseId },
        select: { id: true, claimedCondition: true, veteranStatement: true },
      });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // runVeteranTheoryAi never throws (it fails open to null internally); the extra guard here means a
      // display value can NEVER 500 the physician panel. null -> deterministic fallback client-side.
      let result: Awaited<ReturnType<typeof runVeteranTheoryAi>>;
      try {
        result = await runVeteranTheoryAi({
          caseId,
          claimedCondition: c.claimedCondition ?? '',
          veteranStatement: c.veteranStatement ?? '',
        });
      } catch {
        result = null;
      }
      // costUsd is server-side telemetry (logged) — do NOT ship it to the browser; the UI needs only the
      // display fields. null passes through unchanged (→ deterministic fallback client-side).
      const data = result === null ? null : { theory: result.theory, framing: result.framing, upstream: result.upstream };
      res.json({ data });
    }),
  );
  return router;
}
