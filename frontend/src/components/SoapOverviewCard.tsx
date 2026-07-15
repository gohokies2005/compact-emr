import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability, computeCaseViability, getSoapNote, type SoapContextInput, type SoapNoteResult } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { computeReadinessVerdict } from '../lib/caseReadinessVerdict';
import { soapHeadline } from '../lib/soapHeadline';
import { soapChipFromNote, SOAP_CHIP_TOOLTIP, type ChipColor } from '../lib/soapChip';

// AI-synthesized SOAP-note Overview (Ryan 2026-06-20). The calm lead on the case: a physician-voice
// Subjective / Objective / Assessment / Plan note the MODEL writes from the assembled facts — smooth and
// human, not a deterministic dump.
//
// RELIABILITY: the traffic light + verdict + the fallback line are DETERMINISTIC (computeReadinessVerdict,
// fast cached data) so the card ALWAYS shows instantly. The AI prose (one bounded Sonnet call, fail-open) is
// POSTed the context the Overview already has and folds in when it lands (~10-15s, cached after). If the AI
// call fails/slow, the card stays useful with the deterministic verdict line. No fragile gate.

// The chip/card accent palette, keyed by the SOAP-derived chip color (soapChip.ts). `neutral` is the
// white/neutral default shown BEFORE a SOAP verdict is persisted (no flicker — see soapChipFromNote).
// NOTE (Ryan 2026-07-14): the WHOLE-CARD tint/rule is applied ONLY for red (reject) — green/amber/info
// states keep a white card with just the colored dot + chip (see the render below). `tint`/`rule` here
// remain the full palette for the red case + the dot.
const LIGHT: Record<ChipColor, { rule: string; dot: string; tint: string }> = {
  green: { rule: 'border-l-[#5E8B7E]', dot: 'bg-[#5E8B7E]', tint: 'bg-[#F1F5F2]' },
  amber: { rule: 'border-l-[#C19A5B]', dot: 'bg-[#C19A5B]', tint: 'bg-[#F7F2E8]' },
  red: { rule: 'border-l-[#B0654F]', dot: 'bg-[#B0654F]', tint: 'bg-[#F6EDE9]' },
  neutral: { rule: 'border-l-slate-300', dot: 'bg-slate-300', tint: 'bg-white' },
};
const CONFIDENCE_LABEL: Record<string, string> = { high: 'High confidence', moderate: 'Moderate confidence', medium: 'Medium confidence', low: 'Low confidence' };

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-900">{label}</div>
      <div className="mt-0.5 text-[15px] leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}

export function SoapOverviewCard({ caseId, claimedCondition, veteranStatement, hasUnreadPages }: {
  readonly caseId: string;
  readonly claimedCondition: string;
  readonly veteranStatement?: string | null;
  readonly hasUnreadPages?: boolean;
}) {
  const enabled = caseId.length > 0;
  const strategyQ = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled });
  // The viability card carries the route-picker reliability STATE. While the plan is 'computing' we POLL so
  // the grounded result folds in WITHOUT the RN clicking around (Ryan 2026-06-21: no "warm up / click around").
  // 'none'/'error' are resolved by the on-demand compute mutation below (not by polling the GET — that would
  // just re-read the same state). Polling stops as soon as the state is ready/error/off.
  const viabilityQ = useQuery({
    queryKey: ['case', caseId, 'viability-card'],
    queryFn: () => getCaseViability(caseId),
    enabled,
    refetchInterval: (q) => (q.state.data?.aiViabilityState?.status === 'computing' ? 4000 : false),
  });
  // SELF-HEAL the amber→green flip WITHOUT a hard refresh (Ryan 2026-06-24). The verdict goes amber/provisional
  // while the chart analysis isn't confirmed complete. Two ways it used to get stuck on amber until a manual hard
  // refresh: (1) a STALE cached "incomplete" from a prior visit (e.g. before a re-extraction finished) — fixed by
  // refetchOnMount:'always' so opening the card always re-reads fresh coverage; (2) the extraction finishing while
  // the RN/physician is sitting on the page — fixed by polling every 5s WHILE the analysis is in flight, which
  // folds in the completed state on its own and then stops. Coverage GET is a cheap read (no model spend).
  const coverageQ = useQuery({
    queryKey: ['case', caseId, 'extraction-coverage'],
    queryFn: () => getExtractionCoverage(caseId),
    enabled,
    refetchOnMount: 'always',
    refetchInterval: (q) => {
      const cov = q.state.data?.data;
      const inFlight = cov?.status === 'in_progress' || cov?.chartAnalysis?.state === 'in_progress';
      // Cap the poll so a WEDGED extraction (stuck 'in_progress' until the 45-min watcher fails it) can't poll
      // for the lifetime of an open tab. ~60 polls × 5s ≈ 5 min covers a normal large extraction; after that the
      // user can refresh. Coverage GET is a $0 read, so this is just hygiene, not a cost guard.
      const polls = q.state.dataUpdateCount ?? 0;
      return inFlight && polls < 60 ? 5000 : false;
    },
  });
  // PRE-DRAFT sanity-impression RETIRED (Ryan #68/#72, 2026-06-25): the divergent second LLM brain is gone.
  // This card defers to the route-picker plan (the one brain); sanity is passed null to computeReadinessVerdict.

  const strategy = strategyQ.data?.data ?? null;
  const v = viabilityQ.data?.data ?? null;
  // ONE-BRAIN (Ryan 2026-06-22): the chip is a PROJECTION of the AI route-picker band when a ready plan
  // exists, so the chip color/label can never contradict the SOAP Assessment/Plan (which render the SAME
  // plan). null when the plan is not ready (flag off / cold / error) → the deterministic engine drives the
  // chip (fallback). aiState here is the discriminated reliability state from the viability-card response.
  const aiStateForChip = viabilityQ.data?.aiViabilityState;
  // CHART-ANALYSIS SAFETY (Ryan 2026-06-23): feed the Stage-2 analysis state into the VERDICT, not just a label.
  // Unknown (coverage query loading/errored) must FAIL SAFE — the verdict goes provisional, never confident.
  const covData = coverageQ.data?.data ?? null;
  const chartAnalysisState = covData?.chartAnalysis?.state ?? null;
  // FAIL SAFE only on a genuinely-unresolved query (LOADING / ERRORED) — a RESOLVED-but-null coverage ("no report
  // available") is NOT unknown and must keep the prior behavior (no analysis-driven downgrade). Over-firing on
  // resolved-null would turn every report-less case into a provisional read_chart_first.
  const chartAnalysisUnknown = coverageQ.isLoading || coverageQ.isError;
  const result = computeReadinessVerdict({
    strategy, viability: v,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: covData,
    sanity: null, // pre-draft sanity brain retired (one-brain) — defer to the route-picker plan
    routePickerViability: aiStateForChip?.status === 'ready' ? aiStateForChip.card.viability : null,
    chartAnalysisState,
    chartAnalysisUnknown,
  });

  // Assemble the SOAP context once the fast inputs are in, then POST it for the AI synthesis. Keyed on the
  // case (one call per case; cached server- and client-side). Enabled only when there's something to write.
  const cov = coverageQ.data?.data;
  // CHART-ANALYSIS HONESTY (Ryan 2026-06-23): the verdict is built on the structured chart that Stage 2
  // (chart analysis) produces. If that stage did NOT finish (failed / interrupted / still running / left
  // gaps), the verdict may be built on an EMPTY or PARTIAL chart — so we render a prominent banner and mark
  // the verdict PROVISIONAL rather than presenting a confident conclusion. Driven from the SAME coverage SSOT
  // the chart-extraction card reads (cov.chartAnalysis), so the banner and the card line can never disagree.
  const analysis = cov?.chartAnalysis ?? null;
  // The banner fires ONLY when the analysis the verdict is built on is genuinely degraded — failed / interrupted /
  // still running. 'complete' and 'not_analyzed' (new/empty case) NEVER trip it (the cry-wolf fix): a brand-new
  // case must not scream "incomplete chart". point-3b: a whole MISSING FILE (an unread / needs-manual-summary gap)
  // also degrades the chart the verdict is built on, so it raises the same provisional state even if Stage-2 itself
  // reported complete.
  const wholeFileGap = (cov?.gaps ?? []).some((g) => g.reason === 'unread' || g.reason === 'needs_manual_summary');
  const analysisDegraded = analysis !== null && (analysis.state === 'failed' || analysis.state === 'incomplete' || analysis.state === 'in_progress');
  const analysisIncomplete = analysisDegraded || wholeFileGap;
  // NEAR-COMPLETE TOLERANCE (Ryan 2026-06-24, Fitton): a completed run that analyzed ≥90% but left a few pages
  // out is 'complete' WITH minorGap — the verdict proceeds and the red provisional banner is suppressed, but we
  // surface a SOFT amber caution (the reason) so the near-completeness is still visible. Never shown alongside
  // the red banner (a whole-file gap takes precedence and reads as the louder provisional state).
  const minorGapCaution = !analysisIncomplete && analysis?.state === 'complete' && analysis?.minorGap === true
    ? (analysis?.reason ?? null) : null;
  const analysisBanner = !analysisIncomplete ? null : (() => {
    const causeFile = analysis?.likelyCauseFile ?? null;
    const reason = analysis?.state === 'failed'
      ? 'the chart analysis failed'
      : analysis?.state === 'in_progress'
        ? 'the chart analysis is still running'
        : analysisDegraded
          ? (analysis?.reason || 'the chart analysis did not finish')
          : 'a file in the record could not be read';
    const causeClause = causeFile ? ` A large records file (${causeFile}) likely couldn’t be fully processed.` : '';
    return `Chart analysis incomplete — ${reason}.${causeClause} This assessment may be based on an incomplete chart; review the records directly and re-run extraction before relying on it.`;
  })();
  const coveragePct = typeof cov?.coveragePct === 'number' ? cov.coveragePct : null;
  const coverageNote = coveragePct === null ? null
    : (!hasUnreadPages && coveragePct >= 99 ? 'All records were reviewed.' : `${coveragePct}% of pages read${hasUnreadPages ? '; some pages still unread' : ''}.`);
  const ctx: SoapContextInput = {
    claimedCondition,
    veteranStatement: veteranStatement ?? null,
    theory: strategy?.primaryArgument ?? null,
    mechanism: strategy?.proposedMechanism ?? null,
    scConditions: strategy?.inputSet?.scConditions ?? [],
    activeProblems: strategy?.inputSet?.activeProblems ?? [],
    keyFacts: strategy?.inputSet?.keyFacts ?? [],
    medications: strategy?.inputSet?.medications ?? [],
    coverageNote,
    engineVerdict: result ? `${result.title} (${result.confidence} confidence)` : null,
    engineNextAction: result?.nextAction ?? null,
  };
  const qc = useQueryClient();
  const soapKey = ['case', caseId, 'soap-note'] as const;
  const soapQ = useQuery({
    queryKey: soapKey,
    queryFn: () => getSoapNote(caseId, ctx),
    enabled: enabled && strategy !== null, // ctx is meaningful once the strategy/inputSet is loaded
    staleTime: 10 * 60 * 1000,
    // AUTO-REFRESH ON RE-OPEN (Dr. Kasky 2026-06-29, "navigating away and coming back did nothing"). The 10-min
    // staleTime made react-query serve the CACHED provisional brief on remount, so returning to the chart never
    // picked up the real note the async precompute had since landed. refetchOnMount:'always' re-fetches on every
    // mount regardless of staleTime — and that re-fetch is a $0 serve-stored-first cache hit once the real note
    // is persisted (the common case), so it's cheap. The live auto-poll (soapPollQ below) handles the SAME-tab
    // "sitting on the page while it finishes" case without a hard refresh.
    refetchOnMount: 'always',
    // NOTE: this MAIN query is still NOT polled on note.fallback — a non-forced getSoapNote re-RUNS the model in
    // the warming window (the documented re-bill trap, QA cost finding 2026-06-24). The auto-refresh poll lives
    // in soapPollQ below and uses the pollOnly ($0 status-check) path so it never bills Sonnet while generating.
  });
  // "Regenerate with new info" — the ONLY path that re-bills the model on demand. Forces a fresh Sonnet
  // call (forceRegenerate) and writes the new note back into the query cache. On open we always serve the
  // STORED note; the user spends only by clicking this (or when new info changed the fingerprint and they
  // choose to refresh). Disabled while the strategy/ctx isn't ready yet.
  const regenerate = useMutation({
    mutationFn: () => getSoapNote(caseId, ctx, { forceRegenerate: true }),
    onSuccess: (res: SoapNoteResult) => { qc.setQueryData(soapKey, res); },
  });

  // ── AUTO-REFRESH while the SOAP is still generating (Dr. Kasky 2026-06-29) ────────────────────────────────
  // The served note is PROVISIONAL when it is a `fallback` brief: the 25s sync open truncated and the 110s
  // async precompute is still writing the real (fallback:false) grounded note. Dr. Kasky had to HARD REFRESH to
  // see it land. We now poll a CHEAP pollOnly status-check (~15s) that costs $0 — it serves the real note the
  // instant the precompute persists it and returns generating:true otherwise (never re-billing Sonnet in the
  // warming window). When the real note lands we fold it into the MAIN soap query (setQueryData) → the card
  // re-renders with the full note AND provisional flips false → the poll disables itself. Capped at ~5 min so a
  // wedged/failed precompute can't poll for the life of an open tab; after the cap we show a manual "check
  // again" affordance (which fires one more cheap pollOnly).
  const servedNote = soapQ.data?.data ?? null;
  // PROVISIONAL FOR ANY REASON (Dr. Kasky 2026-06-29, Marcus Bennett — 2nd attempt). The served note is NOT
  // the final, complete, grounded note — and must keep polling — when ANY of:
  //   (1) it is a `fallback` truncation brief (the 25s sync open truncated; the 110s async precompute is still
  //       writing the real note) — the original gate, still covered;
  //   (2) the chart it was built on is STILL being analyzed (chartAnalysis.state / coverage status
  //       'in_progress') — the missed case: the note is a REAL (fallback:false) note whose prose hedges "…not
  //       fully extracted in the available pages", written while extraction was mid-flight. The OLD gate only
  //       checked (1), so this state never polled → the note persisted until a HARD REFRESH re-read the note
  //       the completed extraction had since produced. We exclude the TERMINAL degraded states (failed /
  //       'incomplete' / whole-file gap): those will not improve by polling (they need a manual re-extraction),
  //       so polling them would just spin to the cap. Only the self-resolving in_progress state polls here.
  //   (3) the served note is `stale` — its inputs drifted since it was written (e.g. the chart finished AFTER
  //       the note, even once the in_progress banner already healed) — so a refreshed note is owed.
  const chartAnalysisInFlight = covData?.chartAnalysis?.state === 'in_progress' || covData?.status === 'in_progress';
  const soapProvisional = soapQ.data !== undefined && (
    (servedNote !== null && servedNote.fallback === true)
    || chartAnalysisInFlight
    || soapQ.data.stale === true
  );
  const SOAP_POLL_MS = 15_000;
  const SOAP_MAX_POLLS = 20; // ~5 min at 15s — hygiene cap, not a cost guard (pollOnly is $0)
  // Count completed polls so we can STOP after the cap (a wedged/failed precompute must not poll for the life of
  // an open tab) and show the manual "check again" affordance. Reset per case (a fresh card re-arms).
  const [soapPollCount, setSoapPollCount] = useState(0);
  useEffect(() => { setSoapPollCount(0); }, [caseId]);
  // RE-ARM ON STALE (Ryan 2026-07-14, "edits must propagate with NO hard refresh"). When the served note flips
  // stale:true (an RN edit drifted the fingerprint; the backend fired the background recompute and now reports
  // the drift honestly), a previously-capped poll must re-arm — otherwise a case whose earlier generation used
  // up the cap would never fold the refreshed note in without a hard refresh. Rising-edge only (a ref guard),
  // so a persistent stale flag doesn't reset the cap every render (the cap still bounds a wedged recompute).
  const soapStaleNow = soapQ.data?.stale === true;
  const soapWasStale = useRef(false);
  useEffect(() => {
    if (soapStaleNow && !soapWasStale.current) setSoapPollCount(0);
    soapWasStale.current = soapStaleNow;
  }, [soapStaleNow]);
  useEffect(() => { soapWasStale.current = false; }, [caseId]);
  const soapPollCapped = soapPollCount >= SOAP_MAX_POLLS;
  const soapPollKey = ['case', caseId, 'soap-note', 'poll'] as const;
  const soapPollQ = useQuery({
    queryKey: soapPollKey,
    queryFn: () => getSoapNote(caseId, ctx, { pollOnly: true }),
    // Only poll while a provisional brief is showing and the strategy/ctx is ready; never while regenerating.
    enabled: enabled && strategy !== null && soapProvisional && !regenerate.isPending,
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 0,
    refetchInterval: () => (soapProvisional && soapPollCount < SOAP_MAX_POLLS ? SOAP_POLL_MS : false),
  });
  // On each poll result: a landed real note folds into the MAIN query (card shows it; provisional flips false →
  // poll disables itself). A still-generating result counts toward the cap. Keyed on dataUpdatedAt so it fires
  // once per completed fetch (even when the generating payload is reference-equal).
  useEffect(() => {
    const res = soapPollQ.data;
    if (!res) return;
    // The backend pollOnly lands a note ONLY when it is final + fingerprint-CURRENT (a drifted/still-generating
    // status returns generating:true with data:null). So a non-null, non-fallback `data` here is the complete
    // grounded note for the now-current chart → fold it into the MAIN query (the card shows it; soapProvisional
    // flips false → the poll disables itself). Anything else (generating, or a defensive fallback) counts toward
    // the cap.
    if (res.generating !== true && res.data && res.data.fallback !== true) { qc.setQueryData(soapKey, res); return; }
    setSoapPollCount((n) => n + 1);
    // soapKey is a stable per-case tuple; qc is stable. Re-run only when a new poll result lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soapPollQ.dataUpdatedAt]);

  // KICK THE SINGLE DRIFT-RECOMPUTE WHEN THE CHART FINISHES (Dr. Kasky 2026-06-29, Marcus Bennett). The pollOnly
  // status-check is $0 and deliberately fires NO recompute — so on its own it would wait forever for a refreshed
  // note that nothing produces. When the chart analysis transitions in_progress -> settled (extraction finished
  // while the RN sat on the page), we invalidate the MAIN soap query ONCE. That normal (non-poll) re-open hits
  // serve-stored-first, sees the fingerprint drift (the stored note was built on the pre-completion chart) and
  // fires the ONE off-request recompute that writes the complete, current-fingerprint note — which the poll then
  // folds in. The ref guard makes this fire once per in_progress->settled edge, never per coverage tick (no
  // recompute storm). navigate-away-and-back is separately covered by soapQ's refetchOnMount:'always'.
  const chartWasInFlight = useRef(false);
  useEffect(() => {
    const inFlight = chartAnalysisInFlight;
    if (chartWasInFlight.current && !inFlight) void qc.invalidateQueries({ queryKey: soapKey });
    chartWasInFlight.current = inFlight;
    // soapKey is a stable per-case tuple; qc is stable. Re-run only on the in-flight flag changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartAnalysisInFlight]);
  // Reset the edge-detector when the case changes (a fresh card must not inherit the prior case's flag).
  useEffect(() => { chartWasInFlight.current = false; }, [caseId]);

  // ── Route-picker plan RELIABILITY (Ryan 2026-06-21, Zimmelman) ───────────────────────────────────────
  // The plan compute is the SAME brain the drafter uses. Rather than showing a misleading resting "Not
  // supportable" verdict while the plan is missing/failed, we drive the plan to a grounded result and show an
  // HONEST surface: a spinner while computing, a retry on error. The synchronous compute owns its own ~25s
  // window so the FIRST view grounds after the spinner (no "warm up / click around").
  const aiState = viabilityQ.data?.aiViabilityState;
  const compute = useMutation({
    mutationFn: () => computeCaseViability(caseId),
    onSuccess: () => {
      // The plan state changed — refetch the card (folds in the grounded plan/error) and re-ground the SOAP.
      void qc.invalidateQueries({ queryKey: ['case', caseId, 'viability-card'] });
      void qc.invalidateQueries({ queryKey: soapKey });
    },
  });
  // Auto-trigger ONE synchronous compute on a COLD 'none' (first view) so the first render grounds after a
  // spinner instead of resting on the degraded verdict. We do NOT auto-retry on 'error' (the RN clicks Retry —
  // avoids hammering a failing provider) and do NOT fire while 'computing'/'ready'/'off'. Guarded by a ref so a
  // re-render / poll does not fire a second concurrent compute.
  const autoComputeFired = useRef(false);
  useEffect(() => {
    if (aiState?.status === 'none' && !autoComputeFired.current && !compute.isPending) {
      autoComputeFired.current = true;
      compute.mutate();
    }
    // Reset the one-shot guard when we leave 'none' (so a later genuine 'none' after an input change re-arms).
    if (aiState?.status && aiState.status !== 'none') autoComputeFired.current = false;
  }, [aiState?.status, compute]);

  if (strategyQ.isLoading && viabilityQ.isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case…
      </div>
    );
  }

  // ── CHART-ANALYSIS-IN-PROGRESS GATE (Dr. Kasky 2026-06-30, redesign — NOT another patch) ──────────────
  // "No color until it's drafted and complete. DON'T EVEN SHOW the tentative stuff — just say 'still
  // analyzing, this may take a few minutes. It runs in the background if you click away.'" While the chart is
  // GENUINELY still being analyzed we render ONE neutral placeholder: no colored chip, no SOAP body, no
  // verdict, no "Provisional —" heading, no banner. The tentative read is NEVER surfaced — it was the source
  // of all three live bugs: the chip/heading flipped amber→green as the provisional read settled into the
  // final (bug 1); the Objective appeared to "lose data" (Foster: rich sleep data → BMI) when the completed
  // read replaced the provisional one (bug 2); and the chip read green "Ready to draft" over a plan that
  // hedged "Do not draft yet" because chip and plan were computed from different, mid-analysis inputs
  // (Walthour, bug 3). Suppressing the read until the chart is COMPLETE removes the flip at its source: the
  // final SOAP + verdict + color are computed ONCE on the completed chart (chip and plan both project the SAME
  // persisted note — soapChipFromNote(note) vs note.plan) and then STICK.
  //
  // Fires ONLY for genuine in-progress (pages still reading / analysis running) — `chartAnalysisInFlight` is
  // in_progress-exclusive by construction (extraction-coverage.ts). It deliberately does NOT fire for:
  //   • not_analyzed  — a manual / no-extraction case (cov.totalFiles === 0, veteran's prior record): no
  //                     extraction ever runs, so we show the FINAL read immediately, never a stuck "analyzing".
  //   • complete      — the read is final; show it.
  //   • failed        — its own honest failed banner + analysis_failed verdict render below.
  //   • incomplete    — its own honest provisional banner renders below (terminal, won't self-heal by waiting).
  // The coverage poll (coverageQ, 5s while in-flight) flips this off on its own when the analysis lands — no
  // manual refresh. The server-side precompute (precomputeSoapNoteForCase, fired off the request path via
  // fireRecomputeViability → InvocationType:'Event') keeps running regardless of whether the RN stays on the
  // page, so "it keeps running if you leave" is literally true.
  if (chartAnalysisInFlight) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <p className="mt-2 flex items-center gap-2 text-[15px] font-medium text-slate-700">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" aria-hidden />
          Still analyzing the chart — this can take a few minutes.
        </p>
        <p className="mt-1 text-[13px] text-slate-500">It keeps running in the background if you leave this page; check back shortly.</p>
      </div>
    );
  }

  // ── HONEST plan-state surface (Ryan 2026-06-21, Zimmelman) ───────────────────────────────────────────
  // When the route-picker plan is the intended brain (aiViabilityState present + not 'off') but it is NOT
  // ready, NEVER render the resting "Not supportable as filed" deterministic verdict — that misleads ("if it
  // says not draftable it won't get drafted"). Show the plan COMPUTING (a spinner; we auto-fired/are polling)
  // or, on a genuine compute FAILURE, an honest "analysis failed — retry" with a retry button. Only when the
  // plan is 'ready' or the flag is 'off' do we fall through to the normal SOAP/verdict render below.
  // Adversarial-QA window (2026-06-21): when strategy resolves before the viability GET, aiState is still
  // undefined while viabilityQ loads — treat that as computing so we never flash the resting deterministic
  // verdict during the network window. undefined ≠ 'off', so the off path (after the GET resolves) is unaffected.
  const planComputing = (viabilityQ.isLoading && aiState === undefined)
    || aiState?.status === 'computing' || aiState?.status === 'none' || compute.isPending;
  const planErrored = aiState?.status === 'error' && !compute.isPending;
  if (planComputing) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-l-[#C19A5B] border-slate-200 bg-[#F7F2E8] px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <p className="mt-2 flex items-center gap-2 text-[15px] font-medium text-slate-700">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#C19A5B] border-t-transparent" />
          Analyzing the case…
        </p>
        <p className="mt-1 text-[13px] text-slate-500">Reading the chart and selecting the strongest theory. This can take up to half a minute on a large chart.</p>
      </div>
    );
  }
  if (planErrored) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-l-[#B0654F] border-slate-200 bg-[#F6EDE9] px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <p className="mt-2 text-[15px] font-medium text-slate-800">The case analysis couldn’t be completed.</p>
        <p className="mt-1 text-[13px] text-slate-600">{aiState && aiState.status === 'error' ? aiState.error : 'Please retry.'}</p>
        <button
          type="button"
          onClick={() => compute.mutate()}
          disabled={compute.isPending}
          className="mt-3 rounded-md bg-[#B08D3C] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#9a7a32] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {compute.isPending ? 'Retrying…' : 'Retry analysis'}
        </button>
        <p className="mt-2 text-[11px] text-slate-400">This is a system issue, not a finding about the case — the case has not been assessed.</p>
      </div>
    );
  }

  if (result === null) return null;

  const note = soapQ.data?.data ?? null;
  // CHIP COLOR + LABEL = a PURE projection of the PERSISTED SOAP verdict (Ryan 2026-06-27, "the chip keeps
  // changing color on its own, amber→green→amber"). The OLD code derived the chip from result.verdict
  // (computeReadinessVerdict, recomputed EVERY render from the POLLING viability + coverage queries) so the
  // color flickered across loads and contradicted the stable SOAP body. Now the color/label come ONLY from
  // the SOAP note's persisted `action` (decided once at generation, stored in soap_overviews.result_json), so
  // the chip stays LOCKED to the SOAP text — one color until the SOAP is regenerated. Neutral/white when no
  // SOAP is persisted yet (still generating / transient fallback). `result` still drives the body headline,
  // the deterministic fallback line, and the chart-analysis provisional banner — but NOT the chip color.
  const chip = soapChipFromNote(note);
  const L = LIGHT[chip.color];
  // WHOLE-CARD COLOR ONLY FOR A TRUE STOP (Ryan 2026-07-14): the full-card tint + colored left rule are
  // reserved for red (reject) — a real "do not proceed" — and the blocker banners above keep their own loud
  // treatment. Green/amber/neutral states render a WHITE card: the colored dot + chip carry the status, the
  // card itself stays calm (amber-washing the whole card read as a warning on cases that are ready to draft).
  const cardRule = chip.color === 'red' ? L.rule : 'border-l-slate-300';
  const cardTint = chip.color === 'red' ? L.tint : 'bg-white';
  // The stored note's inputs changed since it was written (new info came in). We do NOT auto-spend — we
  // surface a subtle hint and let the RN click Regenerate. Suppressed while a regenerate is in flight.
  const isStale = soapQ.data?.stale === true && !regenerate.isPending;
  const regenerating = regenerate.isPending;
  const canRegenerate = enabled && strategy !== null;
  // H1 + H4 (2026-06-21): the bold headline. H1 — when GROUNDED on the route-picker plan (the SAME brain the
  // drafter pleads) the headline is that plan's framing so it matches the Assessment below. H4 (adversarial QA)
  // — when the served note is STALE the body is the stored (old-framing) note while routePickerFraming is the
  // LIVE plan, so the live framing would CONTRADICT the stale Assessment; soapHeadline SUPPRESSES the grounded
  // framing when stale and falls back to the neutral strategy/title headline (the "new info — regenerate" hint
  // tells the RN the body is out of date; regenerating re-grounds headline + body together). Pure + unit-tested.
  // One-brain (#72/#89, Dr. Kasky 2026-06-26 OSA "secondary to Knee" vs depression): when the SOAP read is
  // ungrounded (inputHash drift) but the route-picker PLAN is ready, use the plan's chosen framing — the SAME
  // theory the Assessment body argues — for the headline, ABOVE the static strategy engine (which reads the
  // stale intake claim). Suppressed when stale (soapHeadline guards). card.lead.framing names the anchor.
  const routePickerCardFraming = aiState?.status === 'ready' ? (aiState.card.lead.framing ?? null) : null;
  const headline = soapHeadline({
    grounded: soapQ.data?.grounded,
    stale: soapQ.data?.stale,
    routePickerFraming: soapQ.data?.routePickerFraming?.framing ?? null,
    routePickerCardFraming,
    strategyPrimaryArgument: strategy?.primaryArgument ?? null,
    anchorHeadline: v?.best_anchor?.upstream_verbatim
      ? `${v.claimed_canonical ?? claimedCondition} — secondary to ${v.best_anchor.upstream_verbatim}` : null,
    resultTitle: result.title,
  });
  // The degraded "(deterministic check only)" line now applies ONLY when the route-picker is genuinely OFF or
  // unavailable (static-engine mode) — the computing/error states are handled by the honest surfaces above, so
  // we never show this misleading line over a plan that is simply still computing or that failed. When the
  // plan is 'ready' the SOAP grounds on it; we suppress the line then too.
  const routePickerActive = aiState !== undefined && aiState.status !== 'off';
  const soapResolved = soapQ.data !== undefined && !soapQ.isFetching && !regenerating;
  const planUnavailable = !routePickerActive && soapResolved && soapQ.data?.grounded !== true;

  return (
    <div className={`mb-4 rounded-lg border border-l-4 ${cardRule} border-slate-200 ${cardTint} px-5 py-4`}>
      {/* PROMINENT chart-analysis-incomplete banner (Ryan 2026-06-23). When the chart that the verdict is
          built on was not fully analyzed, this sits ABOVE the verdict and the verdict reads as PROVISIONAL —
          never a confident conclusion built on an empty/partial chart. Plain language, names the likely-cause
          file when known. */}
      {analysisBanner ? (
        // LOUDER than routine amber notices (point-1, Ryan 2026-06-23): a red/orange 2px left rule + ring + a
        // filled warning chip so it reads as a STOP, not as ambient amber that gets skimmed past.
        <div className="mb-3 flex items-start gap-2.5 rounded-md border-2 border-l-[6px] border-[#B0654F] bg-[#FBEAE4] px-3 py-2.5 ring-1 ring-[#B0654F]/30">
          <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-[#B0654F] text-[12px] font-bold text-white" aria-hidden>!</span>
          <p className="text-[13px] font-semibold text-[#7B3F2E]">{analysisBanner}</p>
        </div>
      ) : minorGapCaution ? (
        // NEAR-COMPLETE TOLERANCE (Ryan 2026-06-24, Fitton): a SOFT amber caution — the chart analyzed ≥90% and the
        // verdict proceeds normally; this just flags the small shortfall. Quieter than the red provisional banner.
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
          <span className="mt-0.5 text-amber-600" aria-hidden>⚠</span>
          <p className="text-[12px] text-amber-800">{minorGapCaution}</p>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          {/* QUIET "Updating…" while the note is provisional/stale (Ryan 2026-07-14, no-hard-refresh fix):
              the poll is re-fetching the refreshed note in the background. The chip KEEPS its old color/label
              while updating (chip-stability rule — the persisted verdict stands until the new note folds in). */}
          {soapProvisional ? (
            <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-normal text-slate-400">
              <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-slate-300 border-t-transparent" aria-hidden />
              Updating…
            </span>
          ) : null}
          {/* Chip color + label are LOCKED to the persisted SOAP verdict (soapChipFromNote) so they cannot
              recompute/flicker across loads. The chart-analysis "provisional" caution stays loud in the banner
              + the headline below — it is a separate honesty layer, not a chip-color signal. */}
          <span title={SOAP_CHIP_TOOLTIP} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${L.dot}`} />
            {chip.label}
          </span>
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold leading-snug text-slate-900">
        {analysisIncomplete && result.verdict !== 'analysis_failed' ? 'Provisional — ' : ''}{headline}
      </p>
      {analysisIncomplete ? (
        <p className="mt-1 text-[11px] text-amber-700">This is a provisional read on an incomplete chart — re-run the chart analysis before relying on it.</p>
      ) : planUnavailable ? (
        <p className="mt-1 text-[11px] text-slate-400">(plan unavailable — deterministic check only)</p>
      ) : null}

      {note ? (
        <>
          {note.fallback ? (
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
              <p>
                This is a brief read derived from the case verdict. The full written summary is being prepared in the background and will
                {soapPollCapped ? ' appear once it’s ready.' : (
                  <span className="inline-flex items-center gap-1">
                    {' appear here automatically when it’s ready'}
                    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-slate-400 border-t-transparent align-middle" aria-hidden />
                    .
                  </span>
                )}
                {' '}The brief is accurate; it’s just shorter than the full note.
              </p>
              {soapPollCapped ? (
                <button
                  type="button"
                  onClick={() => void soapPollQ.refetch()}
                  disabled={soapPollQ.isFetching}
                  className="mt-1 text-[11px] font-medium text-[#B08D3C] hover:underline disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  {soapPollQ.isFetching ? 'Checking…' : 'Check for the full summary'}
                </button>
              ) : null}
            </div>
          ) : null}
          {note.subjective ? <Section label="Subjective">{note.subjective}</Section> : null}
          {note.objective || (note.measurements && note.measurements.length > 0) ? (
            <Section label="Objective">
              {note.objective ? <span>{note.objective}</span> : null}
              {/* OBJECTIVE HARD DATA (#63, Dr. Kasky): the real clinical NUMBERS for this condition (AHI/RDI/
                  CPAP usage/BP/A1c/PHQ-9/…), grounded in the chart, as a clean labeled list so the physician
                  sees the measurements — not just prose. Absent/empty → nothing renders here. */}
              {note.measurements && note.measurements.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {note.measurements.map((m, i) => (
                    <li key={`${m.label}-${m.value}-${i}`} className="flex gap-2 text-[14px] leading-snug text-slate-700">
                      <span className="text-slate-400">•</span>
                      <span><span className="font-medium text-slate-900">{m.label}:</span> {m.value}{m.unit ? ` ${m.unit}` : ''}{(m.qualifier || m.date) ? ` (${[m.qualifier, m.date].filter(Boolean).join(', ')})` : ''}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ) : null}
          {note.assessment ? <Section label="Assessment">{note.assessment}</Section> : null}
          {note.caveat ? (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800">
              <span className="font-medium">⚠ Verify:</span> {note.caveat}
            </div>
          ) : null}
          <div className="mt-3 border-t border-[#E5DEC9] pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-900">Plan</div>
            <div className="mt-0.5 text-[15px] font-medium text-slate-800"><span className="text-[#B08D3C]">→ </span>{note.plan}</div>
          </div>
          {/* The manual "regenerate" nag shows only once the AUTO-refresh gave up (poll capped) — while the
              poll is live the quiet "Updating…" indicator next to the chip covers it (Ryan 2026-07-14:
              auto-reload silently, no hard refresh, no click needed on the happy path). */}
          {isStale && soapPollCapped ? (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              New information has come in since this summary was written. Click <span className="font-medium">Regenerate with new info</span> to refresh it.
            </div>
          ) : null}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">{CONFIDENCE_LABEL[note.confidence] ?? note.confidence} · A physician confirms before any letter is signed.</span>
            <button
              type="button"
              onClick={() => regenerate.mutate()}
              disabled={!canRegenerate || regenerating}
              className="text-[11px] font-medium text-[#B08D3C] hover:underline disabled:cursor-not-allowed disabled:text-slate-300"
            >
              {regenerating ? 'Regenerating…' : 'Regenerate with new info'}
            </button>
          </div>
        </>
      ) : (
        // Deterministic fallback (AI summary loading or unavailable) — always useful.
        <>
          <p className="mt-1 text-[15px] leading-relaxed text-slate-700">{result.detail}</p>
          <div className="mt-3 border-t border-[#E5DEC9] pt-2 text-[15px] font-medium text-slate-800">
            <span className="text-[#B08D3C]">→ </span>{result.nextAction}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">
              {(soapQ.isFetching || regenerating) ? 'Writing the summary…' : `${CONFIDENCE_LABEL[result.confidence] ?? result.confidence} · A physician confirms before any letter is signed.`}
            </span>
            {canRegenerate && !soapQ.isFetching ? (
              <button
                type="button"
                onClick={() => regenerate.mutate()}
                disabled={regenerating}
                className="text-[11px] font-medium text-[#B08D3C] hover:underline disabled:cursor-not-allowed disabled:text-slate-300"
              >
                {regenerating ? 'Regenerating…' : 'Regenerate with new info'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
