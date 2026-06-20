import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability, getSoapNote, type SoapContextInput } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { computeReadinessVerdict, type ReadinessVerdict } from '../lib/caseReadinessVerdict';

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
  not_supportable: 'red',
};
const CONFIDENCE_LABEL: Record<string, string> = { high: 'High confidence', moderate: 'Moderate confidence', medium: 'Medium confidence', low: 'Low confidence' };

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
  const sanityQ = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', 'pre_draft', 0],
    queryFn: () => getSanityImpression(caseId, { stage: 'pre_draft', claimedCondition } as SanityContextInput),
    enabled: false,
  });

  const strategy = strategyQ.data?.data ?? null;
  const v = viabilityQ.data?.data ?? null;
  const result = computeReadinessVerdict({
    strategy, viability: v,
    hasUnreadPages: hasUnreadPages ?? null,
    extraction: coverageQ.data?.data ?? null,
    sanity: sanityQ.data?.data?.impression ?? null,
  });

  // Assemble the SOAP context once the fast inputs are in, then POST it for the AI synthesis. Keyed on the
  // case (one call per case; cached server- and client-side). Enabled only when there's something to write.
  const cov = coverageQ.data?.data;
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
  const soapQ = useQuery({
    queryKey: ['case', caseId, 'soap-note'],
    queryFn: () => getSoapNote(caseId, ctx),
    enabled: enabled && strategy !== null, // ctx is meaningful once the strategy/inputSet is loaded
    staleTime: 10 * 60 * 1000,
  });

  if (strategyQ.isLoading && viabilityQ.isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case…
      </div>
    );
  }
  if (result === null) return null;

  const light = VERDICT_LIGHT[result.verdict];
  const L = LIGHT[light];
  const note = soapQ.data?.data ?? null;
  const headline = strategy?.primaryArgument
    || (v?.best_anchor?.upstream_verbatim ? `${v.claimed_canonical ?? claimedCondition} — secondary to ${v.best_anchor.upstream_verbatim}` : result.title);

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

      {note ? (
        <>
          {note.subjective ? <Section label="Subjective">{note.subjective}</Section> : null}
          {note.objective ? <Section label="Objective">{note.objective}</Section> : null}
          {note.assessment ? <Section label="Assessment">{note.assessment}</Section> : null}
          {note.caveat ? (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800">
              <span className="font-medium">⚠ Verify:</span> {note.caveat}
            </div>
          ) : null}
          <div className="mt-3 border-t border-[#E5DEC9] pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Plan</div>
            <div className="mt-0.5 text-[15px] font-medium text-slate-800"><span className="text-[#B08D3C]">→ </span>{note.plan}</div>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">{CONFIDENCE_LABEL[note.confidence] ?? note.confidence} · A physician confirms before any letter is signed.</div>
        </>
      ) : (
        // Deterministic fallback (AI summary loading or unavailable) — always useful.
        <>
          <p className="mt-1 text-[15px] leading-relaxed text-slate-700">{result.detail}</p>
          <div className="mt-3 border-t border-[#E5DEC9] pt-2 text-[15px] font-medium text-slate-800">
            <span className="text-[#B08D3C]">→ </span>{result.nextAction}
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            {soapQ.isFetching ? 'Writing the summary…' : `${CONFIDENCE_LABEL[result.confidence] ?? result.confidence} · A physician confirms before any letter is signed.`}
          </div>
        </>
      )}
    </div>
  );
}
