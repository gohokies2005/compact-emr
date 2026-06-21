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
import { deriveAiViability, aiRoutePickerEnabled } from '../services/ai-viability.js';
import { fireRecomputeViability } from '../services/recompute-viability-trigger.js';
import { getOrBuildSoapNote, type SoapContext, type SoapOverviewCacheDb } from '../services/soap-overview.js';
import { loadReconciledChartReadiness } from '../services/chart-readiness.js';

export function createCaseViabilityRouter(db: AppDb): Router {
  const router = Router();
  // AI-synthesized SOAP-note Overview (Ryan 2026-06-20) — the model writes a smooth S/O/A/P note from the
  // context the Overview already assembled (the FE POSTs it, like the sanity-impression). ONE bounded
  // Sonnet call, fail-open to null (the card then shows the deterministic verdict line).
  //
  // COST-SAFETY (Ryan 2026-06-21): DB-PERSISTED read-through cache (soap_overviews), keyed by an input
  // FINGERPRINT (hash of the chart inputs that feed the note). On open we SERVE THE STORED note for $0 —
  // the model runs ONLY when the fingerprint changes (new info) or the RN clicks "Regenerate with new info"
  // (body.forceRegenerate). The old in-process Map re-billed Sonnet on every cold Lambda (= every "in and
  // out of charts"). Durable across cold starts. Response: { data, fingerprint, stale, cached }.
  router.post(
    '/cases/:id/soap-overview',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const body = (req.body ?? {}) as SoapContext & { forceRegenerate?: unknown };
      const ctx: SoapContext = { ...body, claimedCondition: String(body.claimedCondition ?? '') };
      const result = await getOrBuildSoapNote(
        db as unknown as SoapOverviewCacheDb,
        caseId,
        ctx,
        { forceRegenerate: body.forceRegenerate === true },
      );
      res.json(result);
    }),
  );
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
      // AI_ROUTE_PICKER_ENABLED is on; the card falls back to the static M-tier engine otherwise.
      // READ-ONLY here (compute:false) — NEVER run the ~22-25s picker call on this synchronous 29s-capped
      // GET (that timed out → card rendered nothing). If there's no fresh persisted plan, fire an async
      // self-invoke to compute it off the request path; the FE polls until it lands (~25s, once).
      const aiViability = await deriveAiViability(db, caseId, { compute: false });
      if (aiViability === null && aiRoutePickerEnabled()) {
        void fireRecomputeViability(caseId); // fire-and-forget; never blocks/​fails the GET
      }
      // Chart-read state for the SOAP traffic light (I2 fix): the calm light goes green only when the
      // chart is actually fully read — an unread/partial chart pulls it to amber. Fail-open: unknown → null
      // (the SOAP treats unknown conservatively). Cheap (no LLM).
      let chartFullyRead: boolean | null = null;
      try {
        const r = await loadReconciledChartReadiness(db, caseId);
        chartFullyRead = r ? (r.ready === true && (r.blockingFiles?.length ?? 0) === 0) : null;
      } catch { chartFullyRead = null; }
      res.json({ data: await deriveCaseViabilityForCase(db, caseId), aiViability, chartFullyRead });
    }),
  );
  return router;
}
