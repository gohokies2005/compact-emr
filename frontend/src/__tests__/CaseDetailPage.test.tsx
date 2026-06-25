import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseDetailPage } from '../routes/cases/CaseDetailPage';
import { archiveCase, getCase, restoreCase } from '../api/cases';
import { getLetter } from '../api/letter';
import { deleteDocument, listDocuments, presignDocument, recordDocument } from '../api/veterans';
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
  archiveCase: vi.fn(async () => undefined), restoreCase: vi.fn(async () => ({ data: {} })),
  listDraftJobs: vi.fn(async () => ({ data: [] })), listCorrections: vi.fn(async () => ({ data: [] })),
}));
// Clinical tabs fetch the veteran detail; Staff Notes lists chart notes. Stub both so the case page's
// new chart tabs render without hitting the network.
vi.mock('../api/veterans', () => ({
  getVeteran: vi.fn(async () => ({ data: { id: 'VET-1', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com', version: 1, scConditions: [{ id: 'SC-1', condition: 'PTSD', status: 'service_connected', version: 1 }], activeProblems: [], activeMedications: [], cases: [] } })),
  listDocuments: vi.fn(async () => ({ data: [] })),
  reocrDocument: vi.fn(),
  deleteDocument: vi.fn(async () => undefined),
  // Mutation fns the shared clinical panels import (add/edit/delete).
  addScCondition: vi.fn(), updateScCondition: vi.fn(), deleteScCondition: vi.fn(),
  addProblem: vi.fn(), deleteProblem: vi.fn(),
  addMedication: vi.fn(), deleteMedication: vi.fn(),
  // Upload fns the shared DocumentUploadPanel imports (Keystone Package 3: case-page upload).
  presignDocument: vi.fn(async () => ({ data: { uploadUrl: 'https://s3.test/upload', requiredHeaders: {}, s3Key: 'cases/CASE-1/uuid-a.pdf' } })),
  uploadToPresignedUrl: vi.fn(async () => undefined),
  recordDocument: vi.fn(async () => ({ data: { id: 'DOC-1' } })),
}));
const { getLatestQuickNoteMock, createChartNoteMock, patchChartNoteMock } = vi.hoisted(() => ({
  getLatestQuickNoteMock: vi.fn(),
  createChartNoteMock: vi.fn(),
  patchChartNoteMock: vi.fn(),
}));
vi.mock('../api/chart-notes', () => ({
  listChartNotes: vi.fn(async () => ({ data: [] })),
  getLatestQuickNote: getLatestQuickNoteMock,
  createChartNote: createChartNoteMock, deleteChartNote: vi.fn(), patchChartNote: patchChartNoteMock,
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
  // Header quick-note mocks default to "no note" so unrelated tests render the inert "+ quick note"
  // affordance; the dedicated quick-note tests override per case. Reset so resolved values don't leak.
  beforeEach(() => {
    getLatestQuickNoteMock.mockReset().mockResolvedValue({ data: null });
    createChartNoteMock.mockReset().mockResolvedValue({ data: {} });
    patchChartNoteMock.mockReset().mockResolvedValue({ data: {} });
  });

  it('renders the case header and admin transition controls', async () => {
    renderPage();
    expect(await screen.findByText('Hypertension')).toBeInTheDocument();
    expect(screen.getByText('Physician review')).toBeInTheDocument(); // status badge
    // From physician_review, an admin may move to delivered / correction_requested / rejected.
    // The 'delivered' enum displays as "Ready for delivery" (post-approve, pre-payment).
    expect(screen.getByRole('button', { name: /move to ready for delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject \+ soft delete/i })).toBeInTheDocument();
  });

  // === Chart-header quick note: restored view + add/edit (Dr. Kasky 2026-06-24) ===

  it('renders the latest quick note in the chart header with an Edit affordance', async () => {
    getLatestQuickNoteMock.mockResolvedValue({ data: { id: 'QN-1', veteranId: 'VET-1', body: 'C-file requested 6/8', isQuickNote: true, createdBy: 's', createdByName: 'Sarah Jones', createdAt: '2026-06-20T12:00:00Z', updatedAt: '2026-06-20T12:00:00Z', version: 1 } });
    renderPage();
    await screen.findByText('Hypertension');
    // The latest quick note body + author surface in the header, with an Edit button.
    expect(await screen.findByText('C-file requested 6/8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit quick note' })).toBeInTheDocument();
  });

  it('shows a "+ quick note" add affordance in the header when the veteran has none, and Save POSTs a quick note', async () => {
    getLatestQuickNoteMock.mockResolvedValue({ data: null });
    createChartNoteMock.mockResolvedValue({ data: {} });
    renderPage();
    await screen.findByText('Hypertension');
    const add = await screen.findByRole('button', { name: '+ quick note' });
    await userEvent.click(add);
    const input = screen.getByLabelText('Quick note');
    await userEvent.type(input, 'Awaiting STRs');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createChartNoteMock).toHaveBeenCalledWith('VET-1', 'Awaiting STRs', true));
  });

  // UI sweep P2 (Ryan item 12): the claim-page tab order is locked, Clarifications is gone (tab +
  // panel mount removed; the panel component, api client, and backend route all remain), and the
  // shared TabBar is sticky so the bar survives a long-panel scroll.
  it('locks the claim tab order, drops Clarifications, and renders a sticky tab bar', async () => {
    renderPage();
    await screen.findByText('Hypertension');
    // Case-page restructure (Ryan 2026-06-20): Overview → Action (operational), + a new Summary
    // (clinical SOAP-note read) tab right after it.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Action', 'Summary', 'Ask Aegis', 'Draft jobs', 'Staff Notes', 'Email', 'Messages',
      'Documents', 'SC Conditions', 'Active Problems', 'Medications',
      'Decisions',
    ]);
    expect(screen.queryByRole('tab', { name: /clarifications/i })).not.toBeInTheDocument();
    // Sticky = class assertion (P2a): pinned to the scroll parent, opaque, above panel content.
    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('sticky');
    expect(tablist.className).toContain('top-0');
    expect(tablist.className).toContain('z-10');
    expect(tablist.className).toContain('bg-ivory');
  });

  // Case-page tab/header restructure (Ryan 2026-06-20): the patient header + banners stay PINNED above
  // the sticky tab bar (render on every tab). The OPERATIONAL panels (DoctorPack / drafter-review set /
  // Delivery / Assignments) live on the ACTION tab; the framing/opinion/cost summary fields moved to the
  // new SUMMARY tab. These assertions lock the new shape.
  it('keeps the patient header pinned on EVERY tab (name renders regardless of selected tab)', async () => {
    renderPage();
    // Default tab (Action): the name link is present.
    expect(await screen.findByRole('link', { name: /Doe, Jane/i })).toBeInTheDocument();
    // Switch to a non-Action tab and confirm the persistent header still shows the name + the
    // status badge (both live ABOVE the tab bar now).
    await userEvent.click(screen.getByRole('tab', { name: 'Medications' }));
    expect(screen.getByRole('link', { name: /Doe, Jane/i })).toBeInTheDocument();
    expect(screen.getByText('Physician review')).toBeInTheDocument(); // status badge, still pinned
    // And again on the SC Conditions tab — the header is tab-independent.
    await userEvent.click(screen.getByRole('tab', { name: 'SC Conditions' }));
    expect(screen.getByRole('link', { name: /Doe, Jane/i })).toBeInTheDocument();
  });

  it('renders Assignments on the Action tab and the summary fields on the Summary tab', async () => {
    mockRole = 'admin'; // Assignments panel is admin/ops_staff-only
    renderPage();
    await screen.findByText('Hypertension');
    // Action is the default tab: the Assignments panel renders; the summary fields do NOT (they moved).
    expect(screen.getByText('Assignments')).toBeInTheDocument();
    expect(screen.queryByText('Drafting cost (API)')).not.toBeInTheDocument();
    // The Summary tab carries the framing / opinion / cost fields.
    await userEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(await screen.findByText('Framing')).toBeInTheDocument();
    expect(screen.getByText('In-service event')).toBeInTheDocument();
    expect(screen.getByText('Drafting cost (API)')).toBeInTheDocument();
    // The Summary tab is a clinical read, not the action surface — Assignments is NOT here.
    expect(screen.queryByText('Assignments')).not.toBeInTheDocument();
    // Back to Action → the summary fields unmount, Assignments returns.
    await userEvent.click(screen.getByRole('tab', { name: 'Action' }));
    expect(await screen.findByText('Assignments')).toBeInTheDocument();
    expect(screen.queryByText('Drafting cost (API)')).not.toBeInTheDocument();
  });

  it('exposes the veteran clinical chart tabs on the case page', async () => {
    renderPage();
    await screen.findByText('Hypertension');
    // The four clinical tabs mirror the veteran chart page.
    expect(screen.getByRole('tab', { name: 'SC Conditions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Active Problems' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Medications' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Staff Notes' })).toBeInTheDocument();
    // Clicking the SC Conditions tab mounts the shared ConditionsPanel and shows the veteran's data.
    await userEvent.click(screen.getByRole('tab', { name: 'SC Conditions' }));
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

// ── Case-page Documents tab DELETE control (Ryan 2026-06-14: "I DON'T HAVE A DELETE BUTTON") ──
// The only delete used to live on the veteran chart; this adds it to the case Documents tab so a
// misuploaded/junk file (e.g. a 0-byte Intake_Summary.pdf) can be removed where ops actually works.
// Same deleteDocument API + same "removes it from the chart for ALL claims" confirm; on success it
// invalidates BOTH the documents list AND ['case', caseId, 'chart-readiness'] so the readiness gate
// re-evaluates immediately (delete the blocker → gate clears, no manual refresh).
describe('CaseDetailPage — Documents tab delete control', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(deleteDocument).mockClear(); vi.mocked(listDocuments).mockResolvedValue({ data: [] }); mockRole = 'admin'; });

  // One file on THIS claim (DocumentsTab filters docs to d.caseId === caseId).
  const oneDocOnClaim = () => vi.mocked(listDocuments).mockResolvedValue({ data: [
    { id: 'DOC-9', veteranId: 'VET-1', caseId: 'CASE-1', filename: 'Intake_Summary.pdf', docTag: 'Other', contentType: 'application/pdf', uploadedAt: new Date(Date.now() - 3_600_000).toISOString() },
  ] as never });

  it('admin: Delete fires the same-claim confirm and calls deleteDocument with the row id', async () => {
    mockRole = 'admin';
    oneDocOnClaim();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('Hypertension');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));

    expect(await screen.findByText('Intake Summary')).toBeInTheDocument(); // content-based display name (no raw "_" filename / "Misc/Other")
    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(deleteBtn);

    // The explicit warning matches the chart's copy: removes it for ALL the veteran's claims.
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('ALL of their claims'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Intake_Summary.pdf'));
    // React Query v5 passes a second mutation-context arg to the mutationFn, so match the first arg only.
    await waitFor(() => expect(vi.mocked(deleteDocument).mock.calls[0]?.[0]).toBe('DOC-9'));
  });

  it('admin: cancelling the confirm does NOT call deleteDocument', async () => {
    mockRole = 'admin';
    oneDocOnClaim();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('Hypertension');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('invalidates the chart-readiness query on a successful delete so the gate re-evaluates', async () => {
    mockRole = 'admin';
    oneDocOnClaim();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/cases/CASE-1']}>
          <Routes>
            <Route path="/cases/:id" element={<CaseDetailPage />} />
            <Route path="/veterans/:id" element={<div>VETERAN CHART for VET-1</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Hypertension');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(vi.mocked(deleteDocument).mock.calls[0]?.[0]).toBe('DOC-9'));
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents', 'VET-1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['case', 'CASE-1', 'chart-readiness'] });
    });
  });

  it('physician: the Delete control is NOT exposed (destructive op stays OPS-gated)', async () => {
    mockRole = 'physician';
    oneDocOnClaim();
    renderPage();
    await screen.findByText('Hypertension');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('Intake Summary')).toBeInTheDocument(); // content-based display name (no raw "_" filename / "Misc/Other")
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
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

  it("ops_staff on a physician_review case sees the LOCK banner with the doctor's name (Ryan 2026-06-11 reversal)", async () => {
    mockRole = 'ops_staff';
    mockCase({ assignedPhysician: pryor });
    renderPage();
    expect(await screen.findByText(/in Dr\. Pryor's queue/)).toBeInTheDocument();
    // 2026-06-11: the banner copy flipped from "any save becomes what the doctor reviews" to a
    // LOCK statement — RN edits are blocked in physician_review (backend 409s both edit routes).
    expect(screen.getByText(/locked from edits until the doctor acts/i)).toBeInTheDocument();
    expect(screen.queryByText(/Open letter editor/)).toBeNull();
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

// ── G1 redraft lock (ratified sign/edit lifecycle, Ryan 2026-06-12): "lock redraft after sent
// to doctor. if doc sends back to RN that reopens." canRedraft drops the Redraft affordance for
// ops_staff in physician_review; the backend mirrors it with 409 locked_physician_review. ──
describe('CaseDetailPage — Redraft lock (G1, ratified 2026-06-12)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  // A terminal done job with a sane PDF key — the pre-lock canRedraft preconditions
  // (a draft exists + nothing in flight) hold, so only the new status×role rule decides.
  const doneJob = { id: 'JOB-1', state: 'done', version: 1, artifactPdfS3Key: 'letter-revisions/CASE-1/v1/letter.pdf' };

  it('ops_staff does NOT see Redraft while the case is in physician_review (locked)', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'physician_review', draftJobs: [doneJob] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByRole('button', { name: 'Redraft' })).not.toBeInTheDocument();
  });

  it('ops_staff sees Redraft in rn_review (pre-send: still the RN\'s case)', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'rn_review', draftJobs: [doneJob] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getByRole('button', { name: 'Redraft' })).toBeInTheDocument();
  });

  it('ops_staff sees Redraft in correction_review (the doctor sent it back — reopened)', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'correction_review', draftJobs: [doneJob] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getByRole('button', { name: 'Redraft' })).toBeInTheDocument();
  });

  it('admin keeps Redraft in physician_review (the lock is ops_staff-only)', async () => {
    mockRole = 'admin';
    mockCase({ status: 'physician_review', draftJobs: [doneJob] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getByRole('button', { name: 'Redraft' })).toBeInTheDocument();
  });
});

// ── RN can EDIT a sent-back ('correction_requested') letter in the full editor (Dr. Kasky 2026-06-24) ──
// When the physician declines a letter (/letter/decline), the case lands in 'correction_requested' and
// sits there for the RN. The RN must be able to HAND-FIX it in the full editor — not be forced to
// Redraft. The backend already allows the edit (EDITABLE_STATUSES includes correction_requested); this
// pins the FRONTEND surfacing of the "Open letter editor" action + the doctor's correction note.
describe('CaseDetailPage — RN edit on correction_requested (Dr. Kasky 2026-06-24)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  // A terminal done job with a sane .pdf key → the letter is viewable, so the RN editor-entry card's
  // hasViewableLetterJob precondition holds; only the new status×role rule decides.
  const doneJob = { id: 'JOB-1', state: 'done', version: 1, artifactPdfS3Key: 'letter-revisions/CASE-1/v1/letter.pdf' };

  // Local render harness that registers the letter-editor route so the navigate() target is real and
  // we can assert the click lands there (the shared renderPage only knows /cases/:id + /veterans/:id).
  function renderWithEditorRoute() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/cases/CASE-1']}>
          <Routes>
            <Route path="/cases/:id" element={<CaseDetailPage />} />
            <Route path="/cases/:id/letter" element={<div>LETTER EDITOR PAGE</div>} />
            <Route path="/veterans/:id" element={<div>VETERAN CHART</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('ops_staff on a correction_requested case sees "Open letter editor" (not just View/Redraft); clicking it navigates to the editor', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'correction_requested', draftJobs: [doneJob], operatorMessage: 'Tighten the §VII opinion sentence.' });
    renderWithEditorRoute();
    await screen.findByText('Hypertension');

    // The editor-entry card + its primary action surface.
    const openEditor = await screen.findByRole('button', { name: 'Open letter editor' });
    expect(openEditor).toBeInTheDocument();
    // The doctor's correction note (Case.operatorMessage) is surfaced so the RN knows WHAT to fix.
    expect(screen.getByText('Tighten the §VII opinion sentence.')).toBeInTheDocument();
    // Redraft stays available too (a done job + not physician_review).
    expect(screen.getByRole('button', { name: 'Redraft' })).toBeInTheDocument();

    // Clicking Open letter editor navigates to the full editor route.
    await userEvent.click(openEditor);
    expect(await screen.findByText('LETTER EDITOR PAGE')).toBeInTheDocument();
  });

  it('does NOT surface the RN editor-entry to a physician (they reach the editor via the ready panel)', async () => {
    mockRole = 'physician';
    mockCase({ status: 'correction_requested', draftJobs: [doneJob], operatorMessage: 'note' });
    renderWithEditorRoute();
    await screen.findByText('Hypertension');
    expect(screen.queryByRole('button', { name: 'Open letter editor' })).not.toBeInTheDocument();
  });
});

// ── C6 lifecycle (2026-06-13): Archive / Reopen buttons on the claim page ──────────────────────
describe('CaseDetailPage — Archive / Reopen (C6 lifecycle, 2026-06-13)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  it('a live claim shows the Archive button (RN/admin); clicking it confirms + archives via archiveCase', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'intake', archivedAt: null });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('Hypertension');
    const archiveBtn = screen.getByRole('button', { name: 'Archive' });
    expect(archiveBtn).toBeInTheDocument();
    // A live claim has no Reopen affordance.
    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
    await userEvent.click(archiveBtn);
    await waitFor(() => expect(archiveCase).toHaveBeenCalledWith('CASE-1'));
    confirmSpy.mockRestore();
  });

  it('an archived claim shows the Archived banner + Reopen; clicking Reopen restores via restoreCase', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'intake', archivedAt: '2026-06-12T00:00:00Z' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('Hypertension');
    // Archived banner is visible.
    expect(screen.getByText(/hidden from the active Cases list/i)).toBeInTheDocument();
    // The workflow Archive button is suppressed while archived.
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    // Reopen appears (the banner button + the action-bar button both read "Reopen…"); click the
    // action-bar primary "Reopen claim".
    await userEvent.click(screen.getByRole('button', { name: 'Reopen claim' }));
    await waitFor(() => expect(restoreCase).toHaveBeenCalledWith('CASE-1'));
    confirmSpy.mockRestore();
  });

  it('a physician does NOT get Archive or Reopen (RN/admin only)', async () => {
    mockRole = 'physician';
    mockCase({ status: 'physician_review', archivedAt: null, assignedPhysician: { id: 'PHY-1', fullName: 'A B, MD', email: 'd@x.test' } });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });
});

// ── Import final letter (2026-06-14): drop a finished PDF onto a case so it lands in rn_review and
// flows RN -> physician -> delivery. Button is admin/ops_staff only, hidden once the case is with
// the doctor or already delivered, and hidden from physicians. ──
describe('CaseDetailPage — Import final letter button (2026-06-14)', () => {
  afterEach(() => { mockRole = 'admin'; vi.restoreAllMocks(); });

  it('ops_staff sees "Import final letter" on an rn_review case (no draft in flight)', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'rn_review', draftJobs: [] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getByRole('button', { name: 'Import final letter' })).toBeInTheDocument();
    // The hidden PDF picker is wired in.
    expect(screen.getByLabelText('Import final letter PDF')).toBeInTheDocument();
  });

  it('admin sees it on an intake-stage case too', async () => {
    mockRole = 'admin';
    mockCase({ status: 'intake', draftJobs: [] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.getByRole('button', { name: 'Import final letter' })).toBeInTheDocument();
  });

  it('is HIDDEN in physician_review, delivered, and paid (past the RN)', async () => {
    for (const status of ['physician_review', 'delivered', 'paid']) {
      mockRole = 'ops_staff';
      mockCase({ status });
      renderPage();
      await screen.findByText('Hypertension');
      expect(screen.queryByRole('button', { name: 'Import final letter' })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('is HIDDEN for a physician', async () => {
    mockRole = 'physician';
    mockCase({ status: 'rn_review', assignedPhysician: { id: 'PHY-1', fullName: 'A B, MD', email: 'd@x.test' } });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByRole('button', { name: 'Import final letter' })).not.toBeInTheDocument();
  });

  it('is HIDDEN while a draft is in flight (would collide with the running attempt)', async () => {
    mockRole = 'ops_staff';
    mockCase({ status: 'drafting', draftJobs: [{ id: 'DJ-1', caseId: 'CASE-1', state: 'running', version: 1, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' }] });
    renderPage();
    await screen.findByText('Hypertension');
    expect(screen.queryByRole('button', { name: 'Import final letter' })).not.toBeInTheDocument();
  });
});
