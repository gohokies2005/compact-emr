import { useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability, computeCaseViability, getSoapNote, type SoapContextInput, type SoapNoteResult } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { computeReadinessVerdict, type ReadinessVerdict } from '../lib/caseReadinessVerdict';
import { soapHeadline } from '../lib/soapHeadline';

// AI-synthesized SOAP-note Overview (Ryan 2026-06-20). The calm lead on the case: a physician-voice
// Subjective / Objective / Assessment / Plan note the MODEL writes from the assembled facts — smooth and
// human, not a deterministic dump.
//
// RELIABILITY: the traffic light + verdict + the fallback line are DETERMINISTIC (computeReadinessVerdict,
// fast cached data) so the card ALWAYS shows instantly. The AI prose (one bounded Sonnet call, fail-open) is
// POSTed the context the Overview already has and folds in when it lands (~10-15s, cached after). If the AI
// call fails/slow, the card stays useful with the deterministic verdict line. No fragile gate.

type Light = 'green' | 'amber' | 'red';
const LIGHT: Record<Light, { rule: string; dot: string; tint: string }> = {
  green: { rule: 'border-l-[#5E8B7E]', dot: 'bg-[#5E8B7E]', tint: 'bg-[#F1F5F2]' },
  amber: { rule: 'border-l-[#C19A5B]', dot: 'bg-[#C19A5B]', tint: 'bg-[#F7F2E8]' },
  red: { rule: 'border-l-[#B0654F]', dot: 'bg-[#B0654F]', tint: 'bg-[#F6EDE9]' },
};
const VERDICT_LIGHT: Record<ReadinessVerdict, Light> = {
  draft: 'green',
  draft_confirm_mechanism: 'amber', draft_reconcile: 'amber', draft_with_changes: 'amber',
  read_chart_first: 'amber', contact_records: 'amber', contact_alternative: 'amber', needs_review: 'amber',
  analysis_failed: 'red', // chart known-empty — a hard stop, not ambient amber
  not_supportable: 'red',
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
  const coverageQ = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled });
  const sanityQ = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', 'pre_draft', 0],
    queryFn: () => getSanityImpression(caseId, { stage: 'pre_draft', claimedCondition } as SanityContextInput),
    enabled: false,
  });

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
    sanity: sanityQ.data?.data?.impression ?? null,
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
  });
  // "Regenerate with new info" — the ONLY path that re-bills the model on demand. Forces a fresh Sonnet
  // call (forceRegenerate) and writes the new note back into the query cache. On open we always serve the
  // STORED note; the user spends only by clicking this (or when new info changed the fingerprint and they
  // choose to refresh). Disabled while the strategy/ctx isn't ready yet.
  const regenerate = useMutation({
    mutationFn: () => getSoapNote(caseId, ctx, { forceRegenerate: true }),
    onSuccess: (res: SoapNoteResult) => { qc.setQueryData(soapKey, res); },
  });

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

  const light = VERDICT_LIGHT[result.verdict];
  const L = LIGHT[light];
  const note = soapQ.data?.data ?? null;
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
  const headline = soapHeadline({
    grounded: soapQ.data?.grounded,
    stale: soapQ.data?.stale,
    routePickerFraming: soapQ.data?.routePickerFraming?.framing ?? null,
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
    <div className={`mb-4 rounded-lg border border-l-4 ${L.rule} border-slate-200 ${L.tint} px-5 py-4`}>
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
      ) : null}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <span className={`inline-block h-2 w-2 rounded-full ${L.dot}`} />
          {/* For analysis_failed the title already says "failed — re-run", so don't pile "(provisional)" on it. */}
          {analysisIncomplete && result.verdict !== 'analysis_failed' ? `${result.title} (provisional)` : result.title}
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
              A full written summary couldn’t be generated automatically on this open, so this is a brief explanation derived from the case verdict. It refreshes on the next open (the full summary is computed in the background).
            </div>
          ) : null}
          {note.subjective ? <Section label="Subjective">{note.subjective}</Section> : null}
          {note.objective ? <Section label="Objective">{note.objective}</Section> : null}
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
          {isStale ? (
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
