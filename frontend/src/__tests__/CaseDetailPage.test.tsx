import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseDetailPage } from '../routes/cases/CaseDetailPage';
import { getCase } from '../api/cases';
import { getLetter } from '../api/letter';

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
// The letter-open path (View letter -> GET /cases/:id/letter) — mocked so the dead-end-fix tests
// can drive a structured 404 through describeApiError without a network.
vi.mock('../api/letter', () => ({ getLetter: vi.fn() }));
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
    // The 'delivered' enum displays as "Ready for delivery" (post-approve, pre-payment).
    expect(screen.getByRole('button', { name: /move to ready for delivery/i })).toBeInTheDocument();
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

// ── CLM-BBFCB3F8CE letter-open dead-end fixes (2026-06-11) ──────────────────

// A real AxiosError so describeApiError takes its axios branch (mirrors client.test.ts).
function axiosErrorWith(status: number, serverMessage: string): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_RESPONSE');
  err.response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { error: { code: 'not_found', message: serverMessage } },
  };
  return err;
}

function mockCaseWithJob(artifactPdfS3Key: string) {
  (getCase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Hypertension', claimType: 'initial',
    // 'drafting' (not physician_review) so the header's View letter button is the open path under test.
    status: 'drafting', cdsVerdict: 'not_yet_run', refundEligible: false, currentVersion: 1,
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: '', inServiceEvent: '',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), version: 2,
    veteran: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com' }, assignedPhysician: null,
    documents: [], corrections: [], emails: [], payments: [],
    draftJobs: [{ id: 'DJ-1', caseId: 'CASE-1', state: 'done', version: 1, artifactPdfS3Key, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' }],
  } });
}

describe('CaseDetailPage — letter viewing (CLM-BBFCB3F8CE)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('treats a job whose PDF field holds a non-.pdf key (Seam-B .txt corruption) as NOT viewable', async () => {
    mockCaseWithJob('drafter-artifacts/CASE-1/v1/v1.txt');
    renderPage();
    await screen.findByText('Hypertension');
    // No View letter button — clicking it could only dead-end (the PDF artifact cannot exist).
    expect(screen.queryByRole('button', { name: 'View letter' })).not.toBeInTheDocument();
  });

  it('letter-open failure surfaces the server reason verbatim (describeApiError), not a bare generic', async () => {
    mockCaseWithJob('drafter-artifacts/CASE-1/v1/v1.pdf');
    const missingMsg = 'Letter artifact missing from storage for v1 — the draft run that created this version never uploaded its files. Re-draft to produce a new letter.';
    (getLetter as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(axiosErrorWith(404, missingMsg));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderPage();

    // A sane .pdf key keeps the job viewable — the button renders (control for the test above).
    const viewButton = await screen.findByRole('button', { name: 'View letter' });
    await userEvent.click(viewButton);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const alerted = String(alertSpy.mock.calls[0]?.[0]);
    expect(alerted).toContain(`server returned 404: ${missingMsg}`);
    expect(alerted).not.toBe('Could not open the letter PDF. If it keeps failing, flag this case to Dr. Ryan.');
  });
});
