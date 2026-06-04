import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LetterEditorPage } from '../routes/cases/LetterEditorPage';
import { applySurgicalAi, approveLetter, declineLetter, getLetter, previewSurgicalAi, saveLetter } from '../api/letter';
import { getCase } from '../api/cases';
import { ConflictError, ServiceUnavailableError } from '../api/client';

vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { readonly children: ReactNode }) => <div>{children}</div> }));
vi.mock('../api/letter', () => ({ getLetter: vi.fn(), saveLetter: vi.fn(), previewSurgicalAi: vi.fn(), applySurgicalAi: vi.fn(), approveLetter: vi.fn(), declineLetter: vi.fn() }));
vi.mock('../api/cases', () => ({ getCase: vi.fn() }));

const getLetterMock = vi.mocked(getLetter);
const getCaseMock = vi.mocked(getCase);
const saveLetterMock = vi.mocked(saveLetter);
const previewMock = vi.mocked(previewSurgicalAi);
const applyMock = vi.mocked(applySurgicalAi);
const approveMock = vi.mocked(approveLetter);
const declineMock = vi.mocked(declineLetter);

const opsLetter = {
  version: 4,
  txt: 'This is **bold** letter text.',
  locked_ranges: [{ start: 0, end: 4, label: 'header' }],
  rendered: { pdfUrl: 'https://example.com/final.pdf', docxUrl: 'https://example.com/final.docx' },
  role: 'ops_staff' as const,
};
const physicianLetter = { ...opsLetter, role: 'physician' as const };
// The opaque structured proposal the proposer returns + we echo back to apply.
const PROPOSAL = { operation: 'replace' as const, anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/cases/CASE-1/letter']}>
        <Routes><Route path="/cases/:id/letter" element={<LetterEditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getLetterMock.mockResolvedValue({ data: opsLetter });
  // The editor title is now the filename (Lastname_Firstname_COND_vN), built from the case detail.
  getCaseMock.mockResolvedValue({ data: { veteran: { firstName: 'Armand', lastName: 'Frank' }, claimedCondition: 'Obstructive Sleep Apnea' } } as unknown as Awaited<ReturnType<typeof getCase>>);
  saveLetterMock.mockResolvedValue({ data: { version: 5, txt: 'Saved letter text.', warnings: [{ rule: 'short_letter', detail: 'Letter appears unusually short.' }] } });
  previewMock.mockResolvedValue({ data: { proposal: PROPOSAL, preview: 'Preview of the limited edit.', warnings: [], costUsd: 0.42, model: 'claude-opus-4-8' } });
  applyMock.mockResolvedValue({ data: { version: 6, txt: 'Applied limited edit.', warnings: [] } });
  approveMock.mockResolvedValue({ data: { version: 5, status: 'delivered', finalPdfKey: 'drafter-artifacts/CASE-1/v5/letter.pdf' } });
  declineMock.mockResolvedValue({ data: { status: 'correction_requested' } });
});

describe('LetterEditorPage', () => {
  it('loads and renders the editor (ops_staff) WITH surgical-AI parity but NO sign-off', async () => {
    renderPage();
    expect(await screen.findByText('Frank_Armand_OSA_v4')).toBeInTheDocument();
    expect(screen.getByText('Version 4 · ops_staff')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeInTheDocument();
    // RN parity (Ryan 2026-06-04): ops_staff now gets the AI surgical-edit card...
    expect(screen.getByText('AI surgical edit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview limited edit' })).toBeInTheDocument();
    // ...but never the physician-only sign-off actions.
    expect(screen.queryByRole('button', { name: 'Approve letter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline and send back to RN' })).not.toBeInTheDocument();
  });

  it('saves a new version and shows rule/detail warnings', async () => {
    renderPage();
    await screen.findByText('Frank_Armand_OSA_v4');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() => { expect(saveLetterMock).toHaveBeenCalledWith('CASE-1', { base_version: 4, txt: 'This is **bold** letter text.' }); });
    expect(await screen.findByText('Saved version 5.')).toBeInTheDocument();
    expect(screen.getByText('Letter appears unusually short.')).toBeInTheDocument();
  });

  it('reloads on a stale save (ConflictError)', async () => {
    saveLetterMock.mockRejectedValueOnce(new ConflictError());
    renderPage();
    await screen.findByText('Frank_Armand_OSA_v4');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText('This letter was changed elsewhere. Reloaded the latest version.')).toBeInTheDocument();
    expect(getLetterMock).toHaveBeenCalledTimes(2);
  });

  it('shows "not available" on a 503 save', async () => {
    saveLetterMock.mockRejectedValueOnce(new ServiceUnavailableError());
    renderPage();
    await screen.findByText('Frank_Armand_OSA_v4');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText('Letter service is not available in this environment.')).toBeInTheDocument();
  });

  it('physician previews + applies surgical AI (opaque proposal + string preview)', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.change(screen.getByPlaceholderText('Example: remove the second alternative-etiology sentence.'), { target: { value: 'Tighten rationale.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview limited edit' }));
    expect(await screen.findByText('Proposed edit · $0.42')).toBeInTheDocument();
    expect(screen.getByText('Preview of the limited edit.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit' }));
    await waitFor(() => { expect(applyMock).toHaveBeenCalledWith('CASE-1', PROPOSAL); });
  });

  it('shows "not available" on a 503 surgical-AI preview', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    previewMock.mockRejectedValueOnce(new ServiceUnavailableError());
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.change(screen.getByPlaceholderText('Example: remove the second alternative-etiology sentence.'), { target: { value: 'Tighten rationale.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview limited edit' }));
    expect(await screen.findByText('Surgical AI is not available in this environment.')).toBeInTheDocument();
  });

  it('physician approves the letter', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Approve letter' }));
    await waitFor(() => { expect(approveMock).toHaveBeenCalledWith('CASE-1'); });
  });

  it('physician declines and sends back to RN', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Decline and send back to RN' }));
    fireEvent.change(screen.getByPlaceholderText('Tell the RN what needs to change.'), { target: { value: 'Needs a different approach.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    await waitFor(() => { expect(declineMock).toHaveBeenCalledWith('CASE-1', { reason: 'Needs a different approach.' }); });
  });
});
