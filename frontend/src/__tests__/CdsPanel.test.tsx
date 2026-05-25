import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CdsPanel } from '../components/CdsPanel';
import type { CdsResult } from '../api/cases';

const runCdsMock = vi.fn();
vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api/cases');
  return { ...actual, runCds: (id: string) => runCdsMock(id) };
});

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const acceptRationale: CdsResult = {
  verdict: 'accept',
  oddsPct: 89,
  summary: 'Strong BVA support for the PTSD → OSA secondary pathway.',
  hardGate: { triggered: false, rule: null, detail: null },
  bva: {
    matched: true,
    upstream: 'PTSD',
    claimed: 'Obstructive sleep apnea',
    n: 41,
    tier: 'high',
    winPct: 78,
    imoWinPct: 89,
  },
  checkedAt: new Date(Date.now() - 60_000).toISOString(),
  engineVersion: 'cds-v1.0.0',
};

const rejectHardGateRationale: CdsResult = {
  verdict: 'reject',
  oddsPct: null,
  summary: 'Hard gate: no diagnosis on file.',
  hardGate: { triggered: true, rule: 'no_diagnosis_on_file', detail: 'No formal diagnosis present in chart data.' },
  bva: { matched: false, upstream: null, claimed: null, n: null, tier: null, winPct: null, imoWinPct: null },
  checkedAt: new Date(Date.now() - 60_000).toISOString(),
  engineVersion: 'cds-v1.0.0',
};

describe('CdsPanel', () => {
  it('renders not-yet-run state with Run CDS button', () => {
    render(wrap(<CdsPanel caseId="CASE-1" verdict="not_yet_run" />));
    expect(screen.getByText('Clinical Decision Support')).toBeInTheDocument();
    expect(screen.getByText('Not yet run')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run CDS/i })).toBeInTheDocument();
  });

  it('renders an accept verdict with odds and BVA sub-line', () => {
    render(wrap(<CdsPanel caseId="CASE-2" verdict="accept" oddsPct={89} rationale={acceptRationale as unknown as Record<string, unknown>} />));
    expect(screen.getByText('Accept')).toBeInTheDocument();
    expect(screen.getByText('89%')).toBeInTheDocument();
    expect(screen.getByText('IMO win rate')).toBeInTheDocument();
    expect(screen.getByText(/PTSD → Obstructive sleep apnea/)).toBeInTheDocument();
    expect(screen.getByText(/Strong BVA support/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run CDS/i })).toBeInTheDocument();
  });

  it('renders the hard-gate note + recommendation caption on reject', () => {
    render(wrap(<CdsPanel caseId="CASE-3" verdict="reject" rationale={rejectHardGateRationale as unknown as Record<string, unknown>} />));
    expect(screen.getByText('Likely not supportable')).toBeInTheDocument();
    expect(screen.getByText('no_diagnosis_on_file')).toBeInTheDocument();
    expect(screen.getByText(/No formal diagnosis present/)).toBeInTheDocument();
    expect(screen.getByText(/confirm before any veteran-facing action/i)).toBeInTheDocument();
  });

  it('calls runCds and re-runs when Re-run CDS is clicked', async () => {
    runCdsMock.mockResolvedValueOnce({ data: acceptRationale });
    render(wrap(<CdsPanel caseId="CASE-4" verdict="accept" oddsPct={89} rationale={acceptRationale as unknown as Record<string, unknown>} />));
    fireEvent.click(screen.getByRole('button', { name: /Re-run CDS/i }));
    await waitFor(() => expect(runCdsMock).toHaveBeenCalledWith('CASE-4'));
  });
});
