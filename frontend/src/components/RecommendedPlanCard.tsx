import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { recommendedPlan, type RecommendationKind } from '../lib/recommendedPlan';
import { SectionCard } from './ui/SectionCard';

// Recommended plan (2026-06-16) — the "here's what to do" section of the Overview story. Pure
// PRESENTATION of the recommendedPlan selector (one-brain readout of the engine; no new decisions).
// Fetches the SAME strategy-preview + viability-card queries the cards already fetch (RQ dedupes by
// key → no extra requests) and renders the recommendation. The copy-paste customer email (Phase 4)
// slots into the `emailEligible` block; rendered here as a placeholder until that lands.

const CHIP: Record<RecommendationKind, { readonly label: string; readonly cls: string }> = {
  draft: { label: 'Draft', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  draft_with_changes: { label: 'Draft — adjust anchor', cls: 'border-sky-200 bg-sky-50 text-sky-700' },
  contact_records: { label: 'Contact veteran', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  contact_alternative: { label: 'Contact veteran', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  not_draftable: { label: 'Not supportable', cls: 'border-rose-200 bg-rose-50 text-rose-700' },
  needs_review: { label: 'Needs review', cls: 'border-slate-300 bg-slate-50 text-slate-600' },
};

export function RecommendedPlanCard({
  caseId,
  hasUnreadPages,
}: {
  readonly caseId: string;
  /** From the page readiness hook (unread files/pages > 0) — softens contact-records → needs-review. */
  readonly hasUnreadPages?: boolean;
}) {
  const enabled = caseId.length > 0;
  const strategyQ = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled });
  const viabilityQ = useQuery({ queryKey: ['case', caseId, 'viability-card'], queryFn: () => getCaseViability(caseId), enabled });

  const plan = recommendedPlan({
    strategy: strategyQ.data?.data ?? null,
    viability: viabilityQ.data?.data ?? null,
    hasUnreadPages: hasUnreadPages ?? false,
  });
  if (plan === null) return null; // nothing computed yet → section hides

  const chip = CHIP[plan.kind];

  return (
    <SectionCard
      title="Recommended plan"
      status={<span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>{chip.label}</span>}
    >
      <p className="text-sm text-slate-700">{plan.detail}</p>

      {plan.kind === 'draft_with_changes' && plan.switchToAnchor ? (
        <p className="mt-1 text-xs text-slate-500">
          The framing change is applied + flagged automatically when you send to the drafter.
        </p>
      ) : null}

      {/* Copy-paste customer outreach email (Phase 4: Sonnet-drafted, FRN voice, Copy button). */}
      {plan.emailEligible ? (
        <p className="mt-2 text-xs text-slate-400" data-testid="recommended-plan-email-slot">
          A short outreach email you can copy will appear here.
        </p>
      ) : null}
    </SectionCard>
  );
}
