import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { DocumentUploadPanel } from '../components/DocumentUploadPanel';
import { presignDocument, recordDocument, uploadToPresignedUrl } from '../api/veterans';
import { reprocessCase } from '../api/cases';
import { getChartReadiness } from '../api/chart-readiness';
import { ACCEPT_ATTR, MAX_BYTES } from '../routes/veterans/documentUpload';
import type { Case } from '../types/prisma';

// Keystone Package 3 — shared upload core extracted from the veteran chart's DocumentsPanel.
// These tests pin the contract: presign → S3 PUT → record call ORDER, the pinned-caseId variant
// (case page) vs the dropdown variant (chart), zip expansion, the 50 MB cap, .txt acceptance
// (Package 2 fold), and verbatim per-file error surfacing (NO-SILENT-ERRORS).

// Call-order ledger shared by the three mocked steps.
const calls: string[] = [];

vi.mock('../api/veterans', () => ({
  presignDocument: vi.fn(async () => { calls.push('presign'); return { data: { uploadUrl: 'https://s3.test/upload', requiredHeaders: { 'Content-Type': 'application/pdf' }, s3Key: 'cases/CASE-9/uuid-a.pdf' } }; }),
  uploadToPresignedUrl: vi.fn(async () => { calls.push('put'); }),
  recordDocument: vi.fn(async () => { calls.push('record'); return { data: { id: 'DOC-1' } }; }),
  // The Reprocess modal lists the case's docs (all selected by default). CASE-9 → 2 docs, C-2 → 1.
  listDocuments: vi.fn(async () => ({ data: [
    { id: 'D1', filename: 'enc1.pdf', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-enc1.pdf' },
    { id: 'D2', filename: 'enc2.pdf', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-enc2.pdf' },
    { id: 'D3', filename: 'knee.pdf', caseId: 'C-2', s3Key: 'cases/C-2/uuid-knee.pdf' },
  ] })),
}));

// Keystone 4b — the case-level reprocess action (re-OCR stuck files + force chart re-extract).
vi.mock('../api/cases', () => ({
  reprocessCase: vi.fn(async () => ({ data: { reocrQueued: 2, extractEnqueued: false, extractReason: 'ocr_in_progress', requestId: 'req-1' } })),
}));

// The processing note + button state derive from chart-readiness (SERVER state) so they survive a
// navigate-away/remount. Default mock = NOT ready (something to process) so the Reprocess button is
// enabled in the action tests; individual tests override to 'extracting' (in-progress) or ready:true
// (nothing-new) to exercise those behaviors.
vi.mock('../api/chart-readiness', () => ({
  getChartReadiness: vi.fn(async () => ({ data: { ready: false, extractionState: 'extract_failed' } })),
}));

// expandSelection imports JSZip dynamically; vitest intercepts the dynamic import too. The mock zip
// carries one junk __MACOSX entry (skipped) and one real PDF entry (uploaded).
vi.mock('jszip', () => ({
  default: {
    loadAsync: vi.fn(async () => ({
      files: {
        '__MACOSX/inner.pdf': { name: '__MACOSX/inner.pdf', dir: false, _data: { uncompressedSize: 10 }, async: async () => new Blob(['0123456789'], { type: 'application/pdf' }) },
        'records/inner.pdf': { name: 'records/inner.pdf', dir: false, _data: { uncompressedSize: 10 }, async: async () => new Blob(['0123456789'], { type: 'application/pdf' }) },
      },
    })),
  },
}));

const presign = vi.mocked(presignDocument);
const put = vi.mocked(uploadToPresignedUrl);
const record = vi.mocked(recordDocument);

const TWO_CASES = [
  { id: 'C-1', claimedCondition: 'PTSD' },
  { id: 'C-2', claimedCondition: 'Knee strain' },
] as unknown as readonly Case[];

function fileInput(): HTMLInputElement {
  return screen.getByLabelText('Upload documents');
}

// The panel now uses useQuery (post-reprocess live status) → it must render under a QueryClientProvider.
function renderPanel(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// Reprocess opens a document-picker modal (Ryan 2026-06-16): all files selected by default → click the
// "Reprocess N files" button. This opens the modal, waits for the docs to load, then confirms.
async function clickReprocess() {
  await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
  // Submit button renamed "Re-read N files" (cost-safety 1B, Ryan 2026-06-18).
  await userEvent.click(await screen.findByRole('button', { name: /Re-read \d+ file/ }));
}

beforeEach(() => { vi.clearAllMocks(); calls.length = 0; });

describe('DocumentUploadPanel — pinned-caseId variant (case page)', () => {
  it('renders NO case selector and presigns + records with the pinned caseId, in presign → PUT → record order', async () => {
    const onUploaded = vi.fn();
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={onUploaded} />);

    // Pinned: the claim dropdown must not exist; the docTag select stays.
    expect(screen.queryByLabelText('Assign to claim')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Document tag')).toBeInTheDocument();

    await userEvent.upload(fileInput(), new File(['x'], 'a.pdf', { type: 'application/pdf' }));

    expect(await screen.findByText(/1 uploaded\./)).toBeInTheDocument();
    expect(presign).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'CASE-9', filename: 'a.pdf', contentType: 'application/pdf' }));
    expect(record).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'CASE-9', filename: 'a.pdf', s3Key: 'cases/CASE-9/uuid-a.pdf', docTag: 'Other' }));
    expect(put).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['presign', 'put', 'record']); // the load-bearing order: never record before the bytes are in S3
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('accepts a .txt file (Package 2 fold) — the accept attr includes .txt and the upload presigns as text/plain', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    expect(fileInput().getAttribute('accept')).toBe(ACCEPT_ATTR);
    expect(ACCEPT_ATTR).toContain('.txt');
    expect(ACCEPT_ATTR).toContain('text/plain');

    // userEvent.upload applies the accept attr — this upload would be silently filtered out if
    // .txt were missing from it, so the assertion below also guards the picker filter itself.
    await userEvent.upload(fileInput(), new File(['hello'], 'note.txt', { type: 'text/plain' }));

    expect(await screen.findByText(/1 uploaded\./)).toBeInTheDocument();
    expect(presign).toHaveBeenCalledWith('VET-1', expect.objectContaining({ filename: 'note.txt', contentType: 'text/plain' }));
  });

  it('expands a .zip client-side: junk entries skipped, real entries uploaded individually', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await userEvent.upload(fileInput(), new File(['PK'], 'records.zip', { type: 'application/zip' }));

    expect(await screen.findByText(/1 uploaded, 1 skipped/)).toBeInTheDocument();
    expect(presign).toHaveBeenCalledTimes(1); // the zip itself is never uploaded — only its one real entry
    expect(presign).toHaveBeenCalledWith('VET-1', expect.objectContaining({ filename: 'inner.pdf', contentType: 'application/pdf' }));
  });

  it('skips a file over the 50 MB cap without presigning', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: MAX_BYTES + 1 });
    await userEvent.upload(fileInput(), big);

    expect(await screen.findByText(/Nothing to upload — 1 skipped/)).toBeInTheDocument();
    expect(presign).not.toHaveBeenCalled();
  });

  it('surfaces the per-file API failure reason verbatim in the status line (NO-SILENT-ERRORS)', async () => {
    const apiMessage = 'Only PDF, JPG, PNG, DOC, and DOCX uploads are supported.';
    presign.mockRejectedValueOnce({ response: { status: 400, data: { error: { code: 'unsupported_content_type', message: apiMessage } } } });
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await userEvent.upload(fileInput(), new File(['x'], 'a.pdf', { type: 'application/pdf' }));

    expect(await screen.findByText((t) => t.includes('1 failed') && t.includes(`a.pdf: ${apiMessage}`))).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled(); // the failed file is never recorded
  });
});

describe('DocumentUploadPanel — dropdown variant (veteran chart)', () => {
  it('renders the claim selector defaulting to the first case and presigns with it', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={TWO_CASES} onUploaded={vi.fn()} />);
    const select = screen.getByLabelText('Assign to claim');
    expect(select).toHaveValue('C-1');

    await userEvent.upload(fileInput(), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(presign).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'C-1' })));
  });

  it('presigns with the SELECTED case after the dropdown changes', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={TWO_CASES} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Assign to claim'), 'C-2');
    await userEvent.upload(fileInput(), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(presign).toHaveBeenCalledWith('VET-1', expect.objectContaining({ caseId: 'C-2' })));
  });

  it('refuses to upload with no case available and says so', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={[]} onUploaded={vi.fn()} />);
    await userEvent.upload(fileInput(), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Create or select a case before uploading.')).toBeInTheDocument();
    expect(presign).not.toHaveBeenCalled();
  });
});

// Keystone 4b — the Reprocess button rides the SHARED panel so it surfaces in BOTH Documents tabs
// (pinned case-page variant AND the chart's dropdown variant) without touching CaseDetailPage.
describe('DocumentUploadPanel — Reprocess documents (keystone 4b)', () => {
  const reprocess = vi.mocked(reprocessCase);

  it('pinned variant: FORCE-reprocesses the selected docs with the pinned caseId', async () => {
    const onUploaded = vi.fn();
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={onUploaded} />);
    await clickReprocess();

    // CASE-9 has 2 docs, both selected by default → reprocessCase called WITH those documentIds.
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('CASE-9', expect.arrayContaining(['D1', 'D2'])));
    expect(await screen.findByText(/Re-reading 2 files with full vision and re-running the chart extraction/)).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('opens a picker (no one-click spend); Cancel backs out without calling reprocess', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    // First click only opens the modal — it must NOT call reprocessCase.
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
    expect(reprocess).not.toHaveBeenCalled();
    expect(await screen.findByText(/2 of 2 selected/)).toBeInTheDocument();
    // Cancel backs out without spending.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reprocess).not.toHaveBeenCalled();
  });

  it('per-file selection: deselect all then pick one → reprocess only that doc (saves tokens)', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
    await screen.findByText(/2 of 2 selected/);
    await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(await screen.findByText(/0 of 2 selected/)).toBeInTheDocument();
    // pick just enc1.pdf
    await userEvent.click(screen.getByRole('checkbox', { name: /enc1\.pdf/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Re-read 1 file' }));
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('CASE-9', ['D1']));
  });

  it('dropdown variant: reprocesses the SELECTED claim', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={TWO_CASES} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Assign to claim'), 'C-2');
    await clickReprocess();
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('C-2', ['D3']));
  });

  it('surfaces the API failure reason loudly (NO-SILENT-ERRORS)', async () => {
    reprocess.mockRejectedValueOnce({ response: { status: 404, data: { error: { code: 'case_not_found', message: 'Case was not found.' } } } });
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await clickReprocess();
    expect(await screen.findByText(/Reprocess failed: Case was not found\./)).toBeInTheDocument();
  });

  it('no case → modal shows no docs and reprocess can’t be triggered (no spend)', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={[]} onUploaded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
    expect(await screen.findByText('No documents on this claim yet.')).toBeInTheDocument();
    // The submit button renders but is DISABLED (0 selectable → "Select a file to re-read") → no spend.
    expect(screen.getByRole('button', { name: /Select a file to re-read|Re-read \d+ file/ })).toBeDisabled();
    expect(reprocess).not.toHaveBeenCalled();
  });

  // FIX (Ryan 2026-06-16): the processing note + button-disable are SERVER-derived, so they survive a
  // navigate-away/remount. A FRESH mount (no prior local state) showing the in-progress note + a grayed
  // button purely because the SERVER says 'extracting' is exactly the remount case.
  it('server says extracting → shows the processing note AND grays the button (survives remount, no local state)', async () => {
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: false, extractionState: 'extracting' } } as never);
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    // No click — the note appears from server state alone (the remount scenario).
    expect(await screen.findByText(/Reading and extracting the chart/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Reprocessing/ });
    expect(btn).toBeDisabled();
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: true, extractionState: 'chart_ready' } } as never);
  });

  it('all files already read (ready) → button grayed + "No new files to process" (cost guard)', async () => {
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: true, extractionState: 'chart_ready' } } as never);
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    expect(await screen.findByText('No new files to process.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprocess documents' })).toBeDisabled();
    // the subtle force escape stays reachable
    expect(screen.getByRole('button', { name: 'Re-read anyway' })).toBeInTheDocument();
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: false, extractionState: 'extract_failed' } } as never);
  });

  it('something to process (not ready) → button enabled, no "nothing new" caption', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Reprocess documents' })).toBeEnabled();
    expect(screen.queryByText('No new files to process.')).not.toBeInTheDocument();
  });

  it('QA C2: extract_failed (ready=true but the RUN failed) → button stays ENABLED, no "nothing new"', async () => {
    // ready is OCR-read-only and stays true when the extraction RUN failed; reprocess IS the recovery.
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: true, extractionState: 'extract_failed' } } as never);
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Reprocess documents' })).toBeEnabled();
    expect(screen.queryByText('No new files to process.')).not.toBeInTheDocument();
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: false, extractionState: 'extract_failed' } } as never);
  });
});
