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
}));

// Keystone 4b — the case-level reprocess action (re-OCR stuck files + force chart re-extract).
vi.mock('../api/cases', () => ({
  reprocessCase: vi.fn(async () => ({ data: { reocrQueued: 2, extractEnqueued: false, extractReason: 'ocr_in_progress', requestId: 'req-1' } })),
}));

// The post-reprocess live-status poll (audit 2026-06-13) reads chart-readiness once watchReprocess turns
// on — mock it so the panel's status messages (set synchronously on reprocess) are what these tests assert.
vi.mock('../api/chart-readiness', () => ({
  getChartReadiness: vi.fn(async () => ({ data: { ready: false, extractionState: 'extracting' } })),
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

// Reprocess is now a two-step confirm (Ryan 2026-06-13: no habitual one-click bill). This drives both clicks.
async function clickReprocess() {
  await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm reprocess' }));
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

  it('pinned variant: calls reprocessCase with the pinned caseId and surfaces the structured summary', async () => {
    const onUploaded = vi.fn();
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={onUploaded} />);
    await clickReprocess();

    expect(reprocess).toHaveBeenCalledWith('CASE-9');
    expect(await screen.findByText(/Re-OCR started — the chart re-extraction will run automatically when OCR finishes\./)).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalledTimes(1); // refresh the doc list after the nudge
  });

  it('requires a confirm step before spending (no one-click bill)', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    // First click only opens the confirm — it must NOT call reprocessCase.
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess documents' }));
    expect(reprocess).not.toHaveBeenCalled();
    expect(screen.getByText(/uses API time/)).toBeInTheDocument();
    // Cancelling backs out without spending.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reprocess).not.toHaveBeenCalled();
  });

  it('dropdown variant: reprocesses the SELECTED claim', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={TWO_CASES} onUploaded={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Assign to claim'), 'C-2');
    await clickReprocess();
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('C-2'));
  });

  it('reports a queued extract when the force enqueued immediately (all-terminal wedge case)', async () => {
    reprocess.mockResolvedValueOnce({ data: { reocrQueued: 0, extractEnqueued: true, requestId: 'req-2' } });
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await clickReprocess();
    // The "0 files" no longer reads like nothing happened — the re-extract is the headline.
    expect(await screen.findByText(/All files already read OK — a fresh full chart re-extraction is now running/)).toBeInTheDocument();
  });

  it('surfaces the API failure reason loudly (NO-SILENT-ERRORS)', async () => {
    reprocess.mockRejectedValueOnce({ response: { status: 404, data: { error: { code: 'case_not_found', message: 'Case was not found.' } } } });
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await clickReprocess();
    expect(await screen.findByText(/Reprocess failed: Case was not found\./)).toBeInTheDocument();
  });

  it('refuses with no case selected and says so', async () => {
    renderPanel(<DocumentUploadPanel veteranId="VET-1" cases={[]} onUploaded={vi.fn()} />);
    await clickReprocess();
    expect(await screen.findByText('Create or select a case before reprocessing.')).toBeInTheDocument();
    expect(reprocess).not.toHaveBeenCalled();
  });

  // Regression (Jamarious, 2026-06-13): the chart is ALREADY chart_ready before a reprocess, so the
  // first (stale) readiness read must NOT flash a FALSE "Done" — it shows "Starting…" until the new
  // run is actually observed building.
  it('does NOT false-"Done" on the stale pre-reprocess chart_ready — shows Starting until building seen', async () => {
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: true, extractionState: 'chart_ready' } } as never);
    reprocess.mockResolvedValueOnce({ data: { reocrQueued: 0, extractEnqueued: true, requestId: 'req-stale' } });
    renderPanel(<DocumentUploadPanel veteranId="VET-1" caseId="CASE-9" onUploaded={vi.fn()} />);
    await clickReprocess();
    expect(await screen.findByText(/Starting re-extraction/)).toBeInTheDocument();
    expect(screen.queryByText(/✅ Done/)).not.toBeInTheDocument(); // never the stale-chart_ready false done
    vi.mocked(getChartReadiness).mockResolvedValue({ data: { ready: false, extractionState: 'extracting' } } as never);
  });
});
