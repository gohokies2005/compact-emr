import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LetterEditorPage } from '../routes/cases/LetterEditorPage';
import { applySurgicalAi, approveLetter, declineLetter, finalizeImportLetter, getLetter, previewSurgicalAi, saveLetter } from '../api/letter';
import { getCase, signOffCase } from '../api/cases';
import { ConflictError, ServiceUnavailableError } from '../api/client';

vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { readonly children: ReactNode }) => <div>{children}</div> }));
vi.mock('../api/letter', () => ({ getLetter: vi.fn(), saveLetter: vi.fn(), previewSurgicalAi: vi.fn(), applySurgicalAi: vi.fn(), approveLetter: vi.fn(), declineLetter: vi.fn(), finalizeImportLetter: vi.fn() }));
// signOffCase is exercised by the SignOffPopup the Approve button now opens (architect fix 2026-06-08).
vi.mock('../api/cases', () => ({ getCase: vi.fn(), signOffCase: vi.fn() }));

const getLetterMock = vi.mocked(getLetter);
const getCaseMock = vi.mocked(getCase);
const saveLetterMock = vi.mocked(saveLetter);
const previewMock = vi.mocked(previewSurgicalAi);
const applyMock = vi.mocked(applySurgicalAi);
const approveMock = vi.mocked(approveLetter);
const declineMock = vi.mocked(declineLetter);
const finalizeImportMock = vi.mocked(finalizeImportLetter);
const signOffMock = vi.mocked(signOffCase);

// findByText under the FULL suite's parallel load can exceed the 1000ms default poll window
// (the mutation chain: mutate -> mock resolve -> onSuccess/onError -> setState -> re-render).
// A generous explicit timeout makes these deterministic without weakening any assertion.
const FIND = { timeout: 5000 } as const;

const opsLetter = {
  version: 4,
  txt: 'This is **bold** letter text.',
  locked_ranges: [{ start: 0, end: 4, label: 'header' }],
  rendered: { pdfUrl: 'https://example.com/final.pdf', docxUrl: 'https://example.com/final.docx' },
  role: 'ops_staff' as const,
};
const physicianLetter = { ...opsLetter, role: 'physician' as const };
// An imported letter (current revision source='external_import') is finalized AS-IS, never approved.
const importedPhysicianLetter = { ...opsLetter, role: 'physician' as const, source: 'external_import' as const };
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
  // WarningList NOISE CUT (Ryan 2026-06-23): only the MEANINGFUL categories (placeholder token, locked-block
  // mod) surface; cosmetic ones (em-dash, jargon, banned-word, sentence-variance) are dropped. The mock carries
  // one of EACH so the test can assert the filter both ways.
  saveLetterMock.mockResolvedValue({ data: { version: 5, txt: 'Saved letter text.', warnings: [
    { rule: 'placeholder_token_introduced', detail: 'bracketed scaffolding token (e.g. [VERIFY ...]) — never ship in a finished letter' },
    { rule: 'em_dash_introduced', detail: 'new em dashes (banned per FRN letter style)' },
  ] } });
  previewMock.mockResolvedValue({ data: { proposal: PROPOSAL, preview: 'Preview of the limited edit.', warnings: [], costUsd: 0.42, model: 'claude-opus-4-8' } });
  applyMock.mockResolvedValue({ data: { version: 6, txt: 'Applied limited edit.', warnings: [] } });
  approveMock.mockResolvedValue({ data: { version: 5, status: 'delivered', finalPdfKey: 'drafter-artifacts/CASE-1/v5/letter.pdf' } });
  declineMock.mockResolvedValue({ data: { status: 'correction_requested' } });
  finalizeImportMock.mockResolvedValue({ data: { version: 4, status: 'delivered', signOffId: 'SO-IMP', finalPdfKey: 'drafter-artifacts/CASE-1/v4/imported-letter.pdf', source: 'external_import' } });
  signOffMock.mockResolvedValue({ data: { id: 'SO-1', caseId: 'CASE-1' } as unknown as Awaited<ReturnType<typeof signOffCase>>['data'] });
});

// Drives the SignOffPopup the Approve button opens: answer all 5 questions "Yes", submit.
async function completeSignOff() {
  // The popup renders one "Yes" button per attestation (5) plus a final "Submit sign-off".
  const yesButtons = await screen.findAllByRole('button', { name: 'Yes' }, FIND);
  for (const btn of yesButtons) fireEvent.click(btn);
  fireEvent.click(screen.getByRole('button', { name: 'Submit sign-off' }));
}

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

  // Save is disabled until the loaded version commits (a post-paint useEffect sets baseVersion).
  // Clicking before that throws "Letter version is missing" and the save mock is never called —
  // THE flake. Wait for the ENABLED button, then click, so the mutation actually fires.
  async function clickSave() {
    const saveBtn = await screen.findByRole('button', { name: 'Save new version' }, FIND);
    await waitFor(() => expect(saveBtn).toBeEnabled(), FIND);
    fireEvent.click(saveBtn);
  }

  it('saves a new version and shows ONLY the meaningful warnings (drops cosmetic em-dash etc.)', async () => {
    renderPage();
    await clickSave();
    await waitFor(() => { expect(saveLetterMock).toHaveBeenCalledWith('CASE-1', { base_version: 4, txt: 'This is **bold** letter text.' }); }, FIND);
    expect(await screen.findByText('Saved version 5.', undefined, FIND)).toBeInTheDocument();
    // KEPT: the placeholder-token finding (a real "looks broken" defect) shows.
    expect(screen.getByText(/bracketed scaffolding token/)).toBeInTheDocument();
    // DROPPED: the cosmetic em-dash finding is filtered out of the RN-facing list.
    expect(screen.queryByText(/new em dashes/)).not.toBeInTheDocument();
  });

  // Ryan 2026-07-10 (Conyers CLM-44742B4040 — a physician edit was silently lost): a stale-version 409
  // must NOT silently reload + clobber the typed text. It must PRESERVE the edit and surface a blocking
  // conflict choice (save-my-changes-onto-latest / discard). The old "Reloaded the latest version" clobber
  // is gone.
  it('preserves the edit + surfaces a save-conflict (no silent reload/clobber) on a stale save', async () => {
    saveLetterMock.mockRejectedValueOnce(new ConflictError());
    renderPage();
    await clickSave();

    // Blocking conflict modal appears; the physician's text was NOT reloaded over.
    expect(await screen.findByText('This letter changed while you were editing', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText(/Your changes are still in the editor/)).toBeInTheDocument();
    // The old silent-clobber message is gone.
    expect(screen.queryByText('This letter was changed elsewhere. Reloaded the latest version.')).toBeNull();

    // "Save my changes" re-saves the preserved text onto the LATEST base_version (4 here → creates v5).
    fireEvent.click(screen.getByRole('button', { name: /Save my changes as version 5/ }));
    await waitFor(() => expect(saveLetterMock).toHaveBeenLastCalledWith('CASE-1', expect.objectContaining({ base_version: 4 })));
    // On success the conflict clears.
    await waitFor(() => expect(screen.queryByText('This letter changed while you were editing')).toBeNull());
  });

  it('shows "not available" on a 503 save', async () => {
    saveLetterMock.mockRejectedValueOnce(new ServiceUnavailableError());
    renderPage();
    await clickSave();
    expect(await screen.findByText('Letter service is not available in this environment.', undefined, FIND)).toBeInTheDocument();
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

  it('physician approves via sign-off: Approve opens the sign-off popup, signing off finalizes', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    // The bare Approve no longer calls /approve directly (that 409'd sign_off_required). It opens
    // the sign-off popup; approve fires only AFTER a complete sign-off. (architect fix 2026-06-08.)
    fireEvent.click(screen.getByRole('button', { name: 'Approve letter' }));
    expect(await screen.findByText('Physician sign-off', undefined, FIND)).toBeInTheDocument();
    expect(approveMock).not.toHaveBeenCalled(); // not until the physician signs off
    await completeSignOff();
    await waitFor(() => { expect(signOffMock).toHaveBeenCalledWith('CASE-1', expect.objectContaining({ answers: expect.objectContaining({ records_reviewed: true }) })); });
    await waitFor(() => { expect(approveMock).toHaveBeenCalledWith('CASE-1'); });
  });

  // ── Imported letter: finalize AS-IS (no re-render) — import deliver-as-is, 2026-06-14 ──────────
  it('imported letter shows "Finalize for delivery (as-is, no re-render)" instead of Approve', async () => {
    getLetterMock.mockResolvedValueOnce({ data: importedPhysicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    expect(screen.getByRole('button', { name: 'Finalize for delivery (as-is, no re-render)' })).toBeInTheDocument();
    // The normal Approve (which re-renders) must NOT be offered for an imported letter.
    expect(screen.queryByRole('button', { name: 'Approve letter' })).not.toBeInTheDocument();
  });

  it('finalize-as-is opens the sign-off popup and calls finalizeImportLetter (never approveLetter)', async () => {
    getLetterMock.mockResolvedValueOnce({ data: importedPhysicianLetter });
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Finalize for delivery (as-is, no re-render)' }));
    // The popup reads as a finalize step (custom title + submit label).
    expect(await screen.findByText('Finalize imported letter', undefined, FIND)).toBeInTheDocument();
    const yesButtons = await screen.findAllByRole('button', { name: 'Yes' }, FIND);
    for (const btn of yesButtons) fireEvent.click(btn);
    fireEvent.click(screen.getByRole('button', { name: 'Finalize for delivery' }));
    await waitFor(() => { expect(finalizeImportMock).toHaveBeenCalledWith('CASE-1', expect.objectContaining({ answers: expect.objectContaining({ records_reviewed: true }) })); });
    // The imported PDF is delivered as-is — the re-rendering approve path must never fire.
    expect(approveMock).not.toHaveBeenCalled();
    expect(signOffMock).not.toHaveBeenCalled(); // finalize binds its OWN sign-off (to the PDF), not POST /sign-off
  });

  it('approve onError splits by reason: 409 sign_off_required → actionable copy', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    // Backend maps a missing sign-off to 409 { reason: 'sign_off_required' } → ConflictError(details).
    approveMock.mockRejectedValueOnce(new ConflictError({ reason: 'sign_off_required' }));
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Approve letter' }));
    await screen.findByText('Physician sign-off', undefined, FIND);
    await completeSignOff();
    expect(await screen.findByText('Sign off on the letter before approving.', undefined, FIND)).toBeInTheDocument();
  });

  it('approve onError splits by reason: 409 chart_not_ready → actionable copy', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    // Chart-readiness 409 carries blockingFiles (no `reason`); the split detects that form too.
    approveMock.mockRejectedValueOnce(new ConflictError({ blockingFiles: ['records.pdf'] }));
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Approve letter' }));
    await screen.findByText('Physician sign-off', undefined, FIND);
    await completeSignOff();
    expect(await screen.findByText("The chart isn't ready yet — finish reviewing the records, then approve.", undefined, FIND)).toBeInTheDocument();
  });

  it('approve onError: 503 render unavailable → not-available copy', async () => {
    getLetterMock.mockResolvedValueOnce({ data: physicianLetter });
    approveMock.mockRejectedValueOnce(new ServiceUnavailableError());
    renderPage();
    await screen.findByText('AI surgical edit');
    fireEvent.click(screen.getByRole('button', { name: 'Approve letter' }));
    await screen.findByText('Physician sign-off', undefined, FIND);
    await completeSignOff();
    expect(await screen.findByText('Letter render is not available in this environment.', undefined, FIND)).toBeInTheDocument();
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
