import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { computeReadinessVerdict, type ReadinessVerdict } from '../lib/caseReadinessVerdict';

// Consolidated, easy-reading SOAP-note Overview (Ryan 2026-06-19; DECOUPLED + S/O/A/P 2026-06-20).
// ONE calm clinical summary that replaces the dense engine panels as the Overview lead: a traffic light,
// a headline, and Subjective / Objective / Assessment / Plan sections an RN can read at a glance.
//
// RELIABILITY: every section is assembled from data the Overview ALREADY fetches and that is FAST +
// deterministic (or already-cached) — never the fragile 22-26s route-picker call. So the card renders
// instantly, every time:
//   • Verdict / light / next-action  ← computeReadinessVerdict() (the same brain as the old readiness card)
//   • Subjective                      ← the veteran's own statement (prop)
//   • Objective                       ← strategy.inputSet (SC conditions, key facts, count) + coverage
//   • Assessment                      ← strategy.primaryArgument + mechanism, enriched by the already-computed
//                                        AI sanity-impression summary (cache-only read; the AI Sanity Check
//                                        card owns the call) and the picker's overall when present
//   • Plan                            ← the deterministic next action + what to confirm (missing fact / missed)
// The AI route-picker plan is an OPTIONAL enrichment of the Assessment headline; it never gates the render.

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
  not_supportable: 'red',
};
const CONFIDENCE_LABEL: Record<string, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
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
  const viabilityQ = useQuery({ queryKey: ['case', caseId, 'viability-card'], queryFn: () => getCaseViability(caseId), enabled });
  const coverageQ = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled });
  // Cache-only read of the pre-draft sanity impression (the AI Sanity Check card owns the Opus call).
  const sanityQ = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', 'pre_draft', 0],
    queryFn: () => getSanityImpression(caseId, { stage: 'pre_draft', claimedCondition } as SanityContextInput),
    enabled: false,
  });

  if (strategyQ.isLoading && viabilityQ.isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case…
      </div>
    );
  }

  const strategy = strategyQ.data?.data ?? null;
  const v = viabilityQ.data?.data ?? null;
  const result = computeReadinessVerdict({
    strategy,
    viability: v,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: coverageQ.data?.data ?? null,
    sanity: sanityQ.data?.data?.impression ?? null,
  });
  if (result === null) return null;

  const light = VERDICT_LIGHT[result.verdict];
  const L = LIGHT[light];

  const ai = viabilityQ.data?.aiViability ?? null;
  const ba = v?.best_anchor;
  const framingLabel = ba?.aggravation_only ? 'aggravation of' : 'secondary to';
  const headline = ai?.overall
    || strategy?.primaryArgument
    || (ba?.upstream_verbatim ? `${v?.claimed_canonical ?? claimedCondition} — ${framingLabel} ${ba.upstream_verbatim}` : result.title);

  // OBJECTIVE bits
  const scConditions = strategy?.inputSet?.scConditions ?? [];
  const keyFacts = (strategy?.inputSet?.keyFacts ?? []).slice(0, 3);
  const cov = coverageQ.data?.data;
  const coveragePct = typeof cov?.coveragePct === 'number' ? cov.coveragePct : null;

  // ASSESSMENT: the engine argument + mechanism, enriched by the already-computed AI sanity narrative.
  const mechanism = ai?.lead.mechanism || strategy?.proposedMechanism || null;
  const sanitySummary = sanityQ.data?.data?.summary?.trim() || null;
  const assessmentLead = ai?.lead.rationale || result.detail;

  // PLAN: the deterministic next action + what to confirm (missing fact / what the AI thinks may be missed).
  const toConfirm = (v?.missing_fact?.trim() || sanityQ.data?.data?.missed?.trim() || ai?.lead.counterargument?.trim() || null);

  const st = (veteranStatement ?? '').trim();

  return (
    <div className={`mb-4 rounded-lg border border-l-4 ${L.rule} border-slate-200 ${L.tint} px-5 py-4`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <span className={`inline-block h-2 w-2 rounded-full ${L.dot}`} />
          {result.title}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold leading-snug text-slate-900">{headline}</p>

      {st ? (
        <Section label="Subjective">
          <span className="text-slate-600">{st}</span>
        </Section>
      ) : null}

      <Section label="Objective">
        <span className="font-medium">{v?.claimed_canonical ?? claimedCondition}</span> — diagnosis on record.
        {scConditions.length > 0 ? <> Service-connected: {scConditions.join(', ')}.</> : null}
        {keyFacts.length > 0 ? <> {keyFacts.map((f) => `${f.label}: ${f.value}`).join('; ')}.</> : null}
        {coveragePct !== null ? <> Chart {coveragePct}% read{hasUnreadPages ? ' (some pages still unread)' : ''}.</> : null}
      </Section>

      <Section label="Assessment">
        {assessmentLead}
        {mechanism ? <> <span className="text-slate-500">Mechanism: {mechanism}.</span></> : null}
        {sanitySummary ? <div className="mt-1 text-slate-600">{sanitySummary}</div> : null}
        {ai?.convergent && ai.convergent.length > 0 ? (
          <div className="mt-1 text-slate-600"><span className="font-medium">Also supporting:</span> {ai.convergent.map((c) => c.upstream).filter(Boolean).join(', ')}.</div>
        ) : null}
      </Section>

      {result.disagreements.length > 0 ? (
        <Section label="Watch-outs">
          <ul className="space-y-1" data-testid="readiness-disagreements">
            {result.disagreements.map((d, i) => (
              <li key={`${d.source}-${i}`} className="text-sm text-slate-600">{d.note}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="mt-3 border-t border-[#E5DEC9] pt-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Plan</div>
        <div className="mt-0.5 text-[15px] font-medium text-slate-800"><span className="text-[#B08D3C]">→ </span>{result.nextAction}</div>
        {toConfirm ? <div className="mt-0.5 text-sm text-slate-600">Confirm: {toConfirm}</div> : null}
      </div>

      <div className="mt-2 text-[11px] text-slate-400">{CONFIDENCE_LABEL[result.confidence]} · A physician confirms before any letter is signed.</div>
    </div>
  );
}
