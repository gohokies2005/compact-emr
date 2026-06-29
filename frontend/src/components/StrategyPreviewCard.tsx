import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview } from '../api/strategy-preview';
import { SectionCard } from './ui/SectionCard';
import { InputVisibility, ChainPathwayNote, CompletenessSignal, type CompletenessState } from './ViabilityInputSet';

// Pre-draft strategy section. QUIET argument/theory summary by design (Ryan 2026-06-29): the deterministic
// VERDICT surfaces were removed from the Action tab so the LLM SOAP/viability card is the SINGLE pre-draft
// signal. This card no longer renders a tier chip ("Thin — review"/"Review needed"), the brittle
// cdsEngine ✓/△/✗ "Strategy checks" checklist, or the auto-expand-when-concerning behavior — those
// duplicated and could contradict the SOAP verdict. It now shows ONLY non-alarming context: the primary
// argument, a SUGGESTED stronger pathway when one exists, the aggravation framing, the veteran's own
// stated theory, and the "Computed from N facts" input visibility. No ✓/⚠ verdict.

export function StrategyPreviewCard({
  caseId,
  chartReady,
  completeness,
}: {
  readonly caseId: string;
  readonly chartReady?: boolean;
  // E5 (2026-06-13): how much of the record went unparsed (OCR-blocked files + extraction gaps),
  // threaded from SendToDrafterPanel's chart-readiness query so the verdict carries a completeness
  // caveat. Undefined = caller didn't supply it (unit tests) → no banner.
  readonly completeness?: CompletenessState | null;
}) {
  const q = useQuery({
    queryKey: ['case', caseId, 'strategy-preview'],
    queryFn: () => getStrategyPreview(caseId),
    enabled: caseId.length > 0,
  });
  const p = q.data?.data;
  if (!p || !p.evaluable) return null; // quiet on load/error and on untriaged cases

  // While the chart is still scanning, the underlying facts aren't confirmed yet — surface a neutral
  // "still analyzing" caveat (not a verdict) so the RN knows this summary is preliminary (Ryan 2026-06-08).
  const unconfirmed = chartReady === false;
  const v = p.viability ?? null;
  const rec = p.recommendedPathway;
  // Aggravation-only re-characterization (FRN engine 5d04b62): surface the 3.310(b)-only framing as a
  // single sentence sourced from the engine's why (Ryan ratified the framing 2026-06-11).
  const aggravationOnly = v?.best_anchor?.aggravation_only === true;
  const whyFirstSentence = v !== null && v.why.includes('. ') ? v.why.slice(0, v.why.indexOf('. ') + 1) : v?.why ?? '';

  // No status chip (Ryan 2026-06-29): the tier/band verdict chip was removed so this card carries no
  // ✓/⚠ verdict — the SOAP/viability card is the single pre-draft signal. This is quiet context only.
  return (
    <SectionCard title="Background & argument">
      <div>
        <div className="min-w-0">
          <div className="text-sm text-slate-800"><span className="font-medium">Argument:</span> {p.primaryArgument}</div>
          {rec.kind === 'secondary' && rec.differsFromCurrent && rec.anchor !== p.anchor ? (
            <div className="mt-1 text-sm text-slate-500">
              <span className="font-medium">Anticipated:</span> likely stronger as <span className="font-medium">secondary to {rec.anchor}</span>
              {rec.basis ? ` (${rec.basis})` : ''}. FYI — the drafter weighs this.
            </div>
          ) : null}
          {aggravationOnly ? (
            <div className="mt-1 text-sm text-slate-700">
              <span className="font-medium">Argue aggravation (3.310(b)):</span> {whyFirstSentence}
            </div>
          ) : null}
          {p.proposedMechanism ? (
            <div className="mt-1 text-sm text-slate-600"><span className="font-medium">Veteran’s theory:</span> {p.proposedMechanism}</div>
          ) : null}
          {unconfirmed ? (
            // TODO(doc-pipeline): thread extracted/total counts from chart-readiness to render "(N of M)".
            <div className="mt-1 text-xs text-amber-700">
              Documents not yet extracted — this summary may change once OCR completes.
            </div>
          ) : null}
          {/* E5 INTERMEDIARY CHECK — a direct "no" auto-explored the two-hop chain; surface the result
              (recovered pathway OR an honest "searched, none found") instead of a silent flat decline. */}
          {p.chainAttempt ? <ChainPathwayNote chainAttempt={p.chainAttempt} /> : null}
          {/* E5 COMPLETENESS SIGNAL — a thin parse must never masquerade as a confident summary. */}
          <CompletenessSignal state={completeness ?? null} />
          {/* E5 INPUT VISIBILITY — the exact fact set this summary was computed from. */}
          {p.inputSet ? <InputVisibility inputSet={p.inputSet} /> : null}
        </div>
      </div>
    </SectionCard>
  );
}
