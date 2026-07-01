// CaseReadinessVerdictCard — the reconciled top-line go/no-go render (2026-06-18, Cluster 3). Verifies
// the headline + next action + disagreements render from the shared signal queries, and that the
// sanity cache-read fires NO extra Opus call (enabled:false). Pure presentation of computeReadinessVerdict.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CaseReadinessVerdictCard } from '../components/CaseReadinessVerdictCard';
import { getStrategyPreview } from '../api/strategy-preview';
import { getCaseViability } from '../api/case-viability';
import { getExtractionCoverage } from '../api/extraction-coverage';
import { getSanityImpression } from '../api/sanity-impression';

vi.mock('../api/strategy-preview', async () => {
  const actual = await vi.importActual<typeof import('../api/strategy-preview')>('../api/strategy-preview');
  return { ...actual, getStrategyPreview: vi.fn() };
});
vi.mock('../api/case-viability', async () => {
  const actual = await vi.importActual<typeof import('../api/case-viability')>('../api/case-viability');
  return { ...actual, getCaseViability: vi.fn() };
});
vi.mock('../api/extraction-coverage', async () => {
  const actual = await vi.importActual<typeof import('../api/extraction-coverage')>('../api/extraction-coverage');
  return { ...actual, getExtractionCoverage: vi.fn() };
});
vi.mock('../api/sanity-impression', async () => {
  const actual = await vi.importActual<typeof import('../api/sanity-impression')>('../api/sanity-impression');
  return { ...actual, getSanityImpression: vi.fn() };
});

const strategyMock = vi.mocked(getStrategyPreview);
const viabilityMock = vi.mocked(getCaseViability);
const coverageMock = vi.mocked(getExtractionCoverage);
const sanityMock = vi.mocked(getSanityImpression);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function primeStrong() {
  strategyMock.mockResolvedValue({ data: { evaluable: true, recommendedPathway: { kind: 'secondary', anchor: null, basis: null, differsFromCurrent: false }, primaryArgument: '', proposedMechanism: null, anchor: null, tier: 'Strong', criteria: [], summary: '' } as any });
  viabilityMock.mockResolvedValue({ data: { version: 1, claimed_canonical: 'OSA', viability: 'strong', best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null, tier: 'blessed', basis: '3.310a', is_granted_sc: true, mechanism_class: null, requires: null, physician_reviewed: true }, alternatives: [], why: '', missing_fact: null, presumptive_redirect: null, graveyard_redirect: null, excluded_traps: [], confidence: 'high', mode: 'chart_refined', table_version: null, table_content_hash: null, recommended_action: { action: 'auto_run', route: null, band: 'strong', reason: 'proceed' } } as any });
  coverageMock.mockResolvedValue({ data: { totalPages: 10, extractedPages: 10, coveragePct: 100, gaps: [], status: 'complete', unknownPageFiles: 0, totalFiles: 1, pageBreakdown: null } as any });
}

describe('CaseReadinessVerdictCard', () => {
  it('renders the reconciled headline + next action; never triggers the sanity Opus call (cache-read only)', async () => {
    primeStrong();
    render(<CaseReadinessVerdictCard caseId="c1" claimedCondition="OSA" hasUnreadPages={false} />, { wrapper });
    expect(await screen.findByText('Ready to draft')).toBeInTheDocument();
    expect(screen.getByText(/Send to the drafter/i)).toBeInTheDocument();
    // The sanity impression is read from cache only (enabled:false) — no fetch fired.
    expect(sanityMock).not.toHaveBeenCalled();
  });

  it('chart analysis in_progress → shows the neutral "still analyzing" placeholder, no colored verdict pill (redesign, Dr. Kasky 2026-06-30)', async () => {
    primeStrong(); // strong strategy/viability that would otherwise render a green "Ready to draft" pill
    coverageMock.mockResolvedValue({ data: { totalPages: 80, extractedPages: 40, coveragePct: 50, gaps: [], status: 'in_progress', unknownPageFiles: 0, totalFiles: 2, pageBreakdown: null, chartAnalysis: { state: 'in_progress', label: 'Analyzing…', reason: null, likelyCauseFile: null, findings: null, minorGap: false } } as any });
    render(<CaseReadinessVerdictCard caseId="c3" claimedCondition="OSA" hasUnreadPages={false} />, { wrapper });
    expect(await screen.findByText(/Still analyzing the chart/i)).toBeInTheDocument();
    // the colored go/no-go verdict must NOT render while the chart is still analyzing
    expect(screen.queryByText('Ready to draft')).not.toBeInTheDocument();
    expect(screen.queryByText(/Send to the drafter/i)).not.toBeInTheDocument();
  });

  it('surfaces an over-call disagreement when the anchor is unreviewed (escalate→physician)', async () => {
    primeStrong();
    viabilityMock.mockResolvedValue({ data: { version: 1, claimed_canonical: 'MS', viability: 'strong', best_anchor: { upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null, tier: 'blessed', basis: '3.310b', is_granted_sc: true, mechanism_class: null, requires: null, physician_reviewed: false }, alternatives: [], why: '', missing_fact: null, presumptive_redirect: null, graveyard_redirect: null, excluded_traps: [], confidence: 'high', mode: 'chart_refined', table_version: null, table_content_hash: null, recommended_action: { action: 'escalate', route: 'physician', band: 'strong', reason: 'Mechanism not yet physician-reviewed.' } } as any });
    render(<CaseReadinessVerdictCard caseId="c2" claimedCondition="MS" hasUnreadPages={false} />, { wrapper });
    expect(await screen.findByText('Draftable — confirm the mechanism')).toBeInTheDocument();
    expect(screen.getByTestId('readiness-disagreements')).toBeInTheDocument();
  });
});
