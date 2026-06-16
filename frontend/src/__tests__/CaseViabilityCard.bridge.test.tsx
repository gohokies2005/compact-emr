// CaseViabilityCard — BRIDGE-ANCHOR render (2026-06-16). The provisional two-hop suggestion renders
// as a distinct block: the suggestion string VERBATIM, the intermediate dx, the presumptive basis,
// and a physician-review-required badge. Absent bridge_pathways → no bridge block (dark / no fire).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CaseViabilityCard } from '../components/CaseViabilityCard';
import { getCaseViability, type CaseViability } from '../api/case-viability';

vi.mock('../api/case-viability', async () => {
  const actual = await vi.importActual<typeof import('../api/case-viability')>('../api/case-viability');
  return { ...actual, getCaseViability: vi.fn() };
});
const mock = vi.mocked(getCaseViability);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function viability(over: Partial<CaseViability>): CaseViability {
  return {
    version: 2,
    claimed_canonical: 'Obstructive sleep apnea',
    viability: 'weak',
    best_anchor: null,
    alternatives: [],
    why: 'No service-connected condition currently anchors Obstructive sleep apnea.',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: [],
    confidence: 'low',
    mode: 'info_light',
    table_version: null,
    table_content_hash: null,
    ...over,
  };
}

// Distinct from the dx label so getByText assertions don't double-match.
const SUGGESTION = 'Two-hop pathway flagged. Establish the presumptive intermediate first, then claim secondary. Physician review required before relying on this.';

describe('CaseViabilityCard bridge-anchor render', () => {
  it('renders the suggestion VERBATIM + intermediate dx + basis + physician-review badge when a bridge fires', async () => {
    mock.mockResolvedValue({
      data: viability({
        bridge_pathways: [{
          bridge_provisional: true,
          physician_review_required: true,
          exposure: 'burn_pit_airborne',
          intermediate_dx: 'Chronic rhinosinusitis',
          intermediate_presumptive_basis: '38 CFR 3.320',
          claimed: 'Obstructive sleep apnea',
          pair_tier: 'conditional',
          pair_M: 2,
          suggestion: SUGGESTION,
          provenance: { pact_map_hash: '2098c133', pair_table_hash: 'c0f6ba36' },
        }],
      }),
    });
    render(<CaseViabilityCard caseId="c1" />, { wrapper });
    expect(await screen.findByText(SUGGESTION)).toBeInTheDocument(); // verbatim
    expect(screen.getByText('Chronic rhinosinusitis')).toBeInTheDocument();
    expect(screen.getByText(/38 CFR 3\.320/)).toBeInTheDocument();
    // EXACT match → the badge element only (the suggestion <p> trailing phrase has longer text content).
    expect(screen.getByText('Physician review required')).toBeInTheDocument();
  });

  it('renders NO bridge block when bridge_pathways is absent (dark / no fire)', async () => {
    mock.mockResolvedValue({ data: viability({}) });
    render(<CaseViabilityCard caseId="c2" />, { wrapper });
    expect(await screen.findByText(/No service-connected condition currently anchors/)).toBeInTheDocument();
    expect(screen.queryByText(/bridge pathway/i)).not.toBeInTheDocument();
  });
});
