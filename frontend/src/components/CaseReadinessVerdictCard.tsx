import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { computeReadinessVerdict, type ReadinessVerdict, type Confidence } from '../lib/caseReadinessVerdict';
import { SectionCard } from './ui/SectionCard';

// Case Readiness Verdict (2026-06-18, Cluster 3) — the ONE top-line go/no-go that reconciles the
// Overview's four engines so an RN doesn't have to read four contradictory chips. Pure PRESENTATION
// of computeReadinessVerdict (the one brain); it makes no decision of its own and fires NO model call:
//  • strategy-preview + viability-card + extraction-coverage: shared React-Query keys (RQ dedupes →
//    no extra requests; same data the cards below already fetch).
//  • sanity-impression: read from the cache ONLY (enabled:false) — the AI Sanity Check card owns the
//    one Opus call; this never triggers a second one. Absent cache → 'unavailable' (NOT 'clear'), so
//    the verdict stays honest until the gut-check lands, then re-renders to fold it in (add-caution-only).
// Advisory — does not block drafting; Gate-2 supersedes. Sits ABOVE the detailed cards as the headline.

const VERDICT_TONE: Record<ReadinessVerdict, string> = {
  draft: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  draft_confirm_mechanism: 'border-amber-300 bg-amber-50 text-amber-800',
  draft_reconcile: 'border-amber-300 bg-amber-50 text-amber-800',
  draft_with_changes: 'border-sky-200 bg-sky-50 text-sky-700',
  read_chart_first: 'border-amber-200 bg-amber-50 text-amber-700',
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
  // READ-ONLY cache read of the pre-draft sanity impression (the AI Sanity Check card owns the call).
  // enabled:false → never fetches; same key the card uses (stage 'pre_draft', draftText length 0).
  const sanityQ = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', 'pre_draft', 0],
    queryFn: () => getSanityImpression(caseId, { stage: 'pre_draft', claimedCondition } as SanityContextInput),
    enabled: false,
  });

  const result = computeReadinessVerdict({
    strategy: strategyQ.data?.data ?? null,
    viability: viabilityQ.data?.data ?? null,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: coverageQ.data?.data ?? null,
    sanity: sanityQ.data?.data?.impression ?? null,
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
