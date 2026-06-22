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
import { getAiViabilityState, aiRoutePickerEnabled } from '../services/ai-viability.js';
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
        // Reliability-aware read: a 'ready' plan grounds the note; on a cold 'none' we fire the off-request
        // recompute (so the next open grounds), but we do NOT re-fire on 'error'/'computing' (that would loop
        // the same failing call — the Zimmelman bug). On 'error'/'computing' the note simply falls back to the
        // strategy strings for THIS open (noStore, so it does not mask the warming/failed state).
        const aiState = await getAiViabilityState(db, caseId, { compute: false });
        const plan = aiState.status === 'ready' ? aiState.card : null;
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
          // The route-picker is ON but there is NO USABLE warm plan this open: either the state is cold ('none'),
          // a compute is in flight ('computing'), the last compute failed ('error'), or the persisted plan is
          // for a different/stale claimed condition (inputClaimed !== live claim → status 'ready' but skipped
          // above). In every case the note is NOT grounded this open, so we serve a strategy fallback and do NOT
          // persist it (noStore) — it must not mask the warming/failed plan. We fire the off-request recompute
          // ONLY when cold ('none') or a stale-condition 'ready' (treated like cold); we do NOT re-fire on
          // 'error'/'computing' (that would loop the same failing call — the Zimmelman infinite-loop bug). On
          // 'error' the FE's retry button drives the synchronous compute endpoint instead.
          if (aiState.status === 'none' || aiState.status === 'ready') {
            void fireRecomputeViability(caseId);
          }
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
      // GET (that timed out → card rendered nothing).
      //
      // RELIABILITY (Ryan 2026-06-21, Zimmelman): we now return the discriminated STATE — ready / computing /
      // error / none — so the FE shows an HONEST surface (the grounded plan, a spinner, or "analysis failed —
      // retry") and NEVER a misleading "Not supportable" resting verdict on a missing/failed plan. We fire the
      // off-request recompute ONLY on a cold 'none' (no plan, none in flight, no recorded failure) — NOT on an
      // 'error' (that would re-fire the same failing call on every open, the infinite loop) and NOT while
      // 'computing'. On 'error', the FE's retry button hits POST /viability-card/compute (synchronous, owns its
      // own window) instead.
      const aiState = await getAiViabilityState(db, caseId, { compute: false });
      const aiViability = aiState.status === 'ready' ? aiState.card : null;
      if (aiState.status === 'none' && aiRoutePickerEnabled()) {
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
      // aiViabilityState: the discriminated reliability state ('ready'|'computing'|'error'|'none'|'off') the
      // FE uses to show a spinner / honest-error / grounded plan instead of a fake resting verdict. The legacy
      // `aiViability` field is kept for back-compat (the static fallback consumers still read it).
      res.json({
        data: await deriveCaseViabilityForCase(db, caseId),
        aiViability,
        aiViabilityState: aiStateForClient(aiState),
        chartFullyRead,
      });
    }),
  );

  // Synchronous ON-DEMAND compute (Ryan 2026-06-21, Zimmelman) — the reliability keystone. The FE calls this
  // when the read state is 'none' (first view) or 'error' (the retry button): it runs the picker call INSIDE
  // this request (it owns its own ~29s window — nothing else on it) and returns the grounded plan after the
  // spinner, OR an honest error. This kills the "fire async + hope it warms on a later open / click around"
  // UX: the FIRST view grounds after a ~25s spinner rather than showing a misleading "Not supportable".
  router.post(
    '/cases/:id/viability-card/compute',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      if (!aiRoutePickerEnabled()) { res.json({ aiViabilityState: { status: 'off' } }); return; }
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // compute:true owns the request window — bound the picker call to ~26s, well inside the API cap. On any
      // failure getAiViabilityState persists a stable 'error' (visible + retryable), never an endless re-fire.
      const aiState = await getAiViabilityState(db, caseId, { compute: true, timeoutMs: 26_000 });
      res.json({ aiViabilityState: aiStateForClient(aiState) });
    }),
  );
  return router;
}

/** Project the server-side AiViabilityState into the FE-facing shape. The 'ready' card is sent so the FE can
 *  render it without a second round-trip; 'error' carries the RN-safe message; 'computing'/'none'/'off' are
 *  bare. (Imported type lives in ai-viability.ts; we inline the projection to avoid leaking server internals.) */
function aiStateForClient(state: Awaited<ReturnType<typeof getAiViabilityState>>):
  | { status: 'off' } | { status: 'none' } | { status: 'computing' }
  | { status: 'error'; error: string }
  | { status: 'ready'; card: import('../services/ai-viability.js').AiViabilityCard } {
  switch (state.status) {
    case 'ready': return { status: 'ready', card: state.card };
    case 'error': return { status: 'error', error: state.error };
    case 'computing': return { status: 'computing' };
    case 'off': return { status: 'off' };
    default: return { status: 'none' };
  }
}
