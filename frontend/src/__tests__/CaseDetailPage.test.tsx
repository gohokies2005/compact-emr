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
import { presignDocument, recordDocument } from '../api/veterans';
import type { Role } from '../types/prisma';

// Mutable role (TopNav.test pattern) — the P2 banner tests flip between admin and ops_staff.
let mockRole: Role = 'admin';
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 's', email: 'a@x.com', roles: [mockRole], role: mockRole } }) }));
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
  // Upload fns the shared DocumentUploadPanel imports (Keystone Package 3: case-page upload).
  presignDocument: vi.fn(async () => ({ data: { uploadUrl: 'https://s3.test/upload', requiredHeaders: {}, s3Key: 'cases/CASE-1/uuid-a.pdf' } })),
  uploadToPresignedUrl: vi.fn(async () => undefined),
  recordDocument: vi.fn(async () => ({ data: { id: 'DOC-1' } })),
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

  // UI sweep P2 (Ryan item 12): the claim-page tab order is locked, Clarifications is gone (tab +
  // panel mount removed; the panel component, api client, and backend route all remain), and the
  // shared TabBar is sticky so the bar survives a long-panel scroll.
  it('locks the claim tab order, drops Clarifications, and renders a sticky tab bar', async () => {
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview', 'Draft jobs', 'Staff Notes', 'Email', 'Messages',
      'Documents', 'Service Connected Conditions', 'Active Problems', 'Medications',
    ]);
    expect(screen.queryByRole('tab', { name: /clarifications/i })).not.toBeInTheDocument();
    // Sticky = class assertion (P2a): pinned to the scroll parent, opaque, above panel content.
    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('sticky');
    expect(tablist.className).toContain('top-0');
    expect(tablist.className).toContain('z-10');
    expect(tablist.className).toContain('bg-ivory');
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

  // Keystone Package 3 — the Documents tab mounts the shared uploader with THIS case pre-pinned:
  // no claim dropdown, and the presign/record calls carry the page's own caseId. The chart link
  // ("Manage all veteran documents") stays as the secondary path.
  it('Documents tab uploads with the caseId pre-pinned (no claim dropdown) and keeps the chart link', async () => {
    renderPage();
    await screen.findByText('Hypertension');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));

    expect(await screen.findByText('Upload to this claim')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assign to claim')).not.toBeInTheDocument(); // pinned → no dropdown
    expect(screen.getByRole('link', { name: /manage all veteran documents/i })).toHaveAttribute('href', '/veterans/VET-1#documents');

    await userEvent.upload(screen.getByLabelText('Upload documents'), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(presignDocument).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'CASE-1', filename: 'a.pdf' })));
    await waitFor(() => expect(recordDocument).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'CASE-1', s3Key: 'cases/CASE-1/uuid-a.pdf' })));
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

// ── UI sweep P2 banners (2026-06-11): per-chart refund strip + Pryor physician-queue notice ──

function mockCase(overrides: Record<string, unknown> = {}) {
  (getCase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Hypertension', claimType: 'initial',
    status: 'physician_review', cdsVerdict: 'not_yet_run', refundEligible: false, currentVersion: 1,
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: '', inServiceEvent: '',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), version: 2,
    veteran: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com' }, assignedPhysician: null,
    documents: [], draftJobs: [], corrections: [], emails: [], payments: [],
    ...overrides,
  } });
}

describe('CaseDetailPage — refund banner (P2c, item 13)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  it('shows the amber refund strip on a refund-eligible case (admin gets the /refunds link)', async () => {
    mockRole = 'admin';
    mockCase({ refundEligible: true });
    renderPage();
    expect(await screen.findByText(/marked refund-eligible/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open refunds/i })).toHaveAttribute('href', '/refunds');
  });

  it('ops_staff sees the refund strip too (the signal survives the nav removal) — without the admin link', async () => {
    mockRole = 'ops_staff';
    mockCase({ refundEligible: true });
    renderPage();
    expect(await screen.findByText(/marked refund-eligible/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open refunds/i })).not.toBeInTheDocument();
  });

  it('self-hides when the case is not refund-eligible', async () => {
    mockRole = 'admin';
    mockCase({ refundEligible: false });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByText(/refund-eligible/i)).not.toBeInTheDocument();
  });
});

describe('CaseDetailPage — physician-queue banner (Pryor 7a)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  const pryor = { id: 'PHY-1', fullName: 'John Pryor, MD', email: 'pryor@x.test' };

  it("ops_staff on a physician_review case sees the queue banner with the doctor's name", async () => {
    mockRole = 'ops_staff';
    mockCase({ assignedPhysician: pryor });
    renderPage();
    expect(await screen.findByText(/in Dr\. Pryor's queue/)).toBeInTheDocument();
    expect(screen.getByText(/any letter save you make is what the doctor will review/i)).toBeInTheDocument();
  });

  it('falls back to "the physician\'s queue" when no physician is assigned', async () => {
    mockRole = 'ops_staff';
    mockCase({ assignedPhysician: null });
    renderPage();
    expect(await screen.findByText(/in the physician's queue/)).toBeInTheDocument();
  });

  it('does NOT render for admin', async () => {
    mockRole = 'admin';
    mockCase({ assignedPhysician: pryor });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByText(/queue — no action is needed/i)).not.toBeInTheDocument();
  });

  it('does NOT render on an rn_review case', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'rn_review', assignedPhysician: pryor });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByText(/queue — no action is needed/i)).not.toBeInTheDocument();
  });
});
