import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CasesPage } from '../routes/cases/CasesPage';

vi.mock('../api/cases', () => ({
  listCases: vi.fn(async () => ({
    data: [{
      id: 'CASE-001', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimType: 'initial',
      status: 'drafting', version: 3, currentVersion: 2, assignedPhysicianId: null, refundEligible: false,
      createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' }, assignedPhysician: null,
    }],
    page: 1, pageSize: 25, total: 1,
  })),
}));
vi.mock('../api/veterans', () => ({ listVeterans: vi.fn(async () => ({ data: [] })) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

describe('CasesPage', () => {
  it('renders filters and a case row with status badge', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><CasesPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('All statuses')).toBeInTheDocument();
    expect(await screen.findByText('CASE-001')).toBeInTheDocument();
    expect(screen.getByText('Matthew Young')).toBeInTheDocument();
    // "Drafting" appears in the status filter option AND the row badge — assert the badge specifically.
    expect(screen.getAllByText('Drafting').some((el) => el.className.includes('bg-purple-100'))).toBe(true);
  });
});
