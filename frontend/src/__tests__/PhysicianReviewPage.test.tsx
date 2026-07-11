import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianReviewPage } from '../routes/physician/PhysicianReviewPage';
import { getCase, type CaseDetail } from '../api/cases';
import { approveLetter, finalizeImportLetter, getLetter } from '../api/letter';
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
  finalizeImportLetter: vi.fn(),
  getLetter: vi.fn(),
}));
// PhysicianLetterReadyPanel's Part B useVeteranTheory hook lazy-fetches GET /cases/:id/veteran-theory —
// stub it to the fail-open shape so no real network call fires (unstubbed calls leak async ENOTFOUND
// rejections into the parallel suite and flake unrelated tests).
vi.mock('../api/veteran-theory', () => ({ getVeteranTheory: vi.fn().mockResolvedValue({ data: null }) }));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Chunk D: the Doctor Pack panel has its own test suite (DoctorPackPanel.test.tsx) and needs
// an AuthProvider; stub it here so the page tests stay focused on the review/approve flow.
vi.mock('../components/DoctorPackPanel', () => ({
  DoctorPackPanel: () => <div data-testid="doctor-pack-panel" />,
}));

// Stub the two child panels that fire their own data queries (they have their own suites) so the
// review/approve-flow tests stay focused + deterministic — same pattern as DoctorPackPanel above.
vi.mock('../components/PhysicianHandoffNotes', () => ({
  PhysicianHandoffNotes: () => <div data-testid="handoff-notes" />,
}));
vi.mock('../components/PhysicianDocumentsList', () => ({
  PhysicianDocumentsList: () => <div data-testid="physician-documents-list" />,
}));

// Stub the attestation popup: when open, expose a single button. For the normal (drafter_run) path it
// fires onSignedOff (chains approve); for an imported letter the page wires onSubmitAnswers instead, so
// the stub fires that with a complete affirmative answer set. The page-level chain (the code under
// test) runs exactly as in production for whichever prop is supplied.
vi.mock('../components/SignOffPopup', () => ({
  SignOffPopup: ({
    open,
    onSignedOff,
    onSubmitAnswers,
  }: {
    open: boolean;
    onSignedOff?: () => void | Promise<void>;
    onSubmitAnswers?: (input: { answers: Record<string, boolean>; notes?: string }) => Promise<unknown>;
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
  // Default: a normal (non-import) rendered letter. The page now reads the current revision's `source`
  // from GET /cases/:id/letter to detect an imported letter; the drafter_run tests want source≠import.
  getLetterMock.mockResolvedValue({
    data: { source: 'drafter' },
  } as unknown as Awaited<ReturnType<typeof getLetter>>);
});

describe('PhysicianReviewPage', () => {
  it('renders the ready panel and exposes no A/B decision buttons in the disclosure region', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    // Header shows the veteran name + case id.
    expect(screen.getAllByText(/Young, Matthew/).length).toBeGreaterThan(0);
  });

  it('shows the not-ready empty state when there is NO current letter (pre-draft halt)', async () => {
    // runComplete false AND no letter (the default getLetter mock has no txt/pdf) → genuinely not ready.
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: 'revise' },
    });
    renderReview();

    expect(
      await screen.findByText('This case is not ready for physician review.'),
    ).toBeInTheDocument();
  });

  // Halted-then-hand-edited-then-forwarded letter (Ryan 2026-06-24, CLM-CCFDA1BCC3): the run never
  // "completed" (runComplete=false) so the old gate dead-ended the physician on "Not ready" even though
  // a real letter sat in the queue. A forwarded letter must be reviewable + signable (no-block rule);
  // "it's not really paused … just call it done but unverified."
  it('halted-then-edited letter (runComplete false BUT a real letter exists) is reviewable + flagged Unverified, NOT a dead-end', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: 'revise', grade: null },
    });
    getLetterMock.mockResolvedValue({
      data: {
        source: 'drafter',
        txt: 'I. Introduction\nThis nexus letter was hand-edited after the run was halted.',
        version: 4,
        rendered: { pdfUrl: 'https://x/current.pdf', docxUrl: null },
      },
    } as unknown as Awaited<ReturnType<typeof getLetter>>);
    renderReview();

    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.queryByText('This case is not ready for physician review.')).toBeNull();
    expect(screen.getByText(/Unverified/i)).toBeInTheDocument();
  });

  // P0a/P0b (Ryan 2026-06-13): the View-PDF resolves the CURRENT version via GET /cases/:id/letter
  // (not a stale job-pinned artifact), and a delivered/signed letter stays viewable here.
  it('delivered case: View-final-PDF opens the INLINE modal (currentVersion source), not a window.open popup', async () => {
    getCaseMock.mockResolvedValue({ data: { ...readyCase, status: 'delivered' } });
    getLetterMock.mockResolvedValue({
      data: { rendered: { pdfUrl: 'https://signed.example/current.pdf' } },
    } as unknown as Awaited<ReturnType<typeof getLetter>>);
    // window.open after an await is silently blocked on mobile/PWA → the fix renders inline instead.
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderReview();

    expect(await screen.findByText(/Signed and finalized/)).toBeInTheDocument();
    expect(screen.queryByText('This case is not ready for physician review.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View final letter PDF' }));
    // The inline LetterPdfModal mounts, fetches the current-version PDF, and iframes it — no popup.
    const iframe = await screen.findByTitle('Nexus letter');
    expect(iframe).toHaveAttribute('src', 'https://signed.example/current.pdf');
    expect(getLetterMock).toHaveBeenCalledWith('CASE-1');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
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

  // CLM-8EC828F1D7 (Hildreth, 2026-07-01): a halted render-parity draft, hand-edited + forwarded, showed
  // BOTH "Letter is ready · Grade A" AND a hard "No current letter to approve" blocker at the same time —
  // because the card read the recovery-capable GET /letter while the blocker read the STRICT resolver. The
  // backend fix reconciles them (the blocker now uses the same recovery resolver), so a present forwarded
  // letter carries NO no_letter blocker. This pins the reconciled screen: the ready card + the honest
  // Unverified caution render, and the contradictory "No current letter to approve" line is GONE.
  it('reconciled halted-then-forwarded letter: ready card + Unverified caution, and NO "No current letter to approve" contradiction', async () => {
    getCaseMock.mockResolvedValue({
      // Hildreth: automated run did NOT complete (halted), grade A / 10, present letter, and — post-fix —
      // approveBlockers carries no no_letter (the backend recovery resolver found the forwarded letter).
      data: { ...readyCase, runComplete: false, grade: 'A', probativeScore: 10, approveBlockers: [] },
    });
    getLetterMock.mockResolvedValue({
      data: {
        source: 'drafter',
        txt: 'I. Introduction\nHildreth OSA nexus letter, hand-edited after the render-parity halt.',
        version: 54,
        rendered: { pdfUrl: 'https://x/current.pdf', docxUrl: null },
      },
    } as unknown as Awaited<ReturnType<typeof getLetter>>);
    renderReview();

    // The two signals AGREE: the ready card shows AND there is no no_letter blocker.
    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    expect(screen.queryByText(/No current letter to approve/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // no hard blocker banner at all
    // The honest soft caution is KEPT (only the hard blocker was wrong).
    expect(screen.getByText(/Unverified/i)).toBeInTheDocument();
    // The letter is signable — a present forwarded letter is never blocked (no-block-draft rule).
    expect(screen.getByRole('button', { name: 'Approve and sign' })).toBeEnabled();
  });

  // ── Imported-letter finalize (functional gap fix, 2026-06-14) ─────────────────────────────────
  // An external_import letter in physician_review NEVER sets runComplete/shipRecommendation, so the
  // normal "ready" gate dead-ended the physician on "Not ready for review". The page must instead
  // detect the import (via GET /cases/:id/letter source) and render the finalize control, routing the
  // sign-off through finalizeImportLetter (NOT approveLetter, which 409s on imports).
  it('external_import in physician_review renders the finalize control (NOT "Not ready") even without runComplete/ship', async () => {
    // No runComplete, no shipRecommendation — exactly how the import txn leaves the case.
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: undefined, draftJobs: [] },
    } as unknown as { data: CaseDetail });
    getLetterMock.mockResolvedValue({ data: { source: 'external_import' } } as unknown as Awaited<ReturnType<typeof getLetter>>);
    renderReview();

    expect(await screen.findByText('Imported letter ready to finalize')).toBeInTheDocument();
    expect(screen.queryByText('This case is not ready for physician review.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Finalize for delivery (as-is, no re-render)' })).toBeInTheDocument();
  });

  // Probative grade persistence in the header (Ryan 2026-07-10): the grade lived only inside the
  // physician_review-gated letter panel, so it vanished the moment the doctor sent the letter back to the
  // RN. It must persist in the header for history/tracking when the doctor reopens a post-review case.
  it('probative grade PERSISTS in the header after the letter is sent back to the RN (history/tracking)', async () => {
    // correction_requested = the RN-editable state a send-back lands in — not physician_review, so the
    // ready panel (which carried the grade) is gone, but the grade must remain visible.
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, status: 'correction_requested', runComplete: true },
    });
    renderReview();

    // The full review panel is gone (not physician_review) …
    expect(await screen.findByText('This case is not ready for physician review.')).toBeInTheDocument();
    // … but the grade + probative score persist in the header.
    expect(screen.getByText(/Grade: A-/)).toBeInTheDocument();
    expect(screen.getByText(/Probative score: 8\/10/)).toBeInTheDocument();
  });

  it('does NOT double-show the grade — during physician_review the grade is in the panel only, not also the header', async () => {
    getCaseMock.mockResolvedValue({ data: readyCase });
    renderReview();

    expect(await screen.findByText('Letter is ready for your review')).toBeInTheDocument();
    // Exactly one grade chip on the page (the panel's) — the header does not add a second while reviewing.
    expect(screen.getAllByText(/Grade: A-/).length).toBe(1);
  });

  it('a genuinely pre-draft case (never graded → grade & score null) shows NO header grade', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, status: 'records', runComplete: false, grade: null, probativeScore: null },
    } as unknown as { data: CaseDetail });
    renderReview();

    expect(await screen.findByText('This case is not ready for physician review.')).toBeInTheDocument();
    expect(screen.queryByText(/Grade:/)).toBeNull();
    expect(screen.queryByText(/Probative score:/)).toBeNull();
  });

  it('submitting the imported-letter sign-off routes to finalizeImportLetter (not approveLetter)', async () => {
    getCaseMock.mockResolvedValue({
      data: { ...readyCase, runComplete: false, shipRecommendation: undefined, draftJobs: [] },
    } as unknown as { data: CaseDetail });
    getLetterMock.mockResolvedValue({ data: { source: 'external_import' } } as unknown as Awaited<ReturnType<typeof getLetter>>);
    finalizeImportLetterMock.mockResolvedValue({ data: { status: 'delivered' } } as unknown as Awaited<ReturnType<typeof finalizeImportLetter>>);
    renderReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Finalize for delivery (as-is, no re-render)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'complete sign-off' }));

    await waitFor(() => expect(finalizeImportLetterMock).toHaveBeenCalledTimes(1));
    expect(finalizeImportLetterMock).toHaveBeenCalledWith('CASE-1', expect.objectContaining({
      answers: expect.objectContaining({ records_reviewed: true, final_pdf_correct: true }),
    }));
    // The normal drafter_run path was NOT taken.
    expect(approveLetterMock).not.toHaveBeenCalled();
  });
});
