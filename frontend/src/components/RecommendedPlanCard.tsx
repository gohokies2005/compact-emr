import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { postRecommendationEmail } from '../api/recommendation-email';
import { recommendedPlan, type RecommendationKind, type RecommendedPlan } from '../lib/recommendedPlan';
import { SectionCard } from './ui/SectionCard';
import { Button } from './ui/Button';

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

      {/* Copy-paste customer outreach email (Sonnet-drafted, FRN voice + mechanical guards, on-demand). */}
      {plan.emailEligible ? <OutreachEmail caseId={caseId} plan={plan} /> : null}
    </SectionCard>
  );
}

/** On-demand Sonnet-drafted outreach email: button → draft → editable textarea + Copy. Never auto-sent. */
function OutreachEmail({ caseId, plan }: { readonly caseId: string; readonly plan: RecommendedPlan }) {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const kind = plan.kind === 'contact_alternative' ? 'contact_alternative' : 'contact_records';
  const m = useMutation({
    mutationFn: () => postRecommendationEmail(caseId, {
      kind,
      ...(plan.missingFact ? { missingFact: plan.missingFact } : {}),
      ...(plan.bridge ? { bridge: { intermediate_dx: plan.bridge.intermediate_dx, claimed: plan.bridge.claimed, intermediate_presumptive_basis: plan.bridge.intermediate_presumptive_basis } } : {}),
    }),
    onSuccess: (r) => { setText(r.data.text); setCopied(false); },
  });
  const result = m.data?.data;

  if (text === null) {
    return (
      <div className="mt-3" data-testid="recommended-plan-email-slot">
        <Button type="button" variant="secondary" size="sm" loading={m.isPending} onClick={() => m.mutate()}>
          Draft outreach email
        </Button>
        {m.isError ? <p className="mt-1 text-xs text-rose-600">Couldn’t draft the email. Try again.</p> : null}
      </div>
    );
  }

  // Humanize the engine flag codes — never show raw `type` tokens to staff.
  const FLAG_LABEL: Record<string, string> = {
    overpromise: 'an outcome promise',
    scheduling: 'scheduling language',
    voice: 'first-person voice (use "we")',
  };
  const reviewLabels = (result?.flags ?? [])
    .filter((f) => f.severity === 'review')
    .map((f) => FLAG_LABEL[f.type] ?? f.type);
  const hasBlockFlag = (result?.flags ?? []).some((f) => f.severity === 'block');
  return (
    <div className="mt-3 space-y-2" data-testid="recommended-plan-email">
      <div className="text-xs font-medium text-slate-500">Outreach email (edit before copying)</div>
      {result?.source === 'template' ? (
        <p className="text-xs text-amber-700">Drafted from a safe template (the AI draft was unavailable or withheld). Please personalize before sending.</p>
      ) : null}
      {hasBlockFlag ? (
        <p className="text-xs text-rose-700">A draft was withheld because it referenced fees or money; this is a safe template instead.</p>
      ) : null}
      {reviewLabels.length > 0 ? (
        <p className="text-xs text-amber-700">Heads up, please review for {reviewLabels.join(', ')} before sending.</p>
      ) : null}
      <textarea
        aria-label="Outreach email"
        className="w-full rounded-md border border-slate-300 p-2 text-sm text-slate-700"
        rows={9}
        value={text}
        onChange={(e) => { setText(e.target.value); setCopied(false); }}
      />
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="secondary" size="sm" loading={m.isPending} onClick={() => m.mutate()}>Redraft</Button>
      </div>
    </div>
  );
}
