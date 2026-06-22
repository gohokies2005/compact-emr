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
import { buildDigestForCase } from '../advisory/chartSlice.js';

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
      const claimedCondition = String(body.claimedCondition ?? '');
      // ONE-BRAIN GROUNDING (2026-06-21): the SOAP Assessment/Plan render the SAME route-picker plan the
      // drafter pleads. Read the PERSISTED plan READ-ONLY (compute:false → $0, NO ~22s LLM call on this
      // synchronous path) — deriveAiViability applies its own staleness guards (hash-match + inputClaimed ===
      // live claim + schemaVersion + source), returning null when the flag is off / no plan / stale / wrong
      // condition. On null we DO NOT ground SOAP on a stale plan; the FE-supplied strategy strings remain the
      // fallback (today's behavior). The framing is set SERVER-SIDE and authoritatively — the FE cannot pass a
      // contradicting theory. The plan's own hash is folded into the SOAP fingerprint so a plan recompute
      // (new framing) invalidates the stored SOAP note.
      let routePickerFraming: SoapContext['routePickerFraming'] = null;
      let firedRecompute = false;
      try {
        const plan = await deriveAiViability(db, caseId, { compute: false });
        if (plan && plan.lead && plan.inputClaimed === claimedCondition) {
          // framing + planHash come from ONE row version: deriveAiViability stamps plan.planHash from the SAME
          // row read that produced the framing, so an async recompute between two reads can no longer stamp a
          // NEW hash onto a note built from OLD framing (H3 — no second findFirst here). The hash is the plan's
          // identity for the SOAP fingerprint: a route-picker recompute that changes the framing changes the
          // hash → invalidates the stored SOAP note.
          routePickerFraming = {
            framing: plan.lead.framing,
            cfr_basis: plan.lead.cfr_basis,
            mechanism: plan.lead.mechanism,
            rationale: plan.lead.rationale,
            counterargument: plan.lead.counterargument,
            confidence: plan.lead.confidence,
            viability: plan.viability,
            planHash: plan.planHash ?? '',
          };
        } else if (aiRoutePickerEnabled()) {
          // H2: the route-picker is ON but there is NO USABLE warm plan — either compute:false returned null
          // (first open / invalidated) OR the persisted plan is for a different/stale claimed condition
          // (inputClaimed !== live claim). Either way the note is NOT grounded this open. Fire the SAME
          // off-request async recompute the /viability-card GET fires (fire-and-forget; never blocks/fails this
          // POST and triggers NO LLM on this synchronous path) so a CURRENT plan is warm on the NEXT open. We
          // record firedRecompute so the ungrounded fallback note is NOT persisted (noStore below) — else it
          // would be served $0 forever and mask the warming plan; once the plan lands, its planHash changes the
          // fingerprint and the next open grounds correctly.
          void fireRecomputeViability(caseId);
          firedRecompute = true;
        }
      } catch { routePickerFraming = null; /* fail-open: SOAP falls back to strategy strings */ }
      // SAME-BRAIN CHART READING (2026-06-21, Zimmelman): feed the SOAP the SAME extracted-document digest Ask
      // Aegis cites (advisory/chartSlice buildDigestForCase). The SOAP was previously fed structured columns
      // ONLY (the FE-POSTed keyFacts/scConditions/problems) and missed records Ask Aegis surfaced. Built
      // SERVER-SIDE and set authoritatively (override any FE-supplied chartDigest — the FE cannot inject
      // document text). Folded into renderContext → it also moves the SOAP fingerprint, so the stored note
      // invalidates when the chart's extracted text changes. Fail-open: a digest hiccup → null (no document
      // grounding, the note still builds from structured facts).
      let chartDigest: string | null = null;
      try { chartDigest = await buildDigestForCase(db, caseId); }
      catch { chartDigest = null; }
      const ctx: SoapContext = { ...body, claimedCondition, routePickerFraming, chartDigest };
      // H2: when we just fired a recompute because no usable warm plan exists AND the caller did not explicitly
      // force a regenerate, serve a fresh strategy fallback note for THIS open but do NOT persist it — a
      // persisted strategy note would be served for $0 on later opens and hide the route-picker plan that is
      // now warming. (forceRegenerate still persists: the RN explicitly asked to spend + store.) A grounded
      // note (plan present) always persists as before — $0-on-reopen holds.
      const result = await getOrBuildSoapNote(
        db as unknown as SoapOverviewCacheDb,
        caseId,
        ctx,
        { forceRegenerate: body.forceRegenerate === true, noStore: firedRecompute && body.forceRegenerate !== true },
      );
      // H1: return the grounded framing so the FE headline matches the Assessment. When grounded, the FE
      // PREFERS routePickerFraming.framing for the bold headline; when null it falls back to strategy.primaryArgument.
      res.json({ ...result, grounded: routePickerFraming !== null, routePickerFraming });
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
