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

// Fix 4 (2026-06-25): OpsHeldPanel now fetches the current letter txt (getLetter) to map a parity
// offset → a Section/paragraph location. Mock it so the existing tests don't hit the network and the
// new Fix-4 test can supply a known letter body.
vi.mock('../api/letter', async () => {
  const actual = await vi.importActual<typeof import('../api/letter')>('../api/letter');
  return { ...actual, getLetter: vi.fn() };
});

// Mock the halt-explanation hook so we can drive the plain-language explainer directly (default: null =
// fail-open, so the panel shows the raw operator message exactly as before).
vi.mock('../hooks/useHaltExplanation', () => ({ useHaltExplanation: vi.fn(() => ({ explanation: null, isLoading: false })) }));

import { getLetter } from '../api/letter';
import { useHaltExplanation } from '../hooks/useHaltExplanation';

const postDraftMock = vi.mocked(postDraft);
const transitionCaseStatusMock = vi.mocked(transitionCaseStatus);
const getLetterMock = vi.mocked(getLetter);
const useHaltExplanationMock = vi.mocked(useHaltExplanation);

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
  it('MOUNTS the plain-language halt explainer — this panel IS a real paused surface (2026-07-02 fix: a drafting case whose run failed carries operatorState=paused, e.g. CLM-BE673DFF78)', () => {
    useHaltExplanationMock.mockReturnValue({
      explanation: { summary: 'This is really a secondary claim, not a direct one.', what_to_do: 'Set the framing to Secondary and re-run.', confidence: 'high' },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByText(/Why this paused/i)).toBeTruthy();
    expect(screen.getByText(/This is really a secondary claim/i)).toBeTruthy();
    expect(screen.getByText(/Set the framing to Secondary/i)).toBeTruthy();
  });

  it('falls back to the raw operator message when the explainer is unavailable (fail-open)', () => {
    useHaltExplanationMock.mockReturnValue({ explanation: null, isLoading: false });
    renderPanel();
    expect(screen.queryByText(/Why this paused/i)).toBeNull();
    expect(screen.getByText(/Grade was below ship threshold\.|drafter completed with concerns|temporary AI service error|closer look/i)).toBeTruthy();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } });
    // Default: a benign letter txt for the (enabled-only-when-hasLetter) getLetter query.
    getLetterMock.mockResolvedValue({ data: { txt: 'I. Physician Qualifications\n\nBody.' } } as never);
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

  // NOTE: the "shows details from the manifest summary" test was removed (2026-06-24) — the Details
  // event-log it exercised was intentionally deleted on 2026-06-23 ("de-clutter the didn't-finish
  // panel"; it was intimidating code-speak for an RN). The plain "why it didn't finish" copy + the
  // recovery buttons are tested above.

  it('allows admin open-as-is override with confirmation', async () => {
    renderPanel(true);

    fireEvent.click(screen.getByRole('button', { name: 'Open as-is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm open as-is' }));

    await waitFor(() => {
      expect(transitionCaseStatusMock).toHaveBeenCalledWith('CASE-2', {
        from: 'drafting',
        to: 'physician_review',
        version: 4,
        // transitionReason is 'send to doctor for review' (the single shared openAsIsMutation reason
        // since the forward-path consolidation) — was previously asserted as the stale 'admin override…'.
        transitionReason: 'send to doctor for review',
      });
    });
  });
});

// ── Fix 4 + Fix 5 (Dr. Kasky 2026-06-25) ──────────────────────────────────────────────────────────
// A canonical-shaped letter; the parity offset below points into Section VII paragraph 1.
const LETTER_TXT = [
  'May 30, 2026',
  '',
  'VI. Medical Reasoning and Rationale',
  '',
  'The reasoning paragraph.',
  '',
  'VII. Opinion',
  '',
  'It is my independent medical opinion that the condition is at least as likely as not.',
].join('\n');
const PARITY_OFFSET = LETTER_TXT.indexOf('It is my independent');

const fixCase = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  ...heldCase,
  id: 'CASE-7',
  status: 'needs_rn_decision',
  ...over,
});

function parityJob(): DraftJob {
  return {
    id: 'job-7', caseId: 'CASE-7', state: 'halted', version: 3,
    enqueuedAt: '2026-06-25T12:00:00.000Z', updatedAt: '2026-06-25T12:20:00.000Z',
    artifactTxtS3Key: 'drafter-artifacts/CASE-7/v3/v3.txt',
    manifestSnapshot: {
      phases: {
        preflight: { status: 'ran' }, index_consult: { status: 'ran' }, framing_gate: { status: 'ran' },
        cover_memo: { status: 'ran' }, source_lock: { status: 'ran' }, drafter: { status: 'ran' },
        adversary_panel: { status: 'ran' }, specialist_gate: { status: 'ran' }, refine_loop: { status: 'ran' },
        surgical_edit: { status: 'ran' }, citation_scoring: { status: 'ran' }, pmid_verify: { status: 'ran' },
        linter: { status: 'ran' }, qa_report: { status: 'ran' }, grader: { status: 'ran' }, render: { status: 'ran' },
        render_parity: { status: 'crashed', operator_message: `render_parity_mismatch: PDF text diverges from v3.txt at offset ${PARITY_OFFSET} — txt:'It is my independent...'` },
      },
    },
    gradeSidecarJson: { grade: 'B+', ship_recommendation: 'ship', targeted_revision_hints: [] },
  } as unknown as DraftJob;
}

function hintsJob(): DraftJob {
  return {
    id: 'job-8', caseId: 'CASE-7', state: 'halted', version: 3,
    enqueuedAt: '2026-06-25T12:00:00.000Z', updatedAt: '2026-06-25T12:20:00.000Z',
    artifactTxtS3Key: 'drafter-artifacts/CASE-7/v3/v3.txt',
    grade: 'B+',
    manifestSnapshot: {
      phases: { preflight: { status: 'ran' }, drafter: { status: 'ran' }, grader: { status: 'ran' }, render: { status: 'ran' }, render_parity: { status: 'ran' } },
    },
    gradeSidecarJson: {
      grade: 'B+', ship_recommendation: 'revise',
      targeted_revision_hints: [
        { section: 'VII', issue: 'consider adding an aggravation baseline sentence', suggested_fix: 'add a baseline-severity line' },
      ],
    },
  } as unknown as DraftJob;
}

function renderFix(c: CaseDetail, job: DraftJob) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OpsHeldPanel c={c} job={job} isAdmin={false} hasLetter onOpenEditor={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('OpsHeldPanel — Fix 4 (parity offset → human location)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } });
  });

  it('maps the parity offset reason to "Section VII, paragraph 1" (not a raw offset)', async () => {
    getLetterMock.mockResolvedValue({ data: { txt: LETTER_TXT } } as never);
    const c = fixCase({ operatorMessage: `render_parity_mismatch: PDF text diverges from v3.txt at offset ${PARITY_OFFSET} — txt:'It is my independent...'` });
    renderFix(c, parityJob());

    // The human location appears in BOTH the operatorMessage line and the stopped-step reason — both
    // are mapped (Fix 4). getAllByText to tolerate the two occurrences.
    await waitFor(() => expect(screen.getAllByText(/Section VII, paragraph 1/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/small formatting difference in Section VII, paragraph 1/i).length).toBeGreaterThan(0);
  });

  it('FAIL-OPEN: if the letter txt cannot be fetched, the panel still renders (no crash)', async () => {
    getLetterMock.mockRejectedValue(new Error('S3 down'));
    const c = fixCase({ operatorMessage: 'render_parity_mismatch: PDF text diverges from v3.txt at offset 11037 — txt:\'x\'' });
    renderFix(c, parityJob());
    await waitFor(() => expect(screen.getByText(/This draft did not finish/)).toBeInTheDocument());
  });
});

describe('OpsHeldPanel — Fix 5 (substantive hints → physician considerations; RN never hard-blocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postDraftMock.mockResolvedValue({ data: { job: {}, publish: {} } });
    getLetterMock.mockResolvedValue({ data: { txt: LETTER_TXT } } as never);
  });

  it('renders hints as physician CONSIDERATIONS (optional), NOT RN "Fix before sending"', async () => {
    renderFix(fixCase(), hintsJob());
    await waitFor(() => expect(screen.getByText(/Considerations for the physician/i)).toBeInTheDocument());
    expect(screen.queryByText(/Fix before sending/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/do NOT send/i)).not.toBeInTheDocument();
    expect(screen.getByText(/aggravation baseline sentence/i)).toBeInTheDocument();
  });

  it('the RN is NEVER hard-blocked — "Send to doctor for review" stays available with hints present', () => {
    renderFix(fixCase(), hintsJob());
    expect(screen.getByRole('button', { name: /send to doctor for review/i })).toBeEnabled();
  });
});
