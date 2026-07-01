import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { computeReadinessVerdict, type ReadinessVerdict, type Confidence } from '../lib/caseReadinessVerdict';
import { SectionCard } from './ui/SectionCard';

// Case Readiness Verdict (2026-06-18, Cluster 3) — the ONE top-line go/no-go that reconciles the
// Overview's engines so an RN doesn't have to read several contradictory chips. Pure PRESENTATION
// of computeReadinessVerdict (the one brain); it makes no decision of its own and fires NO model call:
//  • strategy-preview + viability-card + extraction-coverage: shared React-Query keys (RQ dedupes →
//    no extra requests; same data the cards below already fetch).
// ONE-BRAIN (Ryan #68/#72, 2026-06-25): the divergent PRE-DRAFT sanity-impression brain is retired.
// This card NO LONGER reads it (the cache read is gone) — the verdict defers to the route-picker plan
// (the single LLM brain) via the viability band. sanity is passed null → the asymmetric add-caution-only
// overlay is inert (it never relaxed a caution anyway). The POST-draft letter check still runs on the
// finished draft elsewhere (PostDraftSanityImpression), a separate concern.
// Advisory — does not block drafting; Gate-2 supersedes. Sits ABOVE the detailed cards as the headline.

const VERDICT_TONE: Record<ReadinessVerdict, string> = {
  draft: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  draft_confirm_mechanism: 'border-amber-300 bg-amber-50 text-amber-800',
  draft_reconcile: 'border-amber-300 bg-amber-50 text-amber-800',
  draft_with_changes: 'border-sky-200 bg-sky-50 text-sky-700',
  read_chart_first: 'border-amber-200 bg-amber-50 text-amber-700',
  analysis_failed: 'border-rose-300 bg-rose-50 text-rose-800', // chart known-empty — a hard stop, not ambient amber
  contact_records: 'border-amber-200 bg-amber-50 text-amber-700',
  contact_alternative: 'border-amber-200 bg-amber-50 text-amber-700',
  not_supportable: 'border-rose-200 bg-rose-50 text-rose-700',
  needs_review: 'border-slate-300 bg-slate-50 text-slate-600',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

const DISAGREEMENT_LABEL: Record<string, string> = {
  ai_sanity: 'AI sanity check',
  extraction: 'Chart coverage',
  viability_vs_strategy: 'Engine disagreement',
  band_vs_deterministic: 'Plan vs. deterministic check',
  chart_analysis: 'Chart analysis',
};

export function CaseReadinessVerdictCard({ caseId, claimedCondition, hasUnreadPages }: {
  readonly caseId: string;
  readonly claimedCondition: string;
  /** Single-sourced by the parent (the same useChartReadiness value RecommendedPlanCard receives) so
   *  the headline and the detail card can never disagree on whether the chart is fully read. */
  readonly hasUnreadPages?: boolean;
}) {
  const enabled = caseId.length > 0;
  const strategyQ = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled });
  const viabilityQ = useQuery({ queryKey: ['case', caseId, 'viability-card'], queryFn: () => getCaseViability(caseId), enabled });
  const coverageQ = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled });
  // PRE-DRAFT sanity-impression RETIRED (Ryan #68/#72, 2026-06-25): the divergent second LLM brain is gone.
  // The verdict defers to the route-picker plan; sanity is null below (inert add-caution-only overlay).

  // ── CHART-ANALYSIS-IN-PROGRESS GATE (Dr. Kasky 2026-06-30, redesign) ──────────────────────────────────
  // While the chart is genuinely still being analyzed, show ONE neutral placeholder — NO colored verdict pill,
  // no next-action, no disagreements. The verdict is built on the STRUCTURED chart Stage-2 produces; rendering
  // a colored go/no-go on a mid-analysis chart is exactly what let this card read green "Ready to draft" while
  // the SOAP plan hedged "Do not draft yet" (Walthour). Gated on the SAME coverage SSOT (shared react-query key
  // with the SOAP card, so both flip together — one brain). Fires ONLY for genuine in_progress: not_analyzed
  // (manual/no-extraction), complete, failed, and incomplete all fall through to computeReadinessVerdict's own
  // honest states below (which handle failed/incomplete via the chart-analysis safety overlay), so a manual case
  // is never stuck on "analyzing".
  const cov = coverageQ.data?.data ?? null;
  const chartAnalyzing = cov?.chartAnalysis?.state === 'in_progress' || cov?.status === 'in_progress';
  if (chartAnalyzing) {
    return (
      <SectionCard title="Case readiness">
        <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" aria-hidden />
          Still analyzing the chart — this can take a few minutes.
        </p>
        <p className="mt-0.5 text-sm text-slate-500">It keeps running in the background if you leave this page; check back shortly.</p>
      </SectionCard>
    );
  }

  // CHART-ANALYSIS SAFETY (Ryan 2026-06-23): feed Stage-2 analysis state into the verdict; fail SAFE while the
  // coverage query is loading/errored (state unknown → never a confident verdict). A resolved-but-null coverage
  // is NOT unknown (keeps the prior behavior).
  const result = computeReadinessVerdict({
    strategy: strategyQ.data?.data ?? null,
    viability: viabilityQ.data?.data ?? null,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: coverageQ.data?.data ?? null,
    sanity: null, // pre-draft sanity brain retired (one-brain) — defer to the route-picker plan
    chartAnalysisState: coverageQ.data?.data?.chartAnalysis?.state ?? null,
    chartAnalysisUnknown: coverageQ.isLoading || coverageQ.isError,
  });
  if (result === null) return null; // nothing computed yet → the headline hides

  const tone = VERDICT_TONE[result.verdict];

  return (
    <SectionCard
      title="Case readiness"
      status={
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`} title="One reconciled verdict over the engines below — advisory, does not block drafting; Gate-2 supersedes">
          {result.title}
        </span>
      }
    >
      <p className="text-sm font-medium text-slate-800">{result.nextAction}</p>
      <p className="mt-0.5 text-sm text-slate-600">{result.detail}</p>
      <p className="mt-1 text-xs text-slate-400">{CONFIDENCE_LABEL[result.confidence]}</p>

      {result.disagreements.length > 0 ? (
        <div className="mt-2 space-y-1" data-testid="readiness-disagreements">
          <div className="text-xs font-medium text-slate-500">Before you proceed:</div>
          <ul className="space-y-1">
            {result.disagreements.map((d, i) => (
              <li key={`${d.source}-${i}`} className="text-xs text-slate-600">
                <span className="font-medium text-amber-700">{DISAGREEMENT_LABEL[d.source] ?? d.source}:</span> {d.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
