import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianReviewPage } from '../routes/physician/PhysicianReviewPage';
import { getCase, type CaseDetail } from '../api/cases';
import { approveLetter } from '../api/letter';
import { ConflictError } from '../api/client';
import type { DraftJob } from '../types/prisma';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, getCase: vi.fn() };
});

vi.mock('../api/drafter', () => ({
  getArtifactPdfUrl: vi.fn(),
}));

vi.mock('../api/letter', () => ({
  approveLetter: vi.fn(),
}));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Stub the attestation popup: when open, expose a single button that fires onSignedOff — the
// page-level approve chain (the code under test) runs exactly as in production.
vi.mock('../components/SignOffPopup', () => ({
  SignOffPopup: ({ open, onSignedOff }: { open: boolean; onSignedOff?: () => void | Promise<void> }) =>
    open ? (
      <button type="button" onClick={() => { void onSignedOff?.(); }}>
        complete sign-off
      </button>
    ) : null,
}));

const getCaseMock = vi.mocked(getCase);
const approveLetterMock = vi.mocked(approveLetter);

const readyJob: DraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'done',
  version: 2,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  completedAt: '2026-05-25T12:20:00.000Z',
  updatedAt: '2026-05-25T12:20:00.000Z',
  artifactPdfS3Key: 'drafter-artifacts/CASE-1/v2/v2.pdf',
};

const readyCase: CaseDetail = {
  id: 'CASE-1',
  veteranId: 'VET-1',
  claimedCondition: 'Sleep apnea',
  claimType: 'supplemental',
  status: 'physician_review',
  version: 3,
  currentVersion: 2,
  refundEligible: false,
  cdsVerdict: 'accept',
  createdAt: '2026-05-25T12:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
  veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' },
  assignedPhysician: null,
  documents: [],
  draftJobs: [readyJob],
  corrections: [],
  emails: [],
  payments: [],
  probativeScore: 8,
  grade: 'A-',
  shipRecommendation: 'ship',
  operatorState: 'ready',
  runComplete: true,
};

function renderReview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/review/CASE-1']}>
        <Routes>
          <Route path="/p/review/:caseId" element={<PhysicianReviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PhysicianReviewPage', () => {
  it('renders the ready panel and exposes no A/B decision buttons in the disclosure region', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    // Header shows the veteran name + case id.
    expect(screen.getAllByText(/Young, Matthew/).length).toBeGreaterThan(0);
  });

  it('shows the not-ready empty state when the case is not ready', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: 'revise' },
    });
    renderReview();

    expect(
      await screen.findByText('This case is not ready for physician review.'),
    ).toBeInTheDocument();
  });

  // ── Sign-off incident 2026-06-09 regression: the approve catch must surface the server's REAL
  // gate message (it was swallowed behind a generic "chart may not be ready" guess — hour lost). ──
  it('surfaces the 409 approve-gate message VERBATIM in the failure alert (swallowed-error regression)', async () => {
    const gateMessage = 'Cannot approve: the letter does not name the assigned signing physician (Jane A. Doe, MD). Regenerate or correct the letter so it is authored under the assigned physician, then approve.';
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    getCaseMock.mockResolvedValue({ data: readyCase });
    approveLetterMock.mockRejectedValue(new ConflictError({ reason: 'signer_name_absent' }, gateMessage, 'conflict'));
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve and sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'complete sign-off' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const alerted = String(alertSpy.mock.calls[0]?.[0]);
    expect(alerted).toContain(gateMessage); // the real cause, verbatim
    expect(alerted).toContain('409');
    expect(alerted).not.toContain('the chart may not be ready'); // the old generic guess is gone
    alertSpy.mockRestore();
  });

  it('keeps a generic-but-real fallback in the alert when the server sent no message', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    getCaseMock.mockResolvedValue({ data: readyCase });
    approveLetterMock.mockRejectedValue(new ConflictError());
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve and sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'complete sign-off' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('the case changed or a job is already running (409)');
    alertSpy.mockRestore();
  });

  // ── Fix 3: pre-flight approve blockers banner (advisory; shows the gate messages BEFORE attest) ──
  it('renders the approve-blockers warning banner when the GET carries approveBlockers', async () => {
    const gateMessage = 'Cannot approve: the letter does not name the assigned signing physician (Jane A. Doe, MD). Regenerate or correct the letter so it is authored under the assigned physician, then approve.';
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, approveBlockers: [{ code: 'signer_name_absent', message: gateMessage }] },
    });
    renderReview();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Approve will be blocked');
    expect(banner).toHaveTextContent(gateMessage);
    // The Approve button stays available — the banner is advisory, the backend gate is authoritative.
    expect(screen.getByRole('button', { name: 'Approve and sign' })).toBeEnabled();
  });

  it('FAIL-OPEN: no banner when approveBlockers is absent (older backend) or empty', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase }); // field absent
    renderReview();
    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no banner when approveBlockers is an empty array (all gates green)', async () => {
    getCaseMock.mockResolvedValue({ data: { ...readyCase, approveBlockers: [] } });
    renderReview();
    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
