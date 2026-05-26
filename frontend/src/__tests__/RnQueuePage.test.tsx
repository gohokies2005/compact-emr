import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RnQueuePage } from '../routes/rn/RnQueuePage';
import { ConflictError } from '../api/client';
import {
  listFilesPendingManualGlobal,
  postManualSummary,
  type FileReadStatus,
} from '../api/cases';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return {
    ...actual,
    listFilesPendingManualGlobal: vi.fn(),
    postManualSummary: vi.fn(),
  };
});

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../lib/date', () => ({
  formatRelativeTime: (value: string) => value,
}));

const listMock = vi.mocked(listFilesPendingManualGlobal);
const postMock = vi.mocked(postManualSummary);

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
  it('renders the pending list and the total count', async () => {
    renderQueue();
    expect(await screen.findByText(/2 file\(s\) pending across all cases/)).toBeInTheDocument();
    expect(screen.getByText('records/garbled_scan.pdf')).toBeInTheDocument();
    expect(screen.getByText('records/old_photocopy.pdf')).toBeInTheDocument();
  });

  it('shows the empty state when the queue is clear', async () => {
    listMock.mockResolvedValueOnce({ data: [], total: 0 });
    renderQueue();
    expect(await screen.findByText('Queue is clear')).toBeInTheDocument();
  });

  it('clicking a row selects it and shows read-attempt history', async () => {
    renderQueue();
    await screen.findByText('records/garbled_scan.pdf');
    fireEvent.click(screen.getByText('records/garbled_scan.pdf'));
    expect(await screen.findByText('Why machine reads failed')).toBeInTheDocument();
    // The lastCheckedAt timestamp appears in two places (list + detail). Pick the detail one
    // by searching for its surrounding text.
    expect(screen.getByText(/awaiting manual summary since/)).toBeInTheDocument();
  });

  it('Save summary is disabled until the summary is >= 40 chars', async () => {
    renderQueue();
    await screen.findByText('records/garbled_scan.pdf');
    fireEvent.click(screen.getByText('records/garbled_scan.pdf'));
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
    await screen.findByText('records/garbled_scan.pdf');
    fireEvent.click(screen.getByText('records/garbled_scan.pdf'));
    const textarea = await screen.findByPlaceholderText(/Read the file and summarize/);
    const summaryText = 'Rating decision dated 2024 — service connection granted for PTSD at 70 percent.';
    fireEvent.change(textarea, { target: { value: `   ${summaryText}   ` } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('CASE-A', 'FRS-1', { summary: summaryText });
    });
  });

  it('on 409 ConflictError, shows "no longer awaiting" message', async () => {
    postMock.mockRejectedValueOnce(new ConflictError());
    renderQueue();
    await screen.findByText('records/garbled_scan.pdf');
    fireEvent.click(screen.getByText('records/garbled_scan.pdf'));
    const textarea = await screen.findByPlaceholderText(/Read the file and summarize/);
    fireEvent.change(textarea, { target: { value: 'A valid forty-character summary written by the RN reviewer.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save summary/i }));
    expect(await screen.findByText(/no longer awaiting manual summary/)).toBeInTheDocument();
  });
});
