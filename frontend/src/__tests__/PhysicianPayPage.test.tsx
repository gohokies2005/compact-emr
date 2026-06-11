/**
 * Track-pay page tests (plan §7 frontend block): month dropdown, the 4-column table, the
 * expected-check total row, month switching, and the $0/EmptyState month (matrix Z). The
 * earnings MATH is server-side and matrix-tested in the backend; this suite proves rendering.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianPayPage } from '../routes/physician/PhysicianPayPage';
import { getMyPay, getMyPayMonths } from '../api/pay';
import type { PayReport } from '../api/pay';

vi.mock('../api/pay', async () => {
  const actual = await vi.importActual<typeof import('../api/pay')>('../api/pay');
  return { ...actual, getMyPay: vi.fn(), getMyPayMonths: vi.fn() };
});

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const getMyPayMock = vi.mocked(getMyPay);
const getMyPayMonthsMock = vi.mocked(getMyPayMonths);

const MONTHS = ['2026-06', '2026-05', '2026-04'] as const;

function report(over: Partial<PayReport> = {}): PayReport {
  return {
    month: '2026-06',
    rows: [
      { caseId: 'CASE-1', veteranName: 'Robert Testcase', condition: 'Lumbosacral strain', letterType: 'nexus_letter', payCents: 10000, payUsd: 100, monthPT: '2026-06', firstApprovedAt: '2026-06-05T20:00:00.000Z' },
      { caseId: 'CASE-1', veteranName: 'Robert Testcase', condition: 'Lumbosacral strain', letterType: 'nexus_memo', payCents: 5000, payUsd: 50, monthPT: '2026-06', firstApprovedAt: '2026-06-08T20:00:00.000Z' },
    ],
    totalCents: 15000,
    totalUsd: 150,
    availableMonths: [...MONTHS],
    ...over,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PhysicianPayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMyPayMonthsMock.mockResolvedValue([...MONTHS]);
  getMyPayMock.mockImplementation(async (month: string) =>
    month === 'all' ? report({ month: 'all' }) : report({ month }),
  );
});

describe('PhysicianPayPage', () => {
  it('renders the month dropdown with All + every employment month', async () => {
    renderPage();
    const select = await screen.findByLabelText('Pay month');
    // The months query resolves async; until then the page shows the current-month fallback.
    await screen.findByRole('option', { name: 'April 2026' });
    const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toEqual(['All', 'June 2026', 'May 2026', 'April 2026']);
  });

  it('renders the 4-column table (VETERAN NAME | CONDITION | LETTER TYPE | PAY) with friendly type labels and cents-derived money', async () => {
    renderPage();
    expect(await screen.findByText('Veteran name')).toBeInTheDocument();
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('Letter type')).toBeInTheDocument();
    expect(screen.getByText('Pay')).toBeInTheDocument();
    // F-shape: memo + letter on the same claim renders as TWO rows, $100 + $50.
    expect(screen.getAllByText('Robert Testcase')).toHaveLength(2);
    expect(screen.getByText('Nexus letter')).toBeInTheDocument();
    expect(screen.getByText('Nexus memo')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
  });

  it('total row is the expected check for the selected month ($150.00 = $100 + $50)', async () => {
    renderPage();
    expect(await screen.findByText(/^Expected check \(/)).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
  });

  it('switching the month refetches that month; selecting All shows the career total', async () => {
    renderPage();
    const select = await screen.findByLabelText('Pay month');
    // Wait for the months query to populate the dropdown before selecting a non-current month.
    await screen.findByRole('option', { name: 'April 2026' });
    await userEvent.selectOptions(select, '2026-04');
    await waitFor(() => expect(getMyPayMock).toHaveBeenCalledWith('2026-04'));
    expect(await screen.findByText('Expected check (April 2026)')).toBeInTheDocument();

    await userEvent.selectOptions(select, 'all');
    await waitFor(() => expect(getMyPayMock).toHaveBeenCalledWith('all'));
    expect(await screen.findByText('Career total')).toBeInTheDocument();
  });

  it('Z: an empty month renders the table head + a $0.00 total + an EmptyState — never a blank screen', async () => {
    getMyPayMock.mockResolvedValue(report({ rows: [], totalCents: 0, totalUsd: 0 }));
    renderPage();
    expect(await screen.findByText('No completed letters')).toBeInTheDocument();
    expect(screen.getByText(/No completed letters in /)).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument(); // the expected check still renders, at $0
    expect(screen.getByText('Veteran name')).toBeInTheDocument(); // table head still present
  });
});
