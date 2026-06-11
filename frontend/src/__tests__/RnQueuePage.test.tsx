import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RnQueuePage } from '../routes/rn/RnQueuePage';
import { ConflictError } from '../api/client';
import {
  listFilesPendingManualGlobal,
  postManualSummary,
  type FileReadStatus,
} from '../api/cases';
import { viewDocument } from '../api/veterans';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return {
    ...actual,
    listFilesPendingManualGlobal: vi.fn(),
    postManualSummary: vi.fn(),
  };
});

// Presigned inline open for the clickable queue filename (Package 1 (J)).
vi.mock('../api/veterans', () => ({
  viewDocument: vi.fn(),
}));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../lib/date', () => ({
  formatRelativeTime: (value: string) => value,
}));

const listMock = vi.mocked(listFilesPendingManualGlobal);
const postMock = vi.mocked(postManualSummary);
const viewDocMock = vi.mocked(viewDocument);

const row1: FileReadStatus = {
  id: 'FRS-1',
  caseId: 'CASE-A',
  filePath: 'records/garbled_scan.pdf',
  fileSha256: 'a'.repeat(64),
  terminalStatus: 'manual_summary_required',
  attemptsJson: [
    { method: 'native_pdf_text', wordCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-05-25T10:00:00.000Z', note: 'too-few-words (5 < 40)' },
    { method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.21, attemptedAt: '2026-05-25T10:05:00.000Z', note: 'garbled (corrupted-token-ratio=0.210 > 0.08)' },
  ],
  manualSummary: null,
  manualSummaryAt: null,
  manualSummaryBy: null,
  lastCheckedAt: '2026-05-25T10:05:00.000Z',
  createdAt: '2026-05-25T10:00:00.000Z',
  updatedAt: '2026-05-25T10:05:00.000Z',
  version: 1,
};

const row2: FileReadStatus = { ...row1, id: 'FRS-2', caseId: 'CASE-B', filePath: 'records/old_photocopy.pdf' };

function renderQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><RnQueuePage /></MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ data: [row1, row2], total: 2 });
  postMock.mockResolvedValue({ data: { ...row1, terminalStatus: 'manual_summary_provided', manualSummary: 'Summary written by RN.', manualSummaryAt: '2026-05-25T12:00:00.000Z', manualSummaryBy: 'RN-SUB' } });
});

describe('RnQueuePage', () => {
  it('renders the pending list and the total count (abbreviated filenames, not raw S3 paths)', async () => {
    renderQueue();
    expect(await screen.findByText(/2 file\(s\) pending across all cases/)).toBeInTheDocument();
    expect(screen.getByText('garbled_scan.pdf')).toBeInTheDocument();
    expect(screen.getByText('old_photocopy.pdf')).toBeInTheDocument();
    // The raw path never renders — the basename is the human name.
    expect(screen.queryByText('records/garbled_scan.pdf')).not.toBeInTheDocument();
  });

  it('shows the empty state when the queue is clear', async () => {
    listMock.mockResolvedValueOnce({ data: [], total: 0 });
    renderQueue();
    expect(await screen.findByText('Queue is clear')).toBeInTheDocument();
  });

  it('clicking a row selects it and shows read-attempt history', async () => {
    renderQueue();
    await screen.findByText('garbled_scan.pdf');
    fireEvent.click(screen.getByText('garbled_scan.pdf'));
    expect(await screen.findByText('Why machine reads failed')).toBeInTheDocument();
    // The lastCheckedAt timestamp appears in two places (list + detail). Pick the detail one
    // by searching for its surrounding text.
    expect(screen.getByText(/awaiting manual summary since/)).toBeInTheDocument();
  });

  it('Save summary is disabled until the summary is >= 40 chars', async () => {
    renderQueue();
    await screen.findByText('garbled_scan.pdf');
    fireEvent.click(screen.getByText('garbled_scan.pdf'));
    const button = await screen.findByRole('button', { name: /Save summary/i });
    expect(button).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/Read the file and summarize/);
    fireEvent.change(textarea, { target: { value: 'short' } });
    expect(button).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'A'.repeat(45) } });
    expect(button).not.toBeDisabled();
  });

  it('saving calls postManualSummary with the case + file ids and the trimmed summary', async () => {
    renderQueue();
    await screen.findByText('garbled_scan.pdf');
    fireEvent.click(screen.getByText('garbled_scan.pdf'));
    const textarea = await screen.findByPlaceholderText(/Read the file and summarize/);
    const summaryText = 'Rating decision dated 2024 — service connection granted for PTSD at 70 percent.';
    fireEvent.change(textarea, { target: { value: `   ${summaryText}   ` } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('CASE-A', 'FRS-1', { summary: summaryText });
    });
  });

  it('routes non-409 errors through describeApiError (server message, not "Request failed with status code 400")', async () => {
    const err = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST');
    err.response = {
      status: 400,
      statusText: '',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: { code: 'bad_request', message: 'summary must be at least 40 characters (FRN HARD RULE; manual interpretation must convey actual content)' } },
    };
    postMock.mockRejectedValueOnce(err);
    renderQueue();
    await screen.findByText('garbled_scan.pdf');
    fireEvent.click(screen.getByText('garbled_scan.pdf'));
    const textarea = await screen.findByPlaceholderText(/Read the file and summarize/);
    fireEvent.change(textarea, { target: { value: 'A valid forty-character summary written by the RN reviewer.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));
    // The server's own reason, not the raw axios message.
    expect(await screen.findByText(/server returned 400: summary must be at least 40 characters/)).toBeInTheDocument();
    expect(screen.queryByText('Request failed with status code 400')).not.toBeInTheDocument();
  });

  it('on 409 ConflictError, shows "no longer awaiting" message', async () => {
    postMock.mockRejectedValueOnce(new ConflictError());
    renderQueue();
    await screen.findByText('garbled_scan.pdf');
    fireEvent.click(screen.getByText('garbled_scan.pdf'));
    const textarea = await screen.findByPlaceholderText(/Read the file and summarize/);
    fireEvent.change(textarea, { target: { value: 'A valid forty-character summary written by the RN reviewer.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));
    expect(await screen.findByText(/no longer awaiting manual summary/)).toBeInTheDocument();
  });

  // ── Package 1 (J), 2026-06-11: enriched queue rows — WHO + WHAT + clickable file ────────────
  // The /rn/files-pending-manual payload now carries veteranName, claimedCondition, documentId
  // and the server-abbreviated fileName (s3 keys are cases/<caseId>/<uuid>-<OriginalName.ext>).

  const enrichedRow: FileReadStatus = {
    ...row1,
    id: 'FRS-3',
    caseId: 'CASE-C',
    filePath: 'cases/CASE-C/123e4567-e89b-42d3-a456-426614174000-Sleep_Study_Photo.jpg',
    veteranName: 'Yorde, Robert',
    claimedCondition: 'OSA',
    documentId: 'DOC-77',
    fileName: 'Sleep_Study_Photo.jpg',
  };

  it('renders veteran name + claimed condition and the abbreviated fileName on an enriched row', async () => {
    listMock.mockResolvedValueOnce({ data: [enrichedRow], total: 1 });
    renderQueue();
    expect(await screen.findByText('Yorde, Robert')).toBeInTheDocument();
    expect(screen.getByText(/OSA/)).toBeInTheDocument();
    // The abbreviated filename, never the uuid-prefixed S3 key.
    expect(screen.getByText('Sleep_Study_Photo.jpg')).toBeInTheDocument();
    expect(screen.queryByText(/123e4567/)).not.toBeInTheDocument();
  });

  it('clicking the filename calls viewDocument(documentId) and opens the presigned URL — without selecting the row', async () => {
    listMock.mockResolvedValueOnce({ data: [enrichedRow], total: 1 });
    viewDocMock.mockResolvedValueOnce({ data: { downloadUrl: 'https://s3.example/presigned' } });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderQueue();
    // The inner filename button's accessible name is the bare filename; the row container is
    // "Select Sleep_Study_Photo.jpg" — exact-match picks the link, not the row.
    fireEvent.click(await screen.findByRole('button', { name: 'Sleep_Study_Photo.jpg' }));
    await waitFor(() => {
      expect(viewDocMock).toHaveBeenCalledWith('DOC-77');
      expect(openSpy).toHaveBeenCalledWith('https://s3.example/presigned', '_blank', 'noopener,noreferrer');
    });
    // stopPropagation: opening the file must not select the row (no detail form).
    expect(screen.queryByText('Why machine reads failed')).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('falls back to plain text (no link) when the row has no documentId', async () => {
    renderQueue(); // default rows carry no documentId / no enrichment
    await screen.findByText('garbled_scan.pdf');
    expect(screen.queryByRole('button', { name: 'garbled_scan.pdf' })).not.toBeInTheDocument();
  });

  it('detail header shows the enriched context and stays compatible with the inline ManualSummaryForm', async () => {
    listMock.mockResolvedValue({ data: [enrichedRow], total: 1 });
    renderQueue();
    // Select via the row container (the filename button opens the doc instead).
    fireEvent.click(await screen.findByRole('button', { name: 'Select Sleep_Study_Photo.jpg' }));
    expect(await screen.findByText('Why machine reads failed')).toBeInTheDocument();
    expect(screen.getByText(/Yorde, Robert · Case CASE-C · OSA/)).toBeInTheDocument();
    // The form still posts with caseId + fileReadStatusId.
    const textarea = screen.getByPlaceholderText(/Read the file and summarize/);
    fireEvent.change(textarea, { target: { value: 'ResMed compliance photo: usage 7.1 hrs/night, AHI 4.2, dated March 2026.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('CASE-C', 'FRS-3', { summary: 'ResMed compliance photo: usage 7.1 hrs/night, AHI 4.2, dated March 2026.' });
    });
  });
});
