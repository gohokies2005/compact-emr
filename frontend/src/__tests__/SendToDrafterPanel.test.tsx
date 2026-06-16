import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendToDrafterPanel } from '../components/SendToDrafterPanel';
import { getChartReadiness, type ChartReadinessResult } from '../api/chart-readiness';
import { postDraft } from '../api/drafter';
import { viewDocument } from '../api/veterans';
import { postManualSummary, type FileReadStatus } from '../api/cases';

vi.mock('../api/chart-readiness', () => ({
  getChartReadiness: vi.fn(),
}));

vi.mock('../api/drafter', () => ({
  postDraft: vi.fn(),
}));

vi.mock('../api/veterans', () => ({
  viewDocument: vi.fn(),
}));

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, postManualSummary: vi.fn() };
});

const readinessMock = vi.mocked(getChartReadiness);
const postDraftMock = vi.mocked(postDraft);
const viewDocumentMock = vi.mocked(viewDocument);
const postManualSummaryMock = vi.mocked(postManualSummary);

const resolvedFileReadStatus: FileReadStatus = {
  id: 'FRS-9',
  caseId: 'CASE-1',
  filePath: 'records/photo.jpg',
  fileSha256: 'a'.repeat(64),
  terminalStatus: 'manual_summary_provided',
  attemptsJson: [],
  manualSummary: 'RN summary',
  manualSummaryAt: '2026-06-11T00:00:00.000Z',
  manualSummaryBy: 'RN-SUB',
  lastCheckedAt: '2026-06-11T00:00:00.000Z',
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
  version: 2,
};

// Mirrors client.test.ts: a real AxiosError so describeApiError takes its axios branch — the same
// shape the interceptor rethrows for non-special-cased statuses (e.g. the assignment-required 400).
function axiosErrorWith(status: number, serverMessage: string): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_RESPONSE');
  err.response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { error: { code: 'bad_request', message: serverMessage } },
  };
  return err;
}

function renderPanel(props: Partial<ComponentProps<typeof SendToDrafterPanel>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<SendToDrafterPanel caseId="CASE-1" {...props} />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  postDraftMock.mockResolvedValue({ data: { job: { id: 'job-1' }, publish: {} } });
});

describe('SendToDrafterPanel', () => {
  it('enables the button and calls postDraft when the chart is ready', async () => {
    readinessMock.mockResolvedValue({ data: { ready: true } });
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Send to Drafter' });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(await screen.findByText('Chart is ready for drafting.')).toBeInTheDocument();

    button.click();
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledWith('CASE-1', {}));
  });

  it('blocks drafting while the chart is still EXTRACTING (OCR done, chunker running) with a clear wait message', async () => {
    // ready (file-read) is TRUE, but the full-read extraction has not finished — the button must
    // still be disabled, because the pre-draft gates read the extracted chart. (Ryan 2026-06-13.)
    readinessMock.mockResolvedValue({ data: { ready: true, extractionState: 'extracting' } });
    renderPanel();

    expect(await screen.findByText('Reading & extracting the full chart…')).toBeInTheDocument();
    expect(screen.getByText(/Wait to draft until the chart finishes building/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Drafter' })).toBeDisabled();
    // It is NOT shown as "ready" while extracting.
    expect(screen.queryByText('Chart is ready for drafting.')).not.toBeInTheDocument();
  });

  it('explains the blocker AND offers an override (never a dead-end) when the chart is not ready', async () => {
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          { filePath: 'records/garbled.pdf', terminalStatus: 'manual_summary_required' },
        ],
      },
    });
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    // The blocker text now NAMES the file (basename of the S3 key) — a bare count was useless (Yorde).
    expect(screen.getByText('garbled.pdf')).toBeInTheDocument();
    // primary button stays disabled, but an OVERRIDE button is always offered (Ryan HARD RULE).
    expect(screen.getByRole('button', { name: 'Send to Drafter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Override and draft anyway' })).toBeEnabled();
    expect(postDraftMock).not.toHaveBeenCalled();
  });

  // ── CLM-BBFCB3F8CE dead-end fixes (2026-06-11) ─────────────────────────────

  it('surfaces the server error message VERBATIM when the draft start fails (assignment required)', async () => {
    readinessMock.mockResolvedValue({ data: { ready: true } });
    postDraftMock.mockRejectedValue(axiosErrorWith(400, 'Assign a physician and an RN liaison before drafting.'));
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Send to Drafter' });
    await waitFor(() => expect(button).not.toBeDisabled());
    button.click();

    // The REAL reason, not "Please retry" (which was guaranteed to fail again).
    expect(
      await screen.findByText(/server returned 400: Assign a physician and an RN liaison before drafting\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('The drafter could not be started. Please retry.')).not.toBeInTheDocument();
  });

  it('gates "Override and draft anyway" on assignment (same as the main button) and shows the assignment hint', async () => {
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          { filePath: 'records/garbled.pdf', terminalStatus: 'manual_summary_required' },
        ],
      },
    });
    renderPanel({ physicianAssigned: false, rnAssigned: false });

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    // The override used to stay enabled while the main button was gated — an invited click that
    // was guaranteed to 400. Both are now gated identically, with the same actionable hint.
    expect(screen.getByRole('button', { name: 'Override and draft anyway' })).toBeDisabled();
    expect(
      screen.getAllByText('Assign a physician and an RN liaison before drafting — use the Assignments panel below.').length,
    ).toBeGreaterThanOrEqual(2); // main-button hint + override hint
  });

  it('renders the blocking file as a clickable link when documentId is present', async () => {
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          { filePath: 'cases/CASE-1/3f2c8a1e-9b4d-4f6a-8c2e-1a2b3c4d5e6f-buddy_statement.pdf', terminalStatus: 'manual_summary_required', documentId: 'DOC-42' },
        ],
      },
    });
    viewDocumentMock.mockResolvedValue({ data: { downloadUrl: 'https://example.test/presigned' } });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    // The filename renders as a BUTTON (clickable link), fed by the joined documentId.
    const link = screen.getByRole('button', { name: 'buddy_statement.pdf' });
    link.click();
    await waitFor(() => expect(viewDocumentMock).toHaveBeenCalledWith('DOC-42'));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://example.test/presigned', '_blank', 'noopener,noreferrer'));
    openSpy.mockRestore();
  });

  it('shows manual-summary guidance (not the re-upload/re-OCR advice) for a too-few-words read', async () => {
    // wordCount 12: genuinely below the (lowered, 20-word) threshold. A 37-word file is now
    // retro-healed server-side and never reaches this UI.
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          {
            filePath: 'records/photo.jpg',
            terminalStatus: 'manual_summary_required',
            documentId: 'DOC-7',
            lastAttempt: { method: 'textract', wordCount: 12, corruptedTokenRatio: 0, note: 'too-few-words (12 < 20)' },
          },
        ],
      },
    });
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    // Class-specific advice: re-running OCR on a near-empty image is a dead-end; a manual summary is
    // the fix — and the guidance points at the inline form BELOW, not at the chart (Ryan 2026-06-11).
    expect(
      screen.getByText(/This image has too little text to auto-read \(12 words\)\. Open the document and add a brief manual summary below, or draft anyway\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Re-upload it or re-run OCR/)).not.toBeInTheDocument();
  });

  // ── 2026-06-11 addendum: inline manual-summary form + stateful override reason ────────────

  it('renders the ManualSummaryForm inline for a manual_summary_required blocker; saving clears the banner live', async () => {
    readinessMock.mockResolvedValueOnce({
      data: {
        ready: false,
        blockingFiles: [
          {
            filePath: 'records/photo.jpg',
            terminalStatus: 'manual_summary_required',
            fileReadStatusId: 'FRS-9',
            documentId: 'DOC-7',
            lastAttempt: { method: 'textract', wordCount: 12, corruptedTokenRatio: 0, note: 'too-few-words (12 < 20)' },
          },
        ],
      },
    });
    // After the form's success invalidation, the refetch reports ready — the banner must clear live.
    readinessMock.mockResolvedValue({ data: { ready: true } });
    postManualSummaryMock.mockResolvedValue({ data: resolvedFileReadStatus });
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    // The form is RIGHT AT THE ALERT — no trip to the Documents tab.
    const textarea = screen.getByPlaceholderText(/Read the file and summarize/);
    const save = screen.getByRole('button', { name: 'Save summary' });

    // Client-side mirror of the server's >= 40-char gate: short summary cannot submit.
    fireEvent.change(textarea, { target: { value: 'too short' } });
    expect(save).toBeDisabled();

    const summary = 'Photo of a CPAP usage report — 7.1 hrs/night average use, AHI 4.2, dated March 2026.';
    fireEvent.change(textarea, { target: { value: summary } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => expect(postManualSummaryMock).toHaveBeenCalledWith('CASE-1', 'FRS-9', { summary }));
    // Success invalidates the chart-readiness query → banner flips to ready without a reload.
    expect(await screen.findByText('Chart is ready for drafting.')).toBeInTheDocument();
    expect(screen.queryByText('Chart is not ready for drafting')).not.toBeInTheDocument();
  });

  // ── FIX 1 (2026-06-14): auto-resume dead-spot ───────────────────────────────
  // The 202 "preparing" auto-remediation arms an auto-resume that MUST fire the real draft itself once
  // the chart reaches chart_ready — "click once and walk away." The guard was tautological
  // (gated on !stillBuilding where stillBuilding folds in the armed flag itself), so the auto-submit
  // could PHYSICALLY never fire and the panel stalled forever on "Reading the documents…".
  it('AUTO-RESUMES the draft exactly once when a 202 preparing chart reaches chart_ready (no human click)', async () => {
    // Drive the readiness transitions via react-query invalidation (the 202 onSuccess invalidates; we
    // invalidate again for the extracting→ready step) — no fake timers, which fight testing-library's
    // waitFor. The states the panel observes in order:
    //   1) not ready, settled  → the override button is the human's ONE click
    //   2) extracting          → button disabled, auto-resume armed + waiting (buildingFromExtraction)
    //   3) chart_ready         → auto-resume fires the draft ITSELF
    readinessMock
      .mockResolvedValueOnce({ data: { ready: false, blockingFiles: [{ filePath: 'records/x.pdf', terminalStatus: 'manual_summary_required' }] } })
      .mockResolvedValueOnce({ data: { ready: false, extractionState: 'extracting' } })
      .mockResolvedValue({ data: { ready: true, extractionState: 'chart_ready' } });
    // First POST (the human override click) returns 202 preparing; any later POST is the auto-resume.
    postDraftMock
      .mockResolvedValueOnce({ data: { preparing: true } })
      .mockResolvedValue({ data: { job: { id: 'job-1' }, publish: {} } });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    // No claimedCondition → gate1 disabled → the override drafts directly (no modal to drive).
    render(<SendToDrafterPanel caseId="CASE-1" />, { wrapper: Wrapper });

    // The human's ONE click: open the override, type a reason, start the draft.
    fireEvent.click(await screen.findByRole('button', { name: 'Override and draft anyway' }));
    fireEvent.change(screen.getByPlaceholderText('What does the file show?'), { target: { value: 'ResMed report — 7.1 hrs/night, AHI 4.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Override and start draft' }));

    // 202 preparing → arms auto-resume + invalidates readiness (refetch #2 → extracting).
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledTimes(1));
    await screen.findByText('Reading & extracting the full chart…');

    // The next poll/refetch flips readiness to chart_ready → the effect auto-submits with no human click.
    await queryClient.invalidateQueries({ queryKey: ['case', 'CASE-1', 'chart-readiness'] });

    await waitFor(() => expect(postDraftMock).toHaveBeenCalledTimes(2));
    // It carried the ORIGINAL override args, not a bare {}.
    expect(postDraftMock).toHaveBeenLastCalledWith('CASE-1', { acknowledgeMissingDocs: true, overrideReason: 'ResMed report — 7.1 hrs/night, AHI 4.2' });
    // And it auto-submits EXACTLY once — no double-fire across the chart_ready re-renders.
    await queryClient.invalidateQueries({ queryKey: ['case', 'CASE-1', 'chart-readiness'] });
    await waitFor(() => expect(readinessMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(postDraftMock).toHaveBeenCalledTimes(2);
  });

  it('override reason survives a failed POST (stateful textarea, not window.prompt)', async () => {
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          { filePath: 'records/garbled.pdf', terminalStatus: 'manual_summary_required' },
        ],
      },
    });
    postDraftMock.mockRejectedValue(axiosErrorWith(400, 'Assign a physician and an RN liaison before drafting.'));
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Override and draft anyway' }));

    const reason = 'ResMed usage report — 7.1 hrs/night, AHI 4.2';
    const textarea = screen.getByPlaceholderText('What does the file show?');
    fireEvent.change(textarea, { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: 'Override and start draft' }));

    await waitFor(() =>
      expect(postDraftMock).toHaveBeenCalledWith('CASE-1', { acknowledgeMissingDocs: true, overrideReason: reason }),
    );
    // The POST failed — the typed reason MUST still be there (window.prompt lost it; state doesn't).
    expect(await screen.findByText(/server returned 400: Assign a physician and an RN liaison/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What does the file show?')).toHaveValue(reason);
  });
});

// ── CHARACTERIZATION: the draft-gating contract (Phase 2 readiness-lift safety net, 2026-06-16) ──
// Pins the Send-button disabled state + the banner for every readiness state BEFORE the chart-readiness
// query is lifted into a shared hook. Must stay GREEN through the lift — RED only if the refactor
// changes gating. Row "extract_failed" is the P0 anti-hollow-letter cell (ready:true but the extraction
// FAILED must keep the button disabled) — do NOT simplify it away.
describe('SendToDrafterPanel — draft-gating characterization matrix', () => {
  const rows: Array<{ name: string; fixture: ChartReadinessResult; disabled: boolean; banner: string }> = [
    { name: 'ready', fixture: { ready: true }, disabled: false, banner: 'Chart is ready for drafting.' },
    { name: 'ready + chart_ready', fixture: { ready: true, extractionState: 'chart_ready' }, disabled: false, banner: 'Chart is ready for drafting.' },
    { name: 'extracting (full-read running)', fixture: { ready: true, extractionState: 'extracting' }, disabled: true, banner: 'Reading & extracting the full chart…' },
    { name: 'ocr_in_progress', fixture: { ready: false, extractionState: 'ocr_in_progress' }, disabled: true, banner: 'Reading the documents…' },
    { name: 'P0: extract_failed (ready:true but FAILED → disabled)', fixture: { ready: true, extractionState: 'extract_failed' }, disabled: true, banner: 'Chart extraction failed' },
    { name: 'not ready (blocking file)', fixture: { ready: false, blockingFiles: [{ filePath: 'records/x.pdf', terminalStatus: 'manual_summary_required' }] }, disabled: true, banner: 'Chart is not ready for drafting' },
    { name: 'not ready (reason, no blocker)', fixture: { ready: false, reason: 'pending records' }, disabled: true, banner: 'Chart is not ready for drafting' },
    { name: 'ready with gaps', fixture: { ready: true, extractionGaps: { uncoveredPages: 3, truncatedWindows: 1 } }, disabled: false, banner: 'Chart is ready — but part of the record went unread' },
  ];

  it.each(rows)('$name → banner shown + Send disabled=$disabled', async ({ fixture, disabled, banner }) => {
    readinessMock.mockResolvedValue({ data: fixture });
    renderPanel();
    expect(await screen.findByText(banner)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to Drafter' });
    if (disabled) await waitFor(() => expect(button).toBeDisabled());
    else await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('P0: extract_failed still offers the override (never a dead-end)', async () => {
    readinessMock.mockResolvedValue({ data: { ready: true, extractionState: 'extract_failed' } });
    renderPanel();
    expect(await screen.findByText('Chart extraction failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Override/ })).toBeInTheDocument();
  });

  it('ready + unassigned → Send disabled + assignment hint', async () => {
    readinessMock.mockResolvedValue({ data: { ready: true } });
    renderPanel({ physicianAssigned: false, rnAssigned: false });
    const button = await screen.findByRole('button', { name: 'Send to Drafter' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getAllByText(/Assign a physician and an RN liaison before drafting/).length).toBeGreaterThanOrEqual(1);
  });
});
