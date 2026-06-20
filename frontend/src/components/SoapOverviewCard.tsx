import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { computeReadinessVerdict, type ReadinessVerdict } from '../lib/caseReadinessVerdict';

// Consolidated calm SOAP-note Overview (Ryan 2026-06-19; DECOUPLED 2026-06-20). The calm front of the
// Overview: one short summary + ONE traffic light + one next action.
//
// THE FIX (decouple from the fragile picker): this renders from `computeReadinessVerdict()` — the SAME
// deterministic brain that powers the dense "Case readiness" card — over data the Overview ALREADY fetches
// (strategy-preview + viability-card.data + extraction-coverage + cached sanity). That data is fast and
// reliable, so the card renders IMMEDIATELY, every time. The AI route-picker plan (aiViability) is an
// OPTIONAL prose UPGRADE: when present it enriches the headline/rationale, but it NEVER gates whether the
// card appears and NEVER moves the traffic light or the next action (those stay deterministic). Previously
// the card was `if (!aiViability) return null`, so a 22-26s picker timeout made the whole card vanish.

type Light = 'green' | 'amber' | 'red';
const LIGHT: Record<Light, { rule: string; dot: string; word: string; tint: string }> = {
  green: { rule: 'border-l-[#5E8B7E]', dot: 'bg-[#5E8B7E]', word: 'Ready', tint: 'bg-[#F1F5F2]' },
  amber: { rule: 'border-l-[#C19A5B]', dot: 'bg-[#C19A5B]', word: 'Proceed with caution', tint: 'bg-[#F7F2E8]' },
  red: { rule: 'border-l-[#B0654F]', dot: 'bg-[#B0654F]', word: 'Get / verify records', tint: 'bg-[#F6EDE9]' },
};

// The light is derived from the DETERMINISTIC verdict, not the picker — so a picker timeout/absence can
// never blank or mis-color the card. Clean go → green; any caution/contact/read-first → amber; no path → red.
const VERDICT_LIGHT: Record<ReadinessVerdict, Light> = {
  draft: 'green',
  draft_confirm_mechanism: 'amber',
  draft_reconcile: 'amber',
  draft_with_changes: 'amber',
  read_chart_first: 'amber',
  contact_records: 'amber',
  contact_alternative: 'amber',
  not_supportable: 'red',
  needs_review: 'amber',
};

const CONFIDENCE_LABEL: Record<string, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
const DISAGREEMENT_LABEL: Record<string, string> = { ai_sanity: 'AI sanity check', extraction: 'Chart coverage', viability_vs_strategy: 'Engine disagreement' };

export function SoapOverviewCard({ caseId, claimedCondition, hasUnreadPages }: {
  readonly caseId: string;
  readonly claimedCondition: string;
  /** Single-sourced by the parent (same useChartReadiness value the other cards get) so the light and the
   *  detail cards can never disagree on read-state. */
  readonly hasUnreadPages?: boolean;
}) {
  const enabled = caseId.length > 0;
  // All shared React-Query keys → RQ dedupes; these are the SAME fetches the cards below already make.
  const strategyQ = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled });
  const viabilityQ = useQuery({ queryKey: ['case', caseId, 'viability-card'], queryFn: () => getCaseViability(caseId), enabled });
  const coverageQ = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled });
  // READ-ONLY cache read of the pre-draft sanity impression (the AI Sanity Check card owns the call).
  const sanityQ = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', 'pre_draft', 0],
    queryFn: () => getSanityImpression(caseId, { stage: 'pre_draft', claimedCondition } as SanityContextInput),
    enabled: false,
  });

  // Still loading the FAST inputs (not the picker) → a brief calm placeholder.
  if (strategyQ.isLoading && viabilityQ.isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case…
      </div>
    );
  }

  const result = computeReadinessVerdict({
    strategy: strategyQ.data?.data ?? null,
    viability: viabilityQ.data?.data ?? null,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: coverageQ.data?.data ?? null,
    sanity: sanityQ.data?.data?.impression ?? null,
  });
  if (result === null) return null; // the engine produced nothing at all (off / both fail-open) — hide, like the dense card

  const light = VERDICT_LIGHT[result.verdict];
  const L = LIGHT[light];

  // OPTIONAL picker-prose upgrade — never gates render, never moves the light or the action.
  const ai = viabilityQ.data?.aiViability ?? null;
  const v = viabilityQ.data?.data ?? null;
  const ba = v?.best_anchor;
  // Headline = the argument. Prefer the picker's plain-language overall; else build from the static anchor.
  const framingLabel = ba?.aggravation_only ? 'aggravation of' : 'secondary to';
  const staticHeadline = ba?.upstream_verbatim
    ? `${v?.claimed_canonical ?? claimedCondition} — ${framingLabel} ${ba.upstream_verbatim}`
    : result.title;
  const headline = ai?.overall || (ai ? `${ai.lead.upstream} → ${ai.lead.claimed}` : staticHeadline);
  const body = ai?.lead.rationale || result.detail;
  const watchouts = [
    ...result.disagreements.map((d) => ({ label: DISAGREEMENT_LABEL[d.source] ?? d.source, note: d.note })),
    ...(ai?.lead.counterargument ? [{ label: 'Watch out', note: ai.lead.counterargument }] : []),
  ];
  const convergent = ai?.convergent?.filter((c) => c.upstream).map((c) => c.upstream) ?? [];

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
      <p className="mt-1 text-[15px] leading-relaxed text-slate-700">{body}</p>
      {convergent.length > 0 ? (
        <div className="mt-2 text-[15px] text-slate-700"><span className="font-medium">Also supporting (same mechanism):</span> {convergent.join(', ')}</div>
      ) : null}
      {watchouts.length > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-medium text-slate-500">Before you proceed:</div>
          <ul className="space-y-1" data-testid="readiness-disagreements">
            {watchouts.map((w, i) => (
              <li key={`${w.label}-${i}`} className="text-sm text-slate-600">
                <span className="font-medium text-amber-700">{w.label}:</span> {w.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 border-t border-[#E5DEC9] pt-2 text-[15px] font-medium text-slate-800">
        <span className="text-[#B08D3C]">→ </span>{result.nextAction}
      </div>
      <div className="mt-2 text-[11px] text-slate-400">{CONFIDENCE_LABEL[result.confidence]} · A physician confirms before any letter is signed.</div>
    </div>
  );
}
