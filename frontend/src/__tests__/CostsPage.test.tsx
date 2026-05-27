import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CostsPage } from '../routes/CostsPage';

const getCostReport = vi.fn(async () => ({
  rows: [
    { caseId: 'CASE-1', veteranName: 'John Doe', claimedCondition: 'Obstructive Sleep Apnea', status: 'physician_review', draftCount: 2, costUsd: 5.0 },
    { caseId: 'CASE-2', veteranName: 'Jane Smith', claimedCondition: 'Tinnitus', status: 'drafting', draftCount: 1, costUsd: 2.5 },
  ],
  totalCostUsd: 7.5,
  from: '2026-03-01',
  to: '2026-05-26',
}));
const fetchCostCsv = vi.fn(async () => {});

vi.mock('../api/reports', () => ({
  getCostReport: () => getCostReport(),
  fetchCostCsv: () => fetchCostCsv(),
  costReportCsvUrl: () => '/api/v1/reports/costs.csv',
}));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><CostsPage /></MemoryRouter></QueryClientProvider>);
}

describe('CostsPage', () => {
  it('renders per-case rows and the grand total', async () => {
    renderPage();
    expect(await screen.findByText('CASE-1')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('Obstructive Sleep Apnea')).toBeInTheDocument();
    expect(screen.getByText('$5.00')).toBeInTheDocument();
    expect(screen.getByText('CASE-2')).toBeInTheDocument();
    // Total row.
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$7.50')).toBeInTheDocument();
  });

  it('triggers a CSV download when Export CSV is clicked', async () => {
    renderPage();
    await screen.findByText('CASE-1');
    const exportBtn = screen.getByRole('button', { name: /export csv/i });
    await userEvent.click(exportBtn);
    expect(fetchCostCsv).toHaveBeenCalled();
  });
});
