import { useQuery } from '@tanstack/react-query';
import { getSanityImpression, type SanityContextInput } from '../api/sanity-impression';
import { getStrategyPreview, type StrategyPreview } from '../api/strategy-preview';
import { getExtractionCoverage, type ExtractionCoverage } from '../api/extraction-coverage';
import { getLetter } from '../api/letter';
import { SectionCard } from './ui/SectionCard';

// The structured chart the sanity check needs for a real gut-check (Ryan 2026-06-16: "the whole chart
// should be — all meds, SC, active problems even if not SC"). Pulled from the strategy-preview inputSet
// that the wrappers ALREADY fetch — so it's the chart distilled into facts (cheap: small lists, no new
// call, no raw 200-page notes). Service caps these, so over-supplying is safe.
function chartContextFrom(p: StrategyPreview | undefined): { scConditions: string[]; keyFacts: string[] } {
  const inp = p?.inputSet;
  if (!inp) return { scConditions: [], keyFacts: [] };
  const keyFacts: string[] = [];
  for (const pr of inp.activeProblems) keyFacts.push(`Active problem: ${pr}`);
  for (const m of inp.medications) keyFacts.push(`Medication: ${m.drugName}${m.indication ? ` (for ${m.indication})` : ''}`);
  for (const f of inp.keyFacts) keyFacts.push(`${f.label}: ${f.value}`);
  return { scConditions: [...inp.scConditions], keyFacts: keyFacts.slice(0, 30) };
}

// Honest one-line coverage note from the per-page breakdown — drives the "were the records really all
// checked?" axis. Shared by the pre- and post-draft wrappers.
function coverageNoteFrom(cov: ExtractionCoverage | undefined): string | null {
  if (!cov) return null;
  const pb = cov.pageBreakdown ?? null;
  if (pb && (pb.unreadable > 0 || pb.handwritingUncertain > 0)) {
    const bits: string[] = [];
    if (pb.unreadable > 0) bits.push(`${pb.unreadable} page(s) could not be read`);
    if (pb.handwritingUncertain > 0) bits.push(`${pb.handwritingUncertain} page(s) have handwriting read with low confidence`);
    return `${bits.join('; ')}.`;
  }
  if (cov.coveragePct >= 100 && cov.gaps.length === 0) return 'All pages read.';
  if (cov.gaps.length > 0) return `${cov.gaps.length} item(s) not fully extracted.`;
  return null;
}

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
  const imp = q.data?.data;
  // Render nothing while loading or when the check returns nothing (fail-open + no empty-card flash) — the
  // card simply appears once the impression is ready.
  if (!imp) return null;
  const L = LABEL[imp.impression] ?? LABEL['clear']!;

  // Same frame as the other Overview cards (SectionCard + a small status chip), titled "AI Sanity Check"
  // so it reads as a distinct AI gut-check, not a second "Recommended plan". (Ryan 2026-06-16.)
  return (
    <SectionCard
      title="AI Sanity Check"
      status={
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${L.chip}`} title="Advisory — an AI gut-check, does not block drafting">
          {L.text}
        </span>
      }
    >
      <p className="text-sm text-slate-700">{imp.summary}</p>
      {imp.missed ? <p className="mt-1 text-sm text-slate-500">Worth a look: {imp.missed}</p> : null}
    </SectionCard>
  );
}

// PreDraftSanityImpression was RETIRED 2026-06-25 (Ryan, item #68). It assembled a pre_draft context and
// fired the skeptical Opus gut-check on the Overview, but it re-derived the theory and produced a
// misleading wrong-theory note (argued a strong DIRECT case as secondary-to-tinnitus), contradicting the
// SOAP overview's holistic read. The card was removed from CaseDetailPage; the backend
// POST /cases/:id/sanity-impression route + buildSanityImpression remain in place (unused by the UI) so
// this is reversible. SanityImpressionLine + the POST-draft wrapper below are unchanged.

/**
 * Post-draft wrapper — reads the drafted letter (getLetter.txt) and assembles the post_draft context
 * (the impression EXPANDS on the read of the letter; grade can be threaded later when a clean frontend
 * source exists). Renders the quiet impression line beneath the letter-ready panel. Hidden until there's
 * a real drafted letter (>=200 chars).
 */
export function PostDraftSanityImpression({ caseId, claimedCondition }: {
  readonly caseId: string;
  readonly claimedCondition: string;
}) {
  const letter = useQuery({ queryKey: ['case', caseId, 'letter'], queryFn: () => getLetter(caseId), enabled: caseId.length > 0, retry: false });
  const strategy = useQuery({ queryKey: ['case', caseId, 'strategy-preview'], queryFn: () => getStrategyPreview(caseId), enabled: caseId.length > 0 });
  const coverage = useQuery({ queryKey: ['case', caseId, 'extraction-coverage'], queryFn: () => getExtractionCoverage(caseId), enabled: caseId.length > 0 });

  const txt = letter.data?.data?.txt;
  if (!txt || txt.trim().length < 200 || claimedCondition.trim().length === 0) return null;

  const chart = chartContextFrom(strategy.data?.data);
  const context: SanityContextInput = {
    stage: 'post_draft',
    claimedCondition,
    veteranTheory: strategy.data?.data?.proposedMechanism ?? null,
    theory: strategy.data?.data?.primaryArgument ?? null,
    scConditions: chart.scConditions,
    keyFacts: chart.keyFacts,
    coverageNote: coverageNoteFrom(coverage.data?.data),
    draftText: txt,
  };
  return <SanityImpressionLine caseId={caseId} context={context} />;
}
