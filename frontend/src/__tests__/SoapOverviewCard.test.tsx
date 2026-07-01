// SoapOverviewCard — route-picker plan RELIABILITY surface (Ryan 2026-06-21, Zimmelman). Pins the fix for
// the misleading resting verdict: when the route-picker plan (the SAME brain the drafter uses) is the
// intended brain but is NOT ready, the card must show an HONEST surface — a "Analyzing the case…" spinner
// while computing, or an "analysis couldn’t be completed" + Retry on a genuine failure — and must NEVER
// render the resting "Not supportable as filed" deterministic verdict (which misleads "it won't get drafted").
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SoapOverviewCard } from '../components/SoapOverviewCard';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability, computeCaseViability, getSoapNote } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';

vi.mock('../api/strategy-preview', () => ({ getStrategyPreview: vi.fn() }));
vi.mock('../api/extraction-coverage', () => ({ getExtractionCoverage: vi.fn() }));
vi.mock('../api/sanity-impression', () => ({ getSanityImpression: vi.fn(async () => ({ data: null })) }));
vi.mock('../api/case-viability', () => ({
  getCaseViability: vi.fn(),
  computeCaseViability: vi.fn(),
  getSoapNote: vi.fn(async () => ({ data: null, grounded: false })),
}));

const strategyMock = vi.mocked(getStrategyPreview);
const viabilityMock = vi.mocked(getCaseViability);
const computeMock = vi.mocked(computeCaseViability);
const coverageMock = vi.mocked(getExtractionCoverage);

// A minimal strategy that yields a deterministic "Not supportable as filed" verdict (tier Stop, no anchor) —
// exactly the misleading resting verdict we must NOT show while the plan is computing/failed.
const STOP_STRATEGY = {
  data: { tier: 'Stop', primaryArgument: null, proposedMechanism: null, recommendedPathway: null, inputSet: { scConditions: [], activeProblems: [], keyFacts: [], medications: [] } },
} as unknown as Awaited<ReturnType<typeof getStrategyPreview>>;

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<SoapOverviewCard caseId="CASE-1" claimedCondition="Obstructive sleep apnea" />, { wrapper: Wrapper });
}

describe('SoapOverviewCard — honest plan-state surface (Zimmelman)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strategyMock.mockResolvedValue(STOP_STRATEGY);
    coverageMock.mockResolvedValue({ data: null } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    computeMock.mockResolvedValue({ aiViabilityState: { status: 'computing' } });
  });

  it('computing → shows "Analyzing the case…" and NOT the misleading "Not supportable as filed" verdict', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'computing' } });
    renderCard();
    await waitFor(() => expect(screen.getByText(/Analyzing the case/i)).toBeInTheDocument());
    expect(screen.queryByText(/Not supportable as filed/i)).not.toBeInTheDocument();
  });

  it('cold none → auto-fires ONE compute and shows the computing surface (no resting verdict, no click-around)', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'none' } });
    renderCard();
    await waitFor(() => expect(computeMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Analyzing the case/i)).toBeInTheDocument();
    expect(screen.queryByText(/Not supportable as filed/i)).not.toBeInTheDocument();
  });

  it('error → shows an honest "couldn’t be completed" + a Retry button, NOT a fake verdict', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'error', error: 'The analysis timed out (the chart is large). Please retry.' } });
    renderCard();
    await waitFor(() => expect(screen.getByText(/couldn’t be completed/i)).toBeInTheDocument());
    expect(screen.getByText(/The analysis timed out/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry analysis/i })).toBeInTheDocument();
    expect(screen.queryByText(/Not supportable as filed/i)).not.toBeInTheDocument();
    // honest framing: the failure is a system issue, not a case finding
    expect(screen.getByText(/has not been assessed/i)).toBeInTheDocument();
  });

  it('error does NOT auto-retry (the RN clicks Retry) — compute is not fired on its own', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'error', error: 'boom. Please retry.' } });
    renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry analysis/i })).toBeInTheDocument());
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('strategy resolved but viability STILL loading → never flashes the resting verdict (adversarial QA window)', async () => {
    // The GET /viability-card is still in flight (large chart) while strategy already resolved. aiState is
    // undefined in this window; the card must NOT fall through to the deterministic "Not supportable as filed"
    // (a sub-second flash of the exact misleading no-go). It should show the honest computing surface instead.
    viabilityMock.mockReturnValue(new Promise<never>(() => {})); // never resolves → viabilityQ stays loading
    renderCard();
    await waitFor(() => expect(screen.getByText(/Analyzing the case/i)).toBeInTheDocument());
    expect(screen.queryByText(/Not supportable as filed/i)).not.toBeInTheDocument();
    expect(computeMock).not.toHaveBeenCalled(); // no plan status yet → nothing to auto-fire
  });

  it('Retry on error → transitions to the computing spinner (NOT stuck on error) — async-trigger fix 2026-06-22', async () => {
    // The /compute endpoint now FIRES the long async recompute and returns {status:'computing'}. Clicking
    // Retry must move the card off the error surface into the spinner (then it polls the GET for ready/error).
    // While the compute mutation is pending, planComputing is true → the spinner shows; it must not stay stuck.
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'error', error: 'The analysis timed out. Please retry.' } });
    // make the compute mutation stay pending so we can observe the spinner deterministically
    computeMock.mockReturnValue(new Promise(() => {}) as unknown as ReturnType<typeof computeCaseViability>);
    renderCard();
    const retry = await screen.findByRole('button', { name: /Retry analysis/i });
    fireEvent.click(retry);
    // compute.isPending → planComputing true → spinner, not the stuck error surface
    await waitFor(() => expect(screen.getByText(/Analyzing the case/i)).toBeInTheDocument());
    expect(screen.queryByText(/couldn’t be completed/i)).not.toBeInTheDocument();
    expect(computeMock).toHaveBeenCalledTimes(1);
  });

  it('off (flag disabled) → falls through to the normal deterministic render (no spinner, no error surface)', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    renderCard();
    // the deterministic verdict is the intended behavior when the AI brain is off (appears as the chip + headline)
    await waitFor(() => expect(screen.getAllByText(/Not supportable as filed/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Analyzing the case/i)).not.toBeInTheDocument();
    expect(computeMock).not.toHaveBeenCalled(); // off → no compute fired
  });

  // CHART-ANALYSIS INCOMPLETE → prominent banner + PROVISIONAL verdict (Ryan 2026-06-23). When the chart the
  // verdict is built on was not fully analyzed, the card must warn loudly and render the verdict as provisional
  // — never a confident "not supportable" on an empty/partial chart.
  it('chart analysis incomplete → prominent banner names the cause file + verdict is marked PROVISIONAL', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } }); // reach the resting render
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 2776, extractedPages: 2776, coveragePct: 100, gaps: [], status: 'complete_with_gaps',
        unknownPageFiles: 0, totalFiles: 4, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 2776, totalUnits: 2776, approximate: false, label: '100% (2776 of 2776)' },
        chartAnalysis: {
          state: 'incomplete',
          label: '⚠ Chart analysis didn’t finish — retry',
          reason: 'The chart analysis was interrupted before it finished, so the structured chart may be missing records.',
          likelyCauseFile: 'VA Blue Button Records.pdf',
          findings: null,
          minorGap: false,
        },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    // Prominent banner with plain language + the named likely-cause file.
    await waitFor(() => expect(screen.getByText(/Chart analysis incomplete/i)).toBeInTheDocument());
    expect(screen.getByText(/VA Blue Button Records\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/may be based on an incomplete chart/i)).toBeInTheDocument();
    // The verdict reads PROVISIONAL, not as a confident conclusion.
    expect(screen.getAllByText(/provisional/i).length).toBeGreaterThan(0);
  });

  it('chart analysis FAILED → directional verdict TEXT suppressed (no "Not supportable"), shows re-run banner', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 100, extractedPages: 100, coveragePct: 100, gaps: [], status: 'failed',
        unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 100, totalUnits: 100, approximate: false, label: '100% (100 of 100)' },
        chartAnalysis: { state: 'failed', label: '✗ Chart analysis failed — re-run extraction', reason: 'The chart analysis errored out, so no structured chart was built.', likelyCauseFile: 'VA Blue Button Records.pdf', findings: null, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Chart analysis incomplete/i)).toBeInTheDocument());
    // The directional "Not supportable as filed" verdict text must NOT be rendered on a failed (empty) chart.
    expect(screen.queryByText(/Not supportable as filed/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/re-run/i).length).toBeGreaterThan(0);
  });

  it('a whole MISSING FILE (unread gap) → prominent banner + provisional, even if Stage-2 said complete', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 50, extractedPages: 40, coveragePct: 80, status: 'complete_with_gaps',
        unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null,
        gaps: [{ documentId: 'D2', fileName: 'Private records.pdf', reason: 'unread', pageLabel: '10 pages', isImage: false, terminalStatus: 'manual_summary_required' }],
        pagesRead: { pct: 80, readUnits: 40, totalUnits: 50, approximate: false, label: '80% (40 of 50)' },
        chartAnalysis: { state: 'complete', label: '✓ Complete', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Chart analysis incomplete/i)).toBeInTheDocument());
    expect(screen.getAllByText(/provisional/i).length).toBeGreaterThan(0);
  });

  it('chart analysis complete → NO incomplete banner, verdict is not marked provisional', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 40, extractedPages: 40, coveragePct: 100, gaps: [], status: 'complete',
        unknownPageFiles: 0, totalFiles: 3, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 40, totalUnits: 40, approximate: false, label: '100% (40 of 40)' },
        chartAnalysis: { state: 'complete', label: '✓ Complete (253 findings)', reason: null, likelyCauseFile: null, findings: 253, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    await waitFor(() => expect(screen.getAllByText(/Not supportable as filed/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Chart analysis incomplete/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provisional/i)).not.toBeInTheDocument();
  });

  it('NEAR-COMPLETE (minorGap, Fitton): completed ≥90% with a few uncovered pages → NO red banner, NOT provisional, but a SOFT caution is shown', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 3029, extractedPages: 3013, coveragePct: 99, status: 'complete_with_gaps',
        unknownPageFiles: 0, totalFiles: 5, pageBreakdown: null,
        gaps: [{ documentId: null, fileName: 'Chart extraction', reason: 'extraction_gap', pageLabel: '16 pages', isImage: false, terminalStatus: null }],
        pagesRead: { pct: 99, readUnits: 3013, totalUnits: 3029, approximate: false, label: '99% (3013 of 3029)' },
        chartAnalysis: { state: 'complete', label: '✓ Mostly complete (522 findings) — 99% analyzed', reason: '16 pages were not folded into the chart (99% of 3029 pages analyzed). The chart is nearly complete; review the records directly if the claim hinges on a specific document.', likelyCauseFile: 'Fitton_Migraine_Misc_5.pdf', findings: 522, minorGap: true },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    // The SOFT caution renders (the near-complete note)…
    await waitFor(() => expect(screen.getByText(/nearly complete/i)).toBeInTheDocument());
    // …but the LOUD red "incomplete" banner and the "(provisional)" verdict marker do NOT.
    expect(screen.queryByText(/Chart analysis incomplete/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provisional/i)).not.toBeInTheDocument();
  });
});

// ── CHART-ANALYSIS-IN-PROGRESS GATE (redesign, Dr. Kasky 2026-06-30) ──────────────────────────────────────
// SUPERSEDES the Marcus Bennett "show the provisional note + auto-refresh-swap" behavior. The owner's directive:
// "No color until it's drafted and complete. DON'T EVEN SHOW the tentative stuff — just say 'still analyzing'."
// While the chart is genuinely still being analyzed, the card must render ONE neutral placeholder — no colored
// chip, no SOAP body, no provisional prose — and only render the final read once analysis is COMPLETE (the flip
// at its source: the tentative read that flipped amber→green / appeared to lose data / disagreed with the plan
// is never surfaced). The background poll/precompute still runs; it just isn't shown until complete.
// (Own describe so its getSoapNote mockImplementation can't leak into the honest-surface tests above.)
describe('SoapOverviewCard — chart-analysis-in-progress gate (redesign, Dr. Kasky 2026-06-30)', () => {
  const soapMock = vi.mocked(getSoapNote);
  const FINAL_NOTE = { subjective: 'S2', objective: 'O2', assessment: 'AHI 28 — the diagnosis is fully documented', plan: 'Draft the nexus letter', confidence: 'high', action: 'draft', fallback: false };
  const PROVISIONAL_NOTE = { subjective: 'S', objective: 'O', assessment: 'the content of those opinions is not fully extracted in the available pages', plan: 'P', confidence: 'low', action: 'get_records', fallback: false };
  const READY_STRATEGY = {
    data: { tier: 'Plausible', primaryArgument: 'OSA secondary to rhinitis', proposedMechanism: null, recommendedPathway: null, inputSet: { scConditions: [], activeProblems: [], keyFacts: [], medications: [] } },
  } as unknown as Awaited<ReturnType<typeof getStrategyPreview>>;

  beforeEach(() => {
    vi.clearAllMocks();
    strategyMock.mockResolvedValue(READY_STRATEGY);
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    computeMock.mockResolvedValue({ aiViabilityState: { status: 'off' } });
    soapMock.mockReset();
  });

  it('chart in_progress → shows the neutral "still analyzing" placeholder and NEVER the tentative read (no provisional prose, no colored chip)', async () => {
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 80, extractedPages: 40, coveragePct: 50, gaps: [], status: 'in_progress',
        unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null,
        pagesRead: { pct: 50, readUnits: 40, totalUnits: 80, approximate: false, label: '50% (40 of 80)' },
        chartAnalysis: { state: 'in_progress', label: 'Analyzing…', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    // Even if the backend would serve a real (fallback:false) provisional note built mid-analysis, the card must
    // NOT surface it — the placeholder wins until the chart is complete.
    soapMock.mockImplementation(async (_id: string, _ctx: unknown, opts?: { forceRegenerate?: boolean; pollOnly?: boolean }) =>
      (opts?.pollOnly === true
        ? { data: FINAL_NOTE, generating: false, grounded: true }
        : { data: PROVISIONAL_NOTE, grounded: true }) as unknown as Awaited<ReturnType<typeof getSoapNote>>);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Still analyzing the chart/i)).toBeInTheDocument());
    expect(screen.getByText(/keeps running in the background/i)).toBeInTheDocument();
    // The tentative provisional read is NEVER shown while analyzing (bug 2 — "data lost" flip).
    expect(screen.queryByText(/not fully extracted in the available pages/i)).not.toBeInTheDocument();
    // NO colored go/no-go chip while analyzing (bugs 1 + 3 — amber→green flip / chip-vs-plan disagreement).
    expect(screen.queryByText(/Ready to draft/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Records needed/i)).not.toBeInTheDocument();
  });

  it('chart complete + a real non-fallback note → shows the final note (no placeholder) and does NOT poll (no needless pollOnly churn)', async () => {
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 40, extractedPages: 40, coveragePct: 100, gaps: [], status: 'complete',
        unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 40, totalUnits: 40, approximate: false, label: '100% (40 of 40)' },
        chartAnalysis: { state: 'complete', label: '✓ Complete', reason: null, likelyCauseFile: null, findings: 40, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    soapMock.mockImplementation(async () => ({ data: FINAL_NOTE, grounded: true }) as unknown as Awaited<ReturnType<typeof getSoapNote>>);
    renderCard();
    await waitFor(() => expect(screen.getByText(/the diagnosis is fully documented/i)).toBeInTheDocument());
    // Final read is shown ONCE the chart is complete — the placeholder is gone and the colored chip appears.
    expect(screen.queryByText(/Still analyzing the chart/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Ready to draft/i)).toBeInTheDocument(); // green chip, projected from the persisted note action
    expect(soapMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ pollOnly: true }));
  });

  // EDGE CASES — the gate must fire ONLY for genuine in_progress, never strand a manual/failed case on "analyzing".
  it('not_analyzed (manual / no-extraction case, totalFiles 0) → shows the FINAL read immediately, never the placeholder', async () => {
    strategyMock.mockResolvedValue(STOP_STRATEGY); // deterministic "Not supportable as filed"
    soapMock.mockImplementation(async () => ({ data: null, grounded: false }) as unknown as Awaited<ReturnType<typeof getSoapNote>>);
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 0, extractedPages: 0, coveragePct: 100, gaps: [], status: 'complete',
        unknownPageFiles: 0, totalFiles: 0, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 0, totalUnits: 0, approximate: false, label: '0 files' },
        chartAnalysis: { state: 'not_analyzed', label: 'Not analyzed yet', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    await waitFor(() => expect(screen.getAllByText(/Not supportable as filed/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Still analyzing the chart/i)).not.toBeInTheDocument();
  });

  it('failed → shows the honest failed banner (re-run), never the "still analyzing" placeholder', async () => {
    strategyMock.mockResolvedValue(STOP_STRATEGY);
    soapMock.mockImplementation(async () => ({ data: null, grounded: false }) as unknown as Awaited<ReturnType<typeof getSoapNote>>);
    coverageMock.mockResolvedValue({
      data: {
        totalPages: 100, extractedPages: 100, coveragePct: 100, gaps: [], status: 'failed',
        unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null,
        pagesRead: { pct: 100, readUnits: 100, totalUnits: 100, approximate: false, label: '100% (100 of 100)' },
        chartAnalysis: { state: 'failed', label: '✗ Chart analysis failed — re-run extraction', reason: 'The chart analysis errored out, so no structured chart was built.', likelyCauseFile: 'VA Blue Button Records.pdf', findings: null, minorGap: false },
      },
    } as unknown as Awaited<ReturnType<typeof getExtractionCoverage>>);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Chart analysis incomplete/i)).toBeInTheDocument());
    expect(screen.queryByText(/Still analyzing the chart/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/re-run/i).length).toBeGreaterThan(0);
  });
});
