import { useQuery } from '@tanstack/react-query';
import { getCaseViability, type AiViabilityCard } from '../api/case-viability';

// Consolidated calm SOAP-note Overview (Ryan 2026-06-19) — the calm front of the case Overview: one
// short summary + ONE traffic light. RENDERS DETERMINISTICALLY from the AI route-picker plan the card
// already fetched (SAME react-query key → ONE fetch, NO second LLM call → no 29s-timeout silent fail).
// The picker's own RO-voice prose is the narrative; the traffic light is computed in code (the AI never
// picks the color). Renders nothing when the picker is off / fail-open (the dense panels remain).

type Light = 'green' | 'amber' | 'red';
const LIGHT: Record<Light, { rule: string; dot: string; word: string; tint: string }> = {
  green: { rule: 'border-l-[#5E8B7E]', dot: 'bg-[#5E8B7E]', word: 'Ready', tint: 'bg-[#F1F5F2]' },
  amber: { rule: 'border-l-[#C19A5B]', dot: 'bg-[#C19A5B]', word: 'Proceed with caution', tint: 'bg-[#F7F2E8]' },
  red: { rule: 'border-l-[#B0654F]', dot: 'bg-[#B0654F]', word: 'Get / verify records', tint: 'bg-[#F6EDE9]' },
};

// The light is DETERMINISTIC (QA 2026-06-19): green ONLY for a supportable + HIGH-confidence pick on a
// FULLY-READ chart. Moderate/low confidence, a dominant confounder (→ not high), OR an unread/partial
// chart pulls it to amber — so a confounder-heavy OSA claim never shows a confident green.
function deriveLight(ai: AiViabilityCard, chartFullyRead: boolean | null): Light {
  if (ai.viability === 'not_supportable') return 'red';
  if (ai.viability === 'needs_physician_review' || ai.viability === 'marginal') return 'amber';
  // supportable:
  if (ai.lead.confidence === 'high' && chartFullyRead === true) return 'green';
  return 'amber';
}

const FRAMING_LABEL: Record<string, string> = {
  aggravation: 'aggravation (worsened by)',
  secondary_causation: 'secondary (caused by)',
  dual_prong: 'secondary + aggravation',
  direct: 'direct service connection',
  presumptive: 'presumptive',
};

function nextAction(ai: AiViabilityCard, light: Light): string {
  if (light === 'green') return 'Proceed to drafting on this pathway.';
  if (light === 'red') return 'No supported pathway as filed — discuss other conditions or the records still needed before declining.';
  // amber:
  if (ai.missing.length > 0) return `Before drafting, confirm: ${ai.missing.map((m) => m.fact).join('; ')}.`;
  return 'Physician review of the pathway strength before drafting.';
}

export function SoapOverviewCard({ caseId }: { readonly caseId: string }) {
  // SAME query key as CaseViabilityCard → react-query serves one shared fetch (one picker call total).
  const q = useQuery({
    queryKey: ['case', caseId, 'viability-card'],
    queryFn: () => getCaseViability(caseId),
    enabled: caseId.length > 0,
    retry: 1, // a rare picker timeout fails fast (no multi-minute retry storm); the static panels remain
    staleTime: 5 * 60 * 1000,
    // The picker plan is now computed OFF the request path (async self-invoke); the first GET fires the
    // compute and returns no aiViability yet. Poll until the plan lands (~25s, once), then stop. Only poll
    // when the engine is ON (data !== null) but the plan isn't ready — never poll forever / when flag off.
    // Capped (~16 polls ≈ 96s) so a genuinely-failing picker degrades to the static panels, not a poll storm.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d || d.data === null || d.aiViability) return false; // off / fail-open / plan present → stop
      if (query.state.dataUpdateCount > 16) return false;       // give up → static panels remain
      return 6000;
    },
    refetchIntervalInBackground: false, // don't burn API on a walked-away RN
  });

  if (q.isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case and writing the summary… a few seconds.
      </div>
    );
  }
  const ai = q.data?.aiViability;
  if (!ai) return null; // picker off / fail-open — the dense panels render as before

  const light = deriveLight(ai, q.data?.chartFullyRead ?? null);
  const L = LIGHT[light];
  const framing = FRAMING_LABEL[ai.lead.framing] ?? ai.lead.framing;
  const headline = ai.overall || `${ai.lead.upstream} → ${ai.lead.claimed}`;
  return (
    <div className={`mb-4 rounded-lg border border-l-4 ${L.rule} border-slate-200 ${L.tint} px-5 py-4`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <span className={`inline-block h-2 w-2 rounded-full ${L.dot}`} />
          {L.word}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold leading-snug text-slate-900">{headline}</p>
      <div className="mt-1 text-[15px] leading-relaxed text-slate-700">
        <span className="font-medium">{ai.lead.upstream}</span> → {ai.lead.claimed}
        {framing ? <span className="text-slate-500"> ({framing})</span> : null}
        {ai.lead.confidence ? <span className="text-slate-400"> · {ai.lead.confidence} confidence</span> : null}
      </div>
      {ai.lead.rationale ? <div className="mt-2 text-[15px] leading-relaxed text-slate-700">{ai.lead.rationale}</div> : null}
      {ai.convergent.length > 0 ? (
        <div className="mt-2 text-[15px] text-slate-700"><span className="font-medium">Also supporting (same mechanism):</span> {ai.convergent.map((c) => c.upstream).join(', ')}</div>
      ) : null}
      {ai.lead.counterargument ? (
        <div className="mt-2 text-sm text-slate-600"><span className="font-medium">Watch out:</span> {ai.lead.counterargument}</div>
      ) : null}
      <div className="mt-3 border-t border-[#E5DEC9] pt-2 text-[15px] font-medium text-slate-800">
        <span className="text-[#B08D3C]">→ </span>{nextAction(ai, light)}
      </div>
      <div className="mt-2 text-[11px] text-slate-400">AI summary of the case engine. A physician confirms before any letter is signed.</div>
    </div>
  );
}
