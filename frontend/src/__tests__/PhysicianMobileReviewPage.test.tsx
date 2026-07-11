import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianMobileReviewPage } from '../routes/physician/PhysicianMobileReviewPage';
import { getCase, type CaseDetail } from '../api/cases';
import { approveLetter, finalizeImportLetter, getLetter } from '../api/letter';
import { sendBackToRn } from '../api/drafter';
import type { DraftJob } from '../types/prisma';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, getCase: vi.fn() };
});
vi.mock('../api/letter', () => ({
  approveLetter: vi.fn(),
  finalizeImportLetter: vi.fn(),
  getLetter: vi.fn(),
}));
vi.mock('../api/drafter', () => ({ sendBackToRn: vi.fn() }));
// Part B veteran-theory lazy fetch (useVeteranTheory) fires from the page — stub it to the fail-open shape
// so these review/approve-flow tests don't make a real network call (mirrors the child-query stubs above).
vi.mock('../api/veteran-theory', () => ({ getVeteranTheory: vi.fn().mockResolvedValue({ data: null }) }));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

// Child panels fire their own data queries / need an AuthProvider — they each have their own suites,
// so stub them here to keep these tests focused on the review/approve flow (mirrors the desktop
// PhysicianReviewPage test). We assert they are MOUNTED (SOAP + abridged docs are present).
vi.mock('../components/SoapOverviewCard', () => ({ SoapOverviewCard: () => <div data-testid="soap-overview" /> }));
vi.mock('../components/DoctorPackPanel', () => ({ DoctorPackPanel: () => <div data-testid="doctor-pack-panel" /> }));
vi.mock('../components/PhysicianDocumentsList', () => ({ PhysicianDocumentsList: () => <div data-testid="documents-list" /> }));

// Sign-off popup stub: when open, a single button that fires the supplied submit path (onSignedOff for
// the normal path, onSubmitAnswers for an import). The page-level chain under test runs as in production.
vi.mock('../components/SignOffPopup', () => ({
  SignOffPopup: ({
    open,
    onSignedOff,
    onSubmitAnswers,
  }: {
    open: boolean;
    onSignedOff?: () => void | Promise<void>;
    onSubmitAnswers?: (input: { answers: Record<string, boolean> }) => Promise<unknown>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          if (onSubmitAnswers) {
            void onSubmitAnswers({
              answers: {
                records_reviewed: true,
                diagnosis_documented: true,
                nexus_supported: true,
                no_phi_in_letter: true,
                final_pdf_correct: true,
              },
            });
          } else {
            void onSignedOff?.();
          }
        }}
      >
        complete sign-off
      </button>
    ) : null,
}));

const getCaseMock = vi.mocked(getCase);
const approveLetterMock = vi.mocked(approveLetter);
const getLetterMock = vi.mocked(getLetter);
const finalizeImportLetterMock = vi.mocked(finalizeImportLetter);
const sendBackToRnMock = vi.mocked(sendBackToRn);

const readyJob: DraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'done',
  version: 2,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  completedAt: '2026-05-25T12:20:00.000Z',
  updatedAt: '2026-05-25T12:20:00.000Z',
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/m/review/CASE-1']}>
        <Routes>
          <Route path="/p/m/review/:caseId" element={<PhysicianMobileReviewPage />} />
          <Route path="/p/m/queue" element={<div>MOBILE QUEUE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getLetterMock.mockResolvedValue({ data: { source: 'drafter' } } as unknown as Awaited<ReturnType<typeof getLetter>>);
});

describe('PhysicianMobileReviewPage', () => {
  it('renders the SOAP story, abridged docs, the letter section, and the three actions', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    expect(await screen.findByTestId('soap-overview')).toBeInTheDocument();
    expect(screen.getByTestId('doctor-pack-panel')).toBeInTheDocument();
    expect(screen.getByTestId('documents-list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open the letter/ })).toBeInTheDocument();
    // The sticky action bar.
    expect(screen.getByRole('button', { name: 'Approve & sign' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save for computer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send back to RN' })).toBeInTheDocument();
  });

  it('Approve runs the existing sign-off → approve path and returns to the mobile queue', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    approveLetterMock.mockResolvedValue({ data: { version: 3, status: 'delivered', finalPdfKey: 'k' } });
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve & sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'complete sign-off' }));

    await waitFor(() => expect(approveLetterMock).toHaveBeenCalledWith('CASE-1'));
    expect(await screen.findByText('MOBILE QUEUE')).toBeInTheDocument();
  });

  it('"Save for computer" makes NO state change (no approve/finalize/send-back) and leaves the queue', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Save for computer' }));

    expect(await screen.findByText('MOBILE QUEUE')).toBeInTheDocument();
    expect(approveLetterMock).not.toHaveBeenCalled();
    expect(finalizeImportLetterMock).not.toHaveBeenCalled();
    expect(sendBackToRnMock).not.toHaveBeenCalled();
  });

  it('does NOT offer any in-page letter editing control (read-only feasibility call)', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    await screen.findByRole('button', { name: 'Approve & sign' });
    expect(screen.queryByRole('button', { name: /Edit text/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply edit/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull(); // no instruction box, no editor
  });

  it('imported letter routes Approve through finalizeImportLetter (not approveLetter)', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: undefined, draftJobs: [] },
    } as unknown as { data: CaseDetail });
    getLetterMock.mockResolvedValue({ data: { source: 'external_import' } } as unknown as Awaited<ReturnType<typeof getLetter>>);
    finalizeImportLetterMock.mockResolvedValue({ data: { status: 'delivered' } } as unknown as Awaited<ReturnType<typeof finalizeImportLetter>>);
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve & finalize (as-is)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'complete sign-off' }));

    await waitFor(() => expect(finalizeImportLetterMock).toHaveBeenCalledTimes(1));
    expect(approveLetterMock).not.toHaveBeenCalled();
  });

  it('a pre-draft halt with no letter shows the not-ready state and no action bar', async () => {
    getCaseMock.mockResolvedValue({ data: { ...readyCase, runComplete: false, draftJobs: [] } });
    // default getLetter mock has no txt/pdf → no current letter
    renderReview();

    expect(await screen.findByText('This case is not ready for physician review yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & sign' })).toBeNull();
  });
});
