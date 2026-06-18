// CaseViabilityCard — BAND-LEAK / OVER-CALL GUARD render (2026-06-18). When the resolver's
// recommended_action routes an UNREVIEWED (physician_reviewed:false) mechanism to physician review,
// the card must NOT headline a green "Strong" — it shows "Candidate — physician review" + a
// "Not yet physician-reviewed" badge with the resolver's reason. A physician-reviewed anchor with a
// proceed action keeps the normal band headline. Consumes recommended_action — never re-derives it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CaseViabilityCard } from '../components/CaseViabilityCard';
import { getCaseViability, type CaseViability, type ViabilityBestAnchor } from '../api/case-viability';

vi.mock('../api/case-viability', async () => {
  const actual = await vi.importActual<typeof import('../api/case-viability')>('../api/case-viability');
  return { ...actual, getCaseViability: vi.fn() };
});
const mock = vi.mocked(getCaseViability);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function anchor(over: Partial<ViabilityBestAnchor>): ViabilityBestAnchor {
  return {
    upstream_canonical: 'PTSD',
    upstream_verbatim: 'PTSD',
    M_static: 3,
    M_eff: 3,
    E: null,
    tier: 'conditional',
    basis: '3.310b',
    is_granted_sc: true,
    mechanism_class: null,
    requires: null,
    ...over,
  };
}

function viability(over: Partial<CaseViability>): CaseViability {
  return {
    version: 1,
    claimed_canonical: 'Multiple sclerosis',
    viability: 'strong',
    best_anchor: anchor({}),
    alternatives: [],
    why: 'PTSD anchors the claimed condition.',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: [],
    confidence: 'high',
    mode: 'chart_refined',
    table_version: null,
    table_content_hash: null,
    ...over,
  };
}

describe('CaseViabilityCard over-call guard (band-leak)', () => {
  it('UNREVIEWED + escalate→physician: refuses the green "Strong" headline, shows the candidate badge', async () => {
    mock.mockResolvedValue({
      data: viability({
        viability: 'strong',
        best_anchor: anchor({ physician_reviewed: false }),
        recommended_action: {
          action: 'escalate',
          route: 'physician',
          band: 'strong',
          reason: 'Mechanism not yet physician-reviewed — confirm before drafting.',
        },
      }),
    });
    render(<CaseViabilityCard caseId="c-overcall" />, { wrapper });
    // The headline is downgraded — no green "Strong".
    expect(await screen.findByText('Candidate — physician review')).toBeInTheDocument();
    expect(screen.queryByText('Strong')).not.toBeInTheDocument();
    // The badge surfaces the resolver's reason verbatim.
    expect(screen.getByText('Not yet physician-reviewed.')).toBeInTheDocument();
    expect(screen.getByText(/confirm before drafting/)).toBeInTheDocument();
  });

  it('REVIEWED + proceed action: keeps the normal band headline, no candidate badge', async () => {
    mock.mockResolvedValue({
      data: viability({
        viability: 'strong',
        best_anchor: anchor({ physician_reviewed: true, basis: '3.310a' }),
        recommended_action: { action: 'auto_run', route: null, band: 'strong', reason: 'Dominant recognized pathway — proceed.' },
      }),
    });
    render(<CaseViabilityCard caseId="c-reviewed" />, { wrapper });
    expect(await screen.findByText('Strong')).toBeInTheDocument();
    expect(screen.queryByText('Candidate — physician review')).not.toBeInTheDocument();
    expect(screen.queryByText('Not yet physician-reviewed.')).not.toBeInTheDocument();
  });

  it('fail-open: no recommended_action → legacy band headline (never blocks the surface)', async () => {
    mock.mockResolvedValue({
      data: viability({ viability: 'strong', best_anchor: anchor({ physician_reviewed: false }) }),
    });
    render(<CaseViabilityCard caseId="c-failopen" />, { wrapper });
    // Without the policy signal the card cannot know — it falls back to the band chip (legacy behavior).
    expect(await screen.findByText('Strong')).toBeInTheDocument();
    expect(screen.queryByText('Candidate — physician review')).not.toBeInTheDocument();
  });
});
