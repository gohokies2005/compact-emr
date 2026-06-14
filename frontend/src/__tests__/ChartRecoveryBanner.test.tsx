import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartRecoveryBanner } from '../components/ChartRecoveryBanner';
import { getChartReadiness } from '../api/chart-readiness';
import { postDraft } from '../api/drafter';
import { viewDocument } from '../api/veterans';

vi.mock('../api/chart-readiness', () => ({ getChartReadiness: vi.fn() }));
vi.mock('../api/drafter', () => ({ postDraft: vi.fn() }));
vi.mock('../api/veterans', () => ({ viewDocument: vi.fn() }));

const readinessMock = vi.mocked(getChartReadiness);

// The LAST-RESORT banner must appear ONLY once auto-recovery is EXHAUSTED (FIX 3, 2026-06-14) — NOT
// during a normal preparing/extracting cycle (where it papered over the SendToDrafter auto-resume
// stall and nagged the RN mid-build). It gates on the backend's `autoRecoveryExhausted` flag.
const BLOCKER = { filePath: 'cases/CASE-1/uuid-records.pdf', terminalStatus: 'manual_summary_required' as const };

function renderBanner(props: Partial<ComponentProps<typeof ChartRecoveryBanner>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const result = render(<ChartRecoveryBanner caseId="CASE-1" status="records" canDraft {...props} />, { wrapper: Wrapper });
  return { ...result, queryClient };
}

// Wait until the readiness query has RESOLVED into the cache + React has re-rendered with it. Without
// this, a "banner absent" assertion can pass simply because readiness is still undefined (loading) —
// a false negative that would let the FIX 3 gate-removal slip through. Polling the cache guarantees the
// component evaluated its render condition against REAL data.
async function waitForReadinessSettled(queryClient: QueryClient) {
  await waitFor(() => {
    const cached = queryClient.getQueryData<{ data: unknown }>(['case', 'CASE-1', 'chart-readiness']);
    expect(cached?.data).toBeDefined();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChartRecoveryBanner', () => {
  it('SHOWS the last-resort banner when auto-recovery is EXHAUSTED, pre-draft, settled, with blockers', async () => {
    readinessMock.mockResolvedValue({
      data: { ready: false, extractionState: 'extract_failed', blockingFiles: [BLOCKER], autoRecoveryExhausted: true },
    });
    renderBanner();
    expect(await screen.findByText(/couldn’t be read and needs you/)).toBeInTheDocument();
    // The override escape hatch is offered (canDraft).
    expect(screen.getByRole('button', { name: /Override/ })).toBeInTheDocument();
  });

  it('HIDES the banner while the chart is still PREPARING/extracting (does not nag mid-build)', async () => {
    // Mid-build: extracting + blockers present, but NOT exhausted. The SendToDrafter auto-resume owns
    // this window — the banner must stay hidden so it can't paper over the stall.
    readinessMock.mockResolvedValue({
      data: { ready: false, extractionState: 'extracting', blockingFiles: [BLOCKER], autoRecoveryExhausted: false },
    });
    const { queryClient } = renderBanner();
    await waitForReadinessSettled(queryClient);
    expect(screen.queryByText(/couldn’t be read and needs you/)).not.toBeInTheDocument();
  });

  it('HIDES the banner when settled with blockers but auto-recovery is NOT yet exhausted', async () => {
    // The first auto-remediation hasn't run/finished for this doc-set — showing the human last-resort
    // banner now would be premature (the auto-resume cycle is still the right path). This is THE case
    // that fails without the FIX 3 gate (settled + blockers would have shown the banner).
    readinessMock.mockResolvedValue({
      data: { ready: false, extractionState: 'chart_ready', blockingFiles: [BLOCKER], autoRecoveryExhausted: false },
    });
    const { queryClient } = renderBanner();
    await waitForReadinessSettled(queryClient);
    expect(screen.queryByText(/couldn’t be read and needs you/)).not.toBeInTheDocument();
  });

  it('HIDES the banner when the chart is ready (no blockers)', async () => {
    readinessMock.mockResolvedValue({
      data: { ready: true, extractionState: 'chart_ready', blockingFiles: [], autoRecoveryExhausted: false },
    });
    const { queryClient } = renderBanner();
    await waitForReadinessSettled(queryClient);
    expect(screen.queryByText(/couldn’t be read and needs you/)).not.toBeInTheDocument();
  });

  it('HIDES the banner on a non-pre-draft status even if exhausted', async () => {
    // PRE_DRAFT_STATUSES excludes rn_review — the query is disabled, banner never shows.
    readinessMock.mockResolvedValue({
      data: { ready: false, extractionState: 'extract_failed', blockingFiles: [BLOCKER], autoRecoveryExhausted: true },
    });
    renderBanner({ status: 'rn_review' });
    expect(screen.queryByText(/couldn’t be read and needs you/)).not.toBeInTheDocument();
  });
});

// Silence unused-import lint: postDraft + viewDocument are mocked for module resolution only.
void postDraft;
void viewDocument;
