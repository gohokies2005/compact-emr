// SoapOverviewCard — route-picker plan RELIABILITY surface (Ryan 2026-06-21, Zimmelman). Pins the fix for
// the misleading resting verdict: when the route-picker plan (the SAME brain the drafter uses) is the
// intended brain but is NOT ready, the card must show an HONEST surface — a "Analyzing the case…" spinner
// while computing, or an "analysis couldn’t be completed" + Retry on a genuine failure — and must NEVER
// render the resting "Not supportable as filed" deterministic verdict (which misleads "it won't get drafted").
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('off (flag disabled) → falls through to the normal deterministic render (no spinner, no error surface)', async () => {
    viabilityMock.mockResolvedValue({ data: null, aiViabilityState: { status: 'off' } });
    renderCard();
    // the deterministic verdict is the intended behavior when the AI brain is off (appears as the chip + headline)
    await waitFor(() => expect(screen.getAllByText(/Not supportable as filed/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Analyzing the case/i)).not.toBeInTheDocument();
    expect(computeMock).not.toHaveBeenCalled(); // off → no compute fired
  });
});
