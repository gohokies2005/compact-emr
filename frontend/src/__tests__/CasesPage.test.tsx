import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CasesPage } from '../routes/cases/CasesPage';

vi.mock('../api/cases', () => ({
  listCases: vi.fn(async () => ({
    data: [
      {
        id: 'CASE-001', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea', claimType: 'initial',
        status: 'drafting', version: 3, currentVersion: 2, assignedPhysicianId: null, refundEligible: false,
        createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' }, assignedPhysician: null,
      },
      {
        id: 'CASE-002', veteranId: 'VET-2', claimedCondition: 'Tinnitus', claimType: 'initial',
        status: 'intake', version: 1, currentVersion: 1, assignedPhysicianId: null, refundEligible: false,
        createdAt: '2026-05-02T00:00:00Z', updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        veteran: { id: 'VET-2', firstName: 'Aaron', lastName: 'Adams', email: 'a@example.com' }, assignedPhysician: null,
      },
    ],
    page: 1, pageSize: 25, total: 2,
  })),
}));
vi.mock('../api/veterans', () => ({ listVeterans: vi.fn(async () => ({ data: [] })) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><CasesPage /></MemoryRouter></QueryClientProvider>);
}

describe('CasesPage', () => {
  it('renders filters and a case row with status badge', async () => {
    renderPage();
    expect(screen.getByText('All statuses')).toBeInTheDocument();
    expect(await screen.findByText('CASE-001')).toBeInTheDocument();
    expect(screen.getByText('Young, Matthew')).toBeInTheDocument();
    // The Cases-list status is now a NEUTRAL slate label (Fix 1, "christmas tree" de-color 2026-06-08),
    // NOT the colored CaseStatusBadge. "Drafting" appears in the status filter option AND the row cell —
    // assert the neutral row label specifically (centered slate text, no bg-* fill).
    expect(screen.getAllByText('Drafting').some((el) => el.className.includes('text-slate-600') && !el.className.includes('bg-'))).toBe(true);
    // Records column renders the neutral "Awaiting records" label (mock rows have no recordsUploaded).
    expect(screen.getAllByText('Awaiting records').length).toBeGreaterThan(0);
  });

  it('sorts by a column header: default -> asc -> desc (3-state) with aria-sort + indicator', async () => {
    renderPage();
    await screen.findByText('CASE-001');
    const order = () => screen.getAllByText(/^CASE-00\d$/).map((el) => el.textContent);
    const vetHeader = () => screen.getByRole('button', { name: /Veteran/ });

    // default = server/mock order
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');

    // 1st click = ascending by veteran name (Aaron Adams < Matthew Young)
    fireEvent.click(vetHeader());
    expect(order()).toEqual(['CASE-002', 'CASE-001']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(vetHeader().textContent).toContain('▲');

    // 2nd click = descending
    fireEvent.click(vetHeader());
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(vetHeader().textContent).toContain('▼');

    // 3rd click = back to default
    fireEvent.click(vetHeader());
    expect(vetHeader().closest('th')?.getAttribute('aria-sort')).toBe('none');
    expect(order()).toEqual(['CASE-001', 'CASE-002']);
  });
});
