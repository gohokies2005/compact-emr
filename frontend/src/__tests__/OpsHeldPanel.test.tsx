import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpsHeldPanel } from '../components/OpsHeldPanel';
import { postDraft } from '../api/drafter';
import { transitionCaseStatus, type CaseDetail } from '../api/cases';
import type { DraftJob } from '../types/prisma';

vi.mock('../api/drafter', async () => {
  const actual = await vi.importActual<typeof import('../api/drafter')>('../api/drafter');
  return { ...actual, postDraft: vi.fn() };
});

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, transitionCaseStatus: vi.fn() };
});

const postDraftMock = vi.mocked(postDraft);
const transitionCaseStatusMock = vi.mocked(transitionCaseStatus);

const heldCase: CaseDetail = {
  id: 'CASE-2',
  veteranId: 'VET-2',
  claimedCondition: 'Back condition',
  claimType: 'supplemental',
  status: 'drafting',
  version: 4,
  currentVersion: 1,
  refundEligible: false,
  cdsVerdict: 'caution',
  createdAt: '2026-05-25T12:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
  veteran: {
    id: 'VET-2',
    firstName: 'Test',
    lastName: 'Veteran',
    email: 'test2@example.com',
  },
  assignedPhysician: null,
  documents: [],
  draftJobs: [],
  corrections: [],
  emails: [],
  payments: [],
  probativeScore: 5,
  grade: 'C+',
  shipRecommendation: 'revise',
  operatorState: 'paused',
  runComplete: false,
};

const heldJob: DraftJob = {
  id: 'draft-job-2',
  caseId: 'CASE-2',
  state: 'done',
  version: 1,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  completedAt: '2026-05-25T12:20:00.000Z',
  updatedAt: '2026-05-25T12:20:00.000Z',
  manifestSnapshot: {
    phases: {
      grader: {
        summary: 'Grade was below ship threshold.',
        status: 'complete',
      },
    },
  },
};

function renderPanel(isAdmin = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OpsHeldPanel c={heldCase} job={heldJob} isAdmin={isAdmin} />
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('OpsHeldPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } });
    // transitionCaseStatus returns { data: CaseLite } not CaseDetail — use the slimmer
    // shape so the mock's return type matches.
    transitionCaseStatusMock.mockResolvedValue({
      data: {
        id: heldCase.id,
        veteranId: heldCase.veteranId,
        claimedCondition: heldCase.claimedCondition,
        claimType: heldCase.claimType,
        status: 'physician_review',
        version: heldCase.version + 1,
        currentVersion: heldCase.currentVersion,
        assignedPhysicianId: null,
        assignedRnId: null,
        refundEligible: heldCase.refundEligible,
        createdAt: heldCase.createdAt,
        updatedAt: heldCase.updatedAt,
      },
    });
  });

  it('renders an HONEST no-draft headline (not the misleading "Drafting was interrupted") + a single re-run action', () => {
    renderPanel();

    // The hardcoded "Drafting was interrupted" headline was a defect — for a no-letter hold it
    // overstated (the run may have failed before producing anything). Honest copy instead.
    expect(screen.queryByText('Drafting was interrupted')).not.toBeInTheDocument();
    expect(screen.getByText(/did not finish/i)).toBeInTheDocument();
    // hasLetter is not passed → the no-letter copy variant; single re-run action, no "from scratch".
    expect(screen.getByText(/did not produce a letter/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run full draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /from scratch/i })).not.toBeInTheDocument();
    // The case-specific operator message (the REAL reason) still renders beneath the summary.
    expect(
      screen.getByText(
        "We've paused this one for a closer look. Nothing's lost - your work is saved and we've flagged it for the team.",
      ),
    ).toBeInTheDocument();
  });

  it('when a letter was produced, the primary affordance opens the EDITOR (not the read-only PDF)', () => {
    const onOpenEditor = vi.fn();
    const onViewLetter = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <OpsHeldPanel c={heldCase} job={heldJob} isAdmin={false} hasLetter onViewLetter={onViewLetter} onOpenEditor={onOpenEditor} />
      </QueryClientProvider>,
    );
    // honest "produced" copy
    expect(screen.getByText(/did not finish/i)).toBeInTheDocument();
    const openEditorBtn = screen.getByRole('button', { name: /open letter editor/i });
    fireEvent.click(openEditorBtn);
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect(onViewLetter).not.toHaveBeenCalled(); // the produced affordance no longer dead-ends at the PDF
  });

  it('calls postDraft when resuming the draft (after confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Re-run full draft' }));

    await waitFor(() => {
      expect(postDraftMock).toHaveBeenCalledWith('CASE-2');
    });
    confirmSpy.mockRestore();
  });

  it('does NOT resume when the confirm is dismissed (redraft-pileup guard)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Re-run full draft' }));

    expect(postDraftMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows details from the manifest summary', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Details/ }));

    expect(screen.getByText('Grade: C+')).toBeInTheDocument();
    expect(screen.getByText('Ship recommendation: revise')).toBeInTheDocument();
    expect(screen.getByText('Operator state: paused')).toBeInTheDocument();
    expect(screen.getByText('Grade was below ship threshold.')).toBeInTheDocument();
  });

  it('allows admin open-as-is override with confirmation', async () => {
    renderPanel(true);

    fireEvent.click(screen.getByRole('button', { name: 'Open as-is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm open as-is' }));

    await waitFor(() => {
      expect(transitionCaseStatusMock).toHaveBeenCalledWith('CASE-2', {
        from: 'drafting',
        to: 'physician_review',
        version: 4,
        transitionReason: 'admin override to physician review',
      });
    });
  });
});
