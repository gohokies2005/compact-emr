// RecommendedPlanCard — renders the one-brain selector output as the Overview "what to do" section.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { RecommendedPlanCard } from '../components/RecommendedPlanCard';
import { getStrategyPreview, type StrategyPreview } from '../api/strategy-preview';
import { getCaseViability, type CaseViability } from '../api/case-viability';

vi.mock('../api/strategy-preview', async () => {
  const actual = await vi.importActual<typeof import('../api/strategy-preview')>('../api/strategy-preview');
  return { ...actual, getStrategyPreview: vi.fn() };
});
vi.mock('../api/case-viability', async () => {
  const actual = await vi.importActual<typeof import('../api/case-viability')>('../api/case-viability');
  return { ...actual, getCaseViability: vi.fn() };
});
const stratMock = vi.mocked(getStrategyPreview);
const viabMock = vi.mocked(getCaseViability);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function strat(over: Partial<StrategyPreview>): StrategyPreview {
  return { evaluable: true, primaryArgument: 'x', proposedMechanism: null, anchor: null, tier: 'Strong', recommendedPathway: { kind: 'direct', anchor: null, basis: null, differsFromCurrent: false }, criteria: [], summary: 'x', ...over } as StrategyPreview;
}
function viab(over: Partial<CaseViability>): CaseViability {
  return { version: 2, claimed_canonical: 'OSA', viability: 'weak', best_anchor: null, alternatives: [], why: 'x', missing_fact: null, presumptive_redirect: null, graveyard_redirect: null, excluded_traps: [], confidence: 'low', mode: 'info_light', table_version: null, table_content_hash: null, ...over } as CaseViability;
}

describe('RecommendedPlanCard', () => {
  it('Strong → "Draft" chip, draft detail, NO email slot', async () => {
    stratMock.mockResolvedValue({ data: strat({ tier: 'Strong' }) });
    viabMock.mockResolvedValue({ data: viab({ viability: 'strong' }) });
    render(<RecommendedPlanCard caseId="c1" />, { wrapper });
    expect(await screen.findByText('Draft')).toBeInTheDocument();
    expect(screen.getByText(/supportable theory is on the record/i)).toBeInTheDocument();
    expect(screen.queryByTestId('recommended-plan-email-slot')).not.toBeInTheDocument();
  });

  it('Stop + bridge → "Contact veteran" chip + alternative detail + email slot', async () => {
    stratMock.mockResolvedValue({ data: strat({ tier: 'Stop' }) });
    viabMock.mockResolvedValue({ data: viab({ bridge_pathways: [{ bridge_provisional: true, physician_review_required: true, exposure: 'burn_pit_airborne', intermediate_dx: 'Chronic rhinosinusitis', intermediate_presumptive_basis: '38 CFR 3.320', claimed: 'OSA', pair_tier: 'conditional', pair_M: 2, suggestion: 'x' }] }) });
    render(<RecommendedPlanCard caseId="c2" />, { wrapper });
    expect(await screen.findByText('Contact veteran')).toBeInTheDocument();
    expect(screen.getByText(/establish Chronic rhinosinusitis first/i)).toBeInTheDocument();
    expect(screen.getByTestId('recommended-plan-email-slot')).toBeInTheDocument();
  });

  it('differsFromCurrent → "Draft — adjust anchor" + the auto-flag note', async () => {
    stratMock.mockResolvedValue({ data: strat({ tier: 'Strong', recommendedPathway: { kind: 'secondary', anchor: 'PTSD', basis: 'x', differsFromCurrent: true } }) });
    viabMock.mockResolvedValue({ data: viab({ viability: 'strong' }) });
    render(<RecommendedPlanCard caseId="c3" />, { wrapper });
    expect(await screen.findByText('Draft — adjust anchor')).toBeInTheDocument();
    expect(screen.getByText(/anchoring on PTSD/i)).toBeInTheDocument();
    expect(screen.getByText(/applied \+ flagged automatically/i)).toBeInTheDocument();
  });
});
