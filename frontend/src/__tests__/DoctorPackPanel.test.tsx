import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoctorPackPanel } from '../components/DoctorPackPanel';
import {
  generateDoctorPack,
  getDoctorPackPdfUrl,
  getLatestDoctorPack,
  listKeyDocs,
  type DoctorPack,
  type KeyDoc,
} from '../api/doctorPack';
import { useAuth } from '../auth/useAuth';
import { viewDocument } from '../api/veterans';

vi.mock('../api/doctorPack', async () => {
  const actual = await vi.importActual<typeof import('../api/doctorPack')>('../api/doctorPack');
  return {
    ...actual,
    getLatestDoctorPack: vi.fn(),
    listKeyDocs: vi.fn(),
    generateDoctorPack: vi.fn(),
    getDoctorPackPdfUrl: vi.fn(),
  };
});

vi.mock('../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

// Item 4 (2026-06-11): the Case-documents rows open the source PDF via the presigned viewer.
vi.mock('../api/veterans', () => ({
  viewDocument: vi.fn(),
}));

const getLatestMock = vi.mocked(getLatestDoctorPack);
const listKeyDocsMock = vi.mocked(listKeyDocs);
const generateMock = vi.mocked(generateDoctorPack);
const pdfUrlMock = vi.mocked(getDoctorPackPdfUrl);
const useAuthMock = vi.mocked(useAuth);
const viewDocMock = vi.mocked(viewDocument);

function setRole(role: 'admin' | 'ops_staff' | 'physician') {
  useAuthMock.mockReturnValue({ role } as unknown as ReturnType<typeof useAuth>);
}

const READY_PACK: DoctorPack = {
  id: 'pack-1',
  caseId: 'CASE-1',
  caseVersion: 3,
  state: 'ready',
  pdfS3Key: 'doctor-packs/CASE-1/v3/abc.pdf',
  pageCount: 12,
  keyDocCount: 4,
  errorMessage: null,
  generatedAt: '2026-06-11T00:00:00.000Z',
  generatedBy: 'rn-1',
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
};

const KEY_DOC: KeyDoc = {
  id: 'kd-1',
  caseId: 'CASE-1',
  filePath: 'cases/CASE-1/aaaa1111-bbbb-cccc-dddd-eeee22223333-Misc_3.pdf',
  classification: 'high_signal',
  docType: 'rating_decision',
  importance: 100,
  pageRanges: [{ from: 1, to: 3 }],
  needsRnReview: false,
  selectorRationale: 'p1: matched',
  docPageCount: 25,
  filename: 'Misc_3.pdf',
  documentId: 'doc-77',
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DoctorPackPanel caseId="CASE-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setRole('ops_staff');
  listKeyDocsMock.mockResolvedValue({ data: [] });
});

describe('DoctorPackPanel', () => {
  it('ready: shows the Open button with the page count and opens the presigned URL in a new tab', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    pdfUrlMock.mockResolvedValue({ data: { url: 'https://signed.example/pack.pdf', expiresAt: 'x', ttlSeconds: 300 } });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPanel();

    const openBtn = await screen.findByRole('button', { name: 'Open Doctor Pack (12pp)' });
    fireEvent.click(openBtn);

    await waitFor(() => expect(pdfUrlMock).toHaveBeenCalledWith('CASE-1', 'pack-1'));
    expect(openSpy).toHaveBeenCalledWith('https://signed.example/pack.pdf', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('generating: shows the in-flight spinner, no Open button', async () => {
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, state: 'generating', pageCount: null } });
    renderPanel();

    expect(await screen.findByText('Doctor Pack generating…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Doctor Pack/ })).toBeNull();
  });

  it('failed: surfaces the worker errorMessage VERBATIM and offers Regenerate to staff', async () => {
    const realError = 'pypdf failed to open cases/CASE-1/Misc_4.pdf: EOF marker not found';
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, state: 'failed', errorMessage: realError } });
    generateMock.mockResolvedValue({ data: { ...READY_PACK, state: 'queued' } });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Doctor Pack generation failed');
    expect(alert).toHaveTextContent(realError); // verbatim — NO-SILENT-ERRORS

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(generateMock).toHaveBeenCalledWith('CASE-1'));
  });

  it('null + physician: explains the RN generates it; no Generate button (D-2 decision)', async () => {
    setRole('physician');
    getLatestMock.mockResolvedValue({ data: null });
    renderPanel();

    expect(await screen.findByText('No Doctor Pack yet — ask your RN to generate it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
  });

  // Package 7: the pack auto-generates on send-to-doctor, so the staff null-state explains the
  // automation and offers only a small secondary "Generate now" escape hatch — the primary
  // "Generate Doctor Pack" CTA is gone from the happy path.
  it('null + staff: explains auto-generation on send-to-doctor; NO primary Generate CTA', async () => {
    getLatestMock.mockResolvedValue({ data: null });
    renderPanel();

    expect(
      await screen.findByText('No Doctor Pack yet — it will generate automatically when the case is sent to the doctor.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Doctor Pack' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate now' })).toBeInTheDocument();
  });

  it('null + staff: the secondary "Generate now" affordance still kicks off generation (edge cases)', async () => {
    getLatestMock.mockResolvedValue({ data: null });
    generateMock.mockResolvedValue({ data: { ...READY_PACK, state: 'queued' } });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Generate now' }));
    await waitFor(() => expect(generateMock).toHaveBeenCalledWith('CASE-1'));
  });

  it('generate failure surfaces the real API error via describeApiError (loud, not silent)', async () => {
    getLatestMock.mockResolvedValue({ data: null });
    generateMock.mockRejectedValue(new Error('chart_not_ready: 2 files still unread'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Generate now' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('chart_not_ready: 2 files still unread');
    alertSpy.mockRestore();
  });

  it('failed state keeps Regenerate for staff (recovery path unchanged by Package 7)', async () => {
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, state: 'failed', errorMessage: 'boom' } });
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('renders the all-documents list: filename, human docType label, classification chip, pages selected', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    listKeyDocsMock.mockResolvedValue({
      data: [
        KEY_DOC,
        { ...KEY_DOC, id: 'kd-2', filename: 'Blue_Button.pdf', docType: 'blue_button', classification: 'bulk', importance: 30, pageRanges: [], docPageCount: 500 },
      ],
    });
    renderPanel();

    expect(await screen.findByText('Misc_3.pdf')).toBeInTheDocument();
    expect(screen.getByText('Rating decision')).toBeInTheDocument();
    // Item 4: the classification WORD stays; the raw importance integer ("· 100") is gone —
    // an opaque internal sort score means nothing to a physician.
    expect(screen.getByText('High signal')).toBeInTheDocument();
    expect(screen.queryByText(/·\s*100/)).not.toBeInTheDocument();
    expect(screen.queryByText('High signal · 100')).not.toBeInTheDocument();
    expect(screen.getByText('3 of 25 pages')).toBeInTheDocument();
    // The excluded bulk doc is listed but shows it contributes nothing.
    expect(screen.getByText('Blue_Button.pdf')).toBeInTheDocument();
    expect(screen.getByText('Blue Button dump')).toBeInTheDocument();
    expect(screen.getByText('not included')).toBeInTheDocument();
  });

  // ── Item 4 (2026-06-11): clickable Case-documents rows ───────────────────────────────────────

  it('clicking a document filename opens it via viewDocument(documentId) in a new tab', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    listKeyDocsMock.mockResolvedValue({ data: [KEY_DOC] });
    viewDocMock.mockResolvedValueOnce({ data: { downloadUrl: 'https://s3.example/keydoc-inline' } });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Misc_3.pdf' }));
    await waitFor(() => {
      expect(viewDocMock).toHaveBeenCalledWith('doc-77');
      expect(openSpy).toHaveBeenCalledWith('https://s3.example/keydoc-inline', '_blank', 'noopener,noreferrer');
    });
    openSpy.mockRestore();
  });

  it('a row without documentId renders the filename as plain text (no button)', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    listKeyDocsMock.mockResolvedValue({ data: [{ ...KEY_DOC, documentId: null }] });
    renderPanel();

    expect(await screen.findByText('Misc_3.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Misc_3.pdf' })).not.toBeInTheDocument();
  });

  // ── WAVE 2 (assessment 2026-06-12 §1 gate / §1d / §3) ───────────────────────────────────────

  it('renders the prominent amber banner when the manifest carries NO_CLINICAL_DX_DOCUMENTATION', async () => {
    getLatestMock.mockResolvedValue({
      data: { ...READY_PACK, manifestJson: { warnings: ['NO_CLINICAL_DX_DOCUMENTATION'] } },
    });
    renderPanel();

    expect(
      await screen.findByText(
        'This pack contains NO clinical documentation of the claimed condition — review the chart before relying on it.',
      ),
    ).toBeInTheDocument();
  });

  it('no banner and no "Not included" section when the manifest carries neither', async () => {
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, manifestJson: {} } });
    renderPanel();

    await screen.findByRole('button', { name: 'Open Doctor Pack (12pp)' });
    expect(screen.queryByText(/NO clinical documentation/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
  });

  it('renders trimNotes as plain-English "Not included" items — raw S3 keys and internal codes never reach the screen', async () => {
    getLatestMock.mockResolvedValue({
      data: {
        ...READY_PACK,
        manifestJson: {
          budgetTrim: {
            trimNotes: [
              'cases/CASE-1/aaaa1111-bbbb-cccc-dddd-eeee22223333-Blue_Button.pdf: dropped (12 selected pages over budget)',
              'cases/CASE-1/aaaa1111-bbbb-cccc-dddd-eeee22223333-Rating.pdf: kept 4 of 12 selected pages (budget trim)',
              'category sc_proof: kept 6 of 9 selected pages (soft cap 6)',
              'could not render PsychNote.txt',
              'cases/CASE-1/aaaa1111-bbbb-cccc-dddd-eeee22223333-Whole.pdf: whole-doc passthrough (no per-page selection) - not counted against the budget',
            ],
          },
        },
      },
    });
    renderPanel();

    expect(await screen.findByText('Not included')).toBeInTheDocument();
    expect(screen.getByText('Blue_Button.pdf — left out (12 pages, over the page limit)')).toBeInTheDocument();
    expect(screen.getByText('Rating.pdf — only 4 of 12 selected pages fit the page limit')).toBeInTheDocument();
    expect(screen.getByText('service-connection proof — 6 of 9 selected pages included overall')).toBeInTheDocument();
    expect(screen.getByText('PsychNote.txt — could not be converted for the pack; open it from the chart instead')).toBeInTheDocument();
    // Plain English only: no raw keys, no category codes; the passthrough note (not an
    // omission) is filtered out entirely.
    expect(document.body.textContent).not.toContain('cases/CASE-1');
    expect(document.body.textContent).not.toContain('sc_proof');
    expect(document.body.textContent).not.toContain('passthrough');
  });

  it('renders the server displayLabel when present and suppresses the now-duplicate docType subline', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    listKeyDocsMock.mockResolvedValue({ data: [{ ...KEY_DOC, displayLabel: 'Rating decision — Misc_3.pdf' }] });
    renderPanel();

    expect(await screen.findByText('Rating decision — Misc_3.pdf')).toBeInTheDocument();
    // Exact-match query: the standalone subline 'Rating decision' is gone (the label carries it).
    expect(screen.queryByText('Rating decision')).not.toBeInTheDocument();
  });
});
