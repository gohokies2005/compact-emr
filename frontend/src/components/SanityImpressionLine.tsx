import { useQuery } from '@tanstack/react-query';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { getStrategyPreview } from '../api/strategy-preview';
import { getExtractionCoverage } from '../api/extraction-coverage';

/**
 * The auto-fired "overall impression" line (Ryan 2026-06-16) — the last line of a SOAP note, recreated:
 * a calm, glanceable Clear / Caution / Concern + 1–3 sentences. Fires automatically when its context is
 * ready (no button). FAIL-OPEN + QUIET: while running, or when the check returns nothing, it renders
 * nothing rather than nagging. Color lives ONLY in the small chip (emerald/amber, never red); the rest
 * is plain text with bold for the few words that matter.
 */

const LABEL: Record<string, { text: string; chip: string }> = {
  clear: { text: 'Clear', chip: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  caution: { text: 'Caution', chip: 'border-amber-200 bg-amber-50 text-amber-700' },
  concern: { text: 'Concern', chip: 'border-amber-300 bg-amber-50 text-amber-800' },
};

export function SanityImpressionLine({ caseId, context }: {
  readonly caseId: string;
  // null = not enough data yet (the line stays hidden). The caller assembles it from existing Overview data.
  readonly context: SanityContextInput | null;
}) {
  const q = useQuery({
    queryKey: ['case', caseId, 'sanity-impression', context?.stage ?? 'none', (context?.draftText ?? '').length],
    queryFn: () => getSanityImpression(caseId, context as SanityContextInput),
    enabled: context !== null && context.claimedCondition.trim().length > 0,
    staleTime: 5 * 60 * 1000, // one check per stage entry — don't recompute on every render/poll
    retry: false,
  });

  if (context === null) return null;
  if (q.isLoading) return <p className="text-xs text-slate-400">Running a final sanity check…</p>;
  const imp = q.data?.data;
  if (!imp) return null; // fail-open: no impression → say nothing
  const L = LABEL[imp.impression] ?? LABEL['clear']!;

  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${L.chip}`} title="Advisory — an AI gut-check, does not block">
        {L.text}
      </span>
      <div className="min-w-0 text-slate-700">
        <span className="font-medium">Overall impression:</span> {imp.summary}
        {imp.missed ? <span className="mt-0.5 block text-slate-500">Worth a look: {imp.missed}</span> : null}
      </div>
    </div>
  );
}

/**
 * Pre-draft wrapper — assembles the context from data the Overview already fetches (the strategy's
 * primaryArgument as the "theory", and the extraction coverage as the honest "were the records really
 * read?" note), via React-Query keys SHARED with the cards (so it adds no extra fetch). Renders the
 * impression as a quiet footer line under the story. Hidden until there's a real (evaluable) strategy.
 */
export function PreDraftSanityImpression({ caseId, claimedCondition }: {
  readonly caseId: string;
  readonly claimedCondition: string;
}) {
  const strategy = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled: caseId.length > 0 });
  const coverage = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled: caseId.length > 0 });

  const p = strategy.data?.data;
  const cov = coverage.data?.data;
  if (!p || !p.evaluable || claimedCondition.trim().length === 0) return null;

  // Honest one-line coverage note (drives the "were the records really all checked?" axis).
  let coverageNote: string | null = null;
  const pb = cov?.pageBreakdown ?? null;
  if (pb && (pb.unreadable > 0 || pb.handwritingUncertain > 0)) {
    const bits: string[] = [];
    if (pb.unreadable > 0) bits.push(`${pb.unreadable} page(s) could not be read`);
    if (pb.handwritingUncertain > 0) bits.push(`${pb.handwritingUncertain} page(s) have handwriting read with low confidence`);
    coverageNote = `${bits.join('; ')}.`;
  } else if (cov && cov.coveragePct >= 100 && cov.gaps.length === 0) {
    coverageNote = 'All pages read.';
  } else if (cov && cov.gaps.length > 0) {
    coverageNote = `${cov.gaps.length} item(s) not fully extracted.`;
  }

  const context: SanityContextInput = {
    stage: 'pre_draft',
    claimedCondition,
    theory: p.primaryArgument ?? null,
    coverageNote,
  };
  return (
    <div className="border-t border-slate-100 pt-3">
      <SanityImpressionLine caseId={caseId} context={context} />
    </div>
  );
}
