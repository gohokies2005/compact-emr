import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CaseDetailPage } from '../routes/cases/CaseDetailPage';

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 's', email: 'a@x.com', roles: ['admin'], role: 'admin' } }) }));
vi.mock('../api/cases', () => ({
  getCase: vi.fn(async () => ({ data: {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Hypertension', claimType: 'initial',
    status: 'physician_review', cdsVerdict: 'not_yet_run', refundEligible: false, currentVersion: 1,
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: '', inServiceEvent: '',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), version: 2,
    veteran: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com' }, assignedPhysician: null,
    documents: [], draftJobs: [], corrections: [], emails: [], payments: [],
  } })),
  patchCase: vi.fn(), transitionCaseStatus: vi.fn(), deleteCase: vi.fn(),
  listDraftJobs: vi.fn(async () => ({ data: [] })), listCorrections: vi.fn(async () => ({ data: [] })),
  listClarifications: vi.fn(async () => ({ data: [] })),
}));
// Clinical tabs fetch the veteran detail; Staff Notes lists chart notes. Stub both so the case page's
// new chart tabs render without hitting the network.
vi.mock('../api/veterans', () => ({
  getVeteran: vi.fn(async () => ({ data: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com', version: 1, scConditions: [{ id: 'SC-1', condition: 'PTSD', status: 'service_connected', version: 1 }], activeProblems: [], activeMedications: [], cases: [] } })),
  listDocuments: vi.fn(async () => ({ data: [] })),
  reocrDocument: vi.fn(),
  // Mutation fns the shared clinical panels import (add/edit/delete).
  addScCondition: vi.fn(), updateScCondition: vi.fn(), deleteScCondition: vi.fn(),
  addProblem: vi.fn(), deleteProblem: vi.fn(),
  addMedication: vi.fn(), deleteMedication: vi.fn(),
}));
vi.mock('../api/chart-notes', () => ({
  listChartNotes: vi.fn(async () => ({ data: [] })),
  createChartNote: vi.fn(), deleteChartNote: vi.fn(), patchChartNote: vi.fn(),
}));
// ConditionSelect (inside ConditionsPanel/ProblemsPanel) loads the CDS condition catalog — stub it
// so the panel renders without a live network query.
vi.mock('../api/lookup', () => ({ getConditions: vi.fn(async () => ({ groups: [] })) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/cases/CASE-1']}>
        <Routes>
          <Route path="/cases/:id" element={<CaseDetailPage />} />
          <Route path="/veterans/:id" element={<div>VETERAN CHART for {/* param shown below */}VET-1</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CaseDetailPage', () => {
  it('renders the case header and admin transition controls', async () => {
    renderPage();
    expect(await screen.findByText('Hypertension')).toBeInTheDocument();
    expect(screen.getByText('Physician review')).toBeInTheDocument(); // status badge
    // From physician_review, an admin may move to delivered / correction_requested / rejected.
    expect(screen.getByRole('button', { name: /move to delivered/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject \+ soft delete/i })).toBeInTheDocument();
  });

  it('exposes the veteran clinical chart tabs on the case page', async () => {
    renderPage();
    await screen.findByText('Hypertension');
    // The four clinical tabs mirror the veteran chart page.
    expect(screen.getByRole('tab', { name: 'Service Connected Conditions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Active Problems' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Medications' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Staff Notes' })).toBeInTheDocument();
    // Clicking the SC Conditions tab mounts the shared ConditionsPanel and shows the veteran's data.
    await userEvent.click(screen.getByRole('tab', { name: 'Service Connected Conditions' }));
    expect(await screen.findByText('PTSD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('links the veteran name in the header to the veteran chart route', async () => {
    renderPage();
    const nameLink = await screen.findByRole('link', { name: /Doe, Jane/i });
    expect(nameLink).toHaveAttribute('href', '/veterans/VET-1');
    await userEvent.click(nameLink);
    expect(await screen.findByText(/VETERAN CHART for/i)).toBeInTheDocument();
  });
});
