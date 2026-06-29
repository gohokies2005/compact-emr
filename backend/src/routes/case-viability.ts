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
import { getOrBuildSoapNote, soapNoteFingerprint, SOAP_NOTE_SCHEMA_VERSION, decideServeStored, type SoapContext, type SoapOverviewCacheDb } from '../services/soap-overview.js';
import { assembleSoapContextForCase } from '../services/soap-context-assembler.js';
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
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, status: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // RECOMPUTE-STORM FREEZE (Dr. Kasky 2026-06-28, chip-wobble keystone). While a case is status='drafting'
      // the drafter rewrites the Case row every few seconds, so the route-picker inputHash (ai-viability.ts:220,
      // computed over the drafter-mutated claimed/sc/problems/events/guidance/veteranStatement) drifts off the
      // persisted plan hash → getAiViabilityState reads 'none' → the SOAP rebuilds UNGROUNDED → a re-fired
      // recompute re-rolls the plan + SOAP and the chip flickers. We SKIP the auto-fired off-request recompute
      // while drafting (lower-risk than narrowing the hash inputs, which would also stop a REAL clinical change
      // from invalidating the plan). The serve-stored-first branch below still serves the persisted grounded
      // note for $0, and once drafting completes (status→rn_review) the next open recomputes normally. The
      // EXPLICIT compute endpoint (RN clicks Retry) is NOT gated — only these passive auto-fires.
      const draftingNow = (c as { status?: string }).status === 'drafting';
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
          if ((aiState.status === 'none' || aiState.status === 'ready') && !draftingNow) {
            void fireRecomputeViability(caseId);
          }
          firedRecompute = true;
        }
      } catch { routePickerFraming = null; /* fail-open: SOAP falls back to strategy strings */ }
      // CONTEXT ASSEMBLY (Ryan 2026-06-22, Zimmelman reliability). When a route-picker plan GROUNDS the note,
      // build the SoapContext from the SAME server-side assembler the OFF-REQUEST precompute uses
      // (assembleSoapContextForCase) — so the fingerprint the sync read computes EQUALS the one the async job
      // persisted under, and the precomputed (110s-budget, reliable-on-2776-pages) note is FOUND for $0. The
      // FE-POSTed body fields are no longer the cacheable grounding inputs in the grounded path (the server's
      // authoritative chart read is — the correct one-brain move). UNGROUNDED (route-picker off / no warm
      // plan) keeps today's FE-body behavior so nothing regresses there. Fail-open: assembler throws → FE body.
      // WRITE==READ (Ryan 2026-06-22, Zimmelman FIX A): BOTH the grounded and the ungrounded sync read build
      // ctx via the SAME server-side assembler the OFF-REQUEST precompute uses (assembleSoapContextForCase),
      // so the fingerprint the sync read computes EQUALS the one the async precompute persisted under — the
      // precomputed (110s-budget, reliable-on-2776-pages) note is then FOUND for $0 and served, instead of the
      // sync read building a DIFFERENT-fingerprinted ctx from the FE body (which always missed → permanent
      // fallback, the bug). The FE body NO LONGER feeds the cacheable grounding inputs (the server's
      // authoritative chart read does — the correct one-brain move; the FE cannot inject a contradicting
      // theory or document text). routePickerFraming may be null (ungrounded) — the assembler handles both.
      // Fail-open: if the assembler throws, fall back to a MINIMAL SERVER-DERIVED ctx (claimed condition +
      // server-built chart digest) — NOT the FE body — so the fail-open path still does not let the FE feed
      // the fingerprint (a body-fed ctx would re-introduce the write!=read divergence on the degraded path).
      let ctx: SoapContext;
      try {
        ctx = await assembleSoapContextForCase(db, caseId, routePickerFraming);
      } catch {
        let chartDigest: string | null = null;
        try { chartDigest = await buildDigestForCase(db, caseId); } catch { chartDigest = null; }
        ctx = { claimedCondition, routePickerFraming, chartDigest };
      }
      // SERVE-STORED-FIRST (Dr. Kasky 2026-06-26, Bays "load the REAL thing, not the intermediate; auto-refresh").
      // A plain open MUST serve the persisted current-shape SOAP note regardless of route-picker inputHash drift.
      // ROOT (hash-drift gate wedge): while a case is status='drafting' the drafter rewrites the Case row every
      // few seconds, so the LIVE route-picker inputHash drifts off the persisted plan hash → getAiViabilityState
      // returns 'none' → routePickerFraming is null → the SoapContext is assembled UNGROUNDED → its fingerprint
      // can never equal the fingerprint the async precompute persisted the GROUNDED note under. getOrBuildSoapNote
      // then served that real note only as stale=true (the "new info — regenerate" nag) or, when no current-shape
      // note existed yet, regenerated a truncated fallback on this 25s-capped sync path ("couldn't be generated").
      // The stored row is BY CONSTRUCTION a real (fallback:false) note from a successful precompute, so SERVE IT
      // now ($0, NOT stale). If the fingerprint drifted, fire ONE background auto-refresh — but still serve the
      // real note THIS open. The route-picker VERDICT (GET /viability-card, Gate-1) keeps its strict hash gate;
      // this decoupling is scoped to the SOAP-note surface. Fail-open: any read error falls through to today's path.
      if (body.forceRegenerate !== true) {
        try {
          const fingerprint = soapNoteFingerprint(ctx);
          const storedRow = await (db as unknown as SoapOverviewCacheDb).soapOverview.findUnique({ where: { caseId } });
          const decision = decideServeStored(storedRow, fingerprint);
          if (decision) {
            if (decision.refresh && !firedRecompute && !draftingNow) void fireRecomputeViability(caseId);
            res.json({ data: decision.note, fingerprint, stale: false, cached: true, grounded: routePickerFraming !== null, routePickerFraming });
            return;
          }
        } catch { /* fail-open: fall through to the assemble/generate path below */ }
      }
      // SHAPE-STALE SELF-HEAL (Ryan 2026-06-23, Zimmelman "re-renders every open"). A SOAP schema bump
      // (SOAP_NOTE_SCHEMA_VERSION 25→26) strands every pre-deploy stored note: getOrBuildSoapNote treats an
      // old-shape row as ABSENT, so a plain open falls through to a fresh sync generate. On a LARGE chart
      // (Zimmelman = 2776 pages) that sync call (25s cap) truncates → a TRANSIENT fallback → which is
      // deliberately NOT persisted → so the NEXT open recomputes again. The note therefore re-renders +
      // re-bills Sonnet on EVERY open and never heals, because the only path that completes on a huge chart
      // is the 110s async precompute, and that only fires when the PLAN is cold — Zimmelman's plan is warm.
      // Fix: when a route-picker plan grounds the note (warm plan) but there is NO current-shape, fingerprint-
      // matching stored row, fire the off-request async precompute (110s budget → writes the new-shape note)
      // and serve THIS open noStore — so we don't persist a doomed sync-path fallback and don't clobber any
      // existing row. The next open is a true $0 cache hit. This is the SAME firedRecompute/noStore mechanism
      // already used for the cold-plan case, now also keyed on a stale/missing SOAP shape. Cheap: one indexed
      // findUnique on soap_overviews. Fail-open: a read error leaves today's behavior untouched.
      let soapShapeStale = false;
      if (routePickerFraming && body.forceRegenerate !== true && !firedRecompute) {
        try {
          const fingerprint = soapNoteFingerprint(ctx);
          const storedRow = await (db as unknown as SoapOverviewCacheDb).soapOverview.findUnique({ where: { caseId } });
          const currentShapeMatch = storedRow !== null
            && storedRow.schemaVersion === SOAP_NOTE_SCHEMA_VERSION
            && storedRow.inputHash === fingerprint;
          if (!currentShapeMatch && !draftingNow) {
            soapShapeStale = true;
            void fireRecomputeViability(caseId); // 110s path re-writes the current-shape note off-request
          }
        } catch { soapShapeStale = false; /* fail-open: leave today's behavior */ }
      }
      // H2: when we just fired a recompute because no usable warm plan exists AND the caller did not explicitly
      // force a regenerate, serve a fresh strategy fallback note for THIS open but do NOT persist it — a
      // persisted strategy note would be served for $0 on later opens and hide the route-picker plan that is
      // now warming. (forceRegenerate still persists: the RN explicitly asked to spend + store.) A grounded
      // note (plan present) always persists as before — $0-on-reopen holds. soapShapeStale extends this: a
      // warm-plan case whose STORED SOAP note is the wrong shape also serves noStore for this open while the
      // async precompute warms the new-shape note (so the doomed sync fallback is not persisted).
      const result = await getOrBuildSoapNote(
        db as unknown as SoapOverviewCacheDb,
        caseId,
        ctx,
        { forceRegenerate: body.forceRegenerate === true, noStore: (firedRecompute || soapShapeStale) && body.forceRegenerate !== true },
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
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, status: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // RECOMPUTE-STORM FREEZE (Dr. Kasky 2026-06-28): see the POST handler. While status='drafting' the
      // drafter-mutated Case row drifts the route-picker inputHash → a cold 'none' here would re-fire the
      // off-request recompute on every poll/open and re-roll the plan → chip flicker. Skip the auto-fire while
      // drafting; the next open after drafting completes recomputes normally. (The explicit /compute endpoint
      // is unaffected.)
      const draftingNow = (c as { status?: string }).status === 'drafting';
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
      if (aiState.status === 'none' && aiRoutePickerEnabled() && !draftingNow) {
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

  // ON-DEMAND compute trigger (Ryan 2026-06-22, Zimmelman long-budget fix) — the reliability keystone. The FE
  // calls this when the read state is 'none' (first view, auto-fired) or 'error' (the retry button). It does
  // NOT run the picker INLINE: a synchronous inline compute is bounded by the ~30s API-Gateway cap (26s
  // timeoutMs), which is exactly what timed out forever on large charts. Instead it FIRES the off-request
  // async recompute (fireRecomputeViability → InvocationType:'Event'), which runs on the API Lambda's 120s
  // timeout with a 110s picker budget, and returns 'computing' immediately. The FE (which polls the GET every
  // 4s while 'computing') then picks up 'ready' or a genuine 'error'. getAiViabilityState's compute:true path
  // stamps 'computing' BEFORE the LLM call, so the very next GET returns 'computing' (the FE polls, it does
  // not re-fire). Both auto-fire and Retry now drive this single long async path.
  router.post(
    '/cases/:id/viability-card/compute',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      if (!aiRoutePickerEnabled()) { res.json({ aiViabilityState: { status: 'off' } }); return; }
      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // Fire the long async recompute off the request path; return 'computing' so the FE shows the spinner and
      // polls. The async handler stamps 'computing' at start, so a poll race never re-fires a second compute
      // (the in-flight guard in getAiViabilityState short-circuits a fresh 'computing'). NO-DEAD-END: honor the
      // dispatch result — if the self-invoke could NOT be dispatched (IAM/throttle/missing fn name), surface an
      // honest 'error' with Retry instead of returning 'computing' for a compute that will never run (which the
      // FE would show as an eternal spinner). The async path stamps its own 'error' on a genuine compute failure.
      const dispatched = await fireRecomputeViability(caseId);
      res.json({ aiViabilityState: dispatched
        ? { status: 'computing' }
        : { status: 'error', error: 'Could not start the analysis. Please retry.' } });
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
