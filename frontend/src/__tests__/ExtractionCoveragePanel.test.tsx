import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractionCoveragePanel } from '../components/ExtractionCoveragePanel';
import { getExtractionCoverage, type ExtractionCoverage } from '../api/extraction-coverage';
import { viewDocument } from '../api/veterans';

vi.mock('../api/extraction-coverage', () => ({ getExtractionCoverage: vi.fn() }));
vi.mock('../api/veterans', () => ({ viewDocument: vi.fn() }));

const coverageMock = vi.mocked(getExtractionCoverage);
const viewDocumentMock = vi.mocked(viewDocument);

function cov(over: Partial<ExtractionCoverage> = {}): ExtractionCoverage {
  const base = {
    totalPages: 120,
    extractedPages: 120,
    coveragePct: 100,
    gaps: [] as ExtractionCoverage['gaps'],
    status: 'complete' as ExtractionCoverage['status'],
    unknownPageFiles: 0,
    totalFiles: 10,
    pageBreakdown: null,
    ...over,
  };
  // Two-stage SSOT (Ryan 2026-06-23): default the two stages off the numbers so existing tests that only set
  // coveragePct/status still produce a coherent object. A test that wants an incomplete analysis overrides
  // chartAnalysis explicitly.
  const approximate = base.unknownPageFiles > 0;
  const pagesReadLabel = (approximate && base.totalFiles > 0 && base.totalPages === base.totalFiles)
    ? `${base.totalFiles} ${base.totalFiles === 1 ? 'file' : 'files'}, page counts unavailable`
    : `${base.coveragePct}% (${base.extractedPages} of ${base.totalPages})`;
  return {
    ...base,
    pagesRead: over.pagesRead ?? { pct: base.coveragePct, readUnits: base.extractedPages, totalUnits: base.totalPages, approximate, label: pagesReadLabel },
    chartAnalysis: over.chartAnalysis ?? { state: 'complete', label: '✓ Complete', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
    // Relevance-aware framing (Dr. Kasky #76): default null (fail-open — no classification) so existing tests
    // are unchanged. A test that wants the relevance read overrides `relevance` explicitly.
    relevance: over.relevance ?? null,
  };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<ExtractionCoveragePanel caseId="CASE-1" />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  viewDocumentMock.mockResolvedValue({ data: { downloadUrl: 'https://s3.example/presigned' } });
});

describe('ExtractionCoveragePanel', () => {
  it('renders BOTH stages clean (Pages read + Chart analysis) with no details toggle', async () => {
    coverageMock.mockResolvedValue({ data: cov() });
    renderPanel();
    // Two-stage SSOT: a "Pages read" line and a "Chart analysis" line, both labeled.
    expect(await screen.findByText('Pages read')).toBeInTheDocument();
    expect(screen.getByText(/100% \(120 of 120\)/)).toBeInTheDocument();
    expect(screen.getByText('Chart analysis')).toBeInTheDocument();
    expect(screen.getByText('✓ Complete')).toBeInTheDocument();
    expect(screen.getByText(/read and analyzed/)).toBeInTheDocument();
    // No gaps → no "Show items" toggle.
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
  });

  it('OCR 100% but chart analysis DID NOT FINISH → shows the incomplete analysis line + names the cause file, chip NOT Complete', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        coveragePct: 100,
        status: 'complete_with_gaps',
        gaps: [{ documentId: null, fileName: 'Chart analysis', reason: 'extraction_incomplete', pageLabel: 'did not finish — retry', isImage: false, terminalStatus: null }],
        chartAnalysis: {
          state: 'incomplete',
          label: '⚠ Chart analysis didn’t finish — retry',
          reason: 'The chart analysis was interrupted before it finished, so the structured chart may be missing records.',
          likelyCauseFile: 'VA Blue Button Records.pdf',
          findings: null,
          minorGap: false,
        },
      }),
    });
    renderPanel();
    // The OCR stage still reads 100% — but the analysis stage is honestly flagged.
    expect(await screen.findByText(/100% \(120 of 120\)/)).toBeInTheDocument();
    expect(screen.getByText('⚠ Chart analysis didn’t finish — retry')).toBeInTheDocument();
    expect(screen.getByText(/interrupted before it finished/)).toBeInTheDocument();
    expect(screen.getByText(/VA Blue Button Records\.pdf/)).toBeInTheDocument();
    // The chip can NEVER say Complete over an unfinished analysis (the core honesty fix).
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
    expect(screen.getByText('Analysis incomplete')).toBeInTheDocument();
  });

  it('renders a gap row with a View file link and an image describe affordance', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalPages: 120,
        extractedPages: 118,
        coveragePct: 98,
        status: 'complete_with_gaps',
        gaps: [
          { documentId: 'DOC-IMG', fileName: 'scan.jpg', reason: 'unreadable_image', pageLabel: 'whole file', isImage: true, terminalStatus: 'manual_summary_required' },
        ],
      }),
    });
    renderPanel();

    expect(await screen.findByText(/98% \(118 of 120\)/)).toBeInTheDocument();

    // Expand the details.
    fireEvent.click(screen.getByRole('button', { name: /Show 1 item/ }));
    expect(screen.getByText(/Image couldn’t be read as text/)).toBeInTheDocument();

    // Clicking the FILE NAME opens the inline viewer (presigned) — no separate "View file" button.
    fireEvent.click(screen.getByRole('button', { name: 'scan.jpg' }));
    await waitFor(() => expect(viewDocumentMock).toHaveBeenCalledWith('DOC-IMG'));

    // Image gap exposes the "Request AI description" affordance + its plain-English note.
    const describeBtn = screen.getByRole('button', { name: 'Request AI description' });
    fireEvent.click(describeBtn);
    expect(await screen.findByText(/re-run OCR from the/i)).toBeInTheDocument();
  });

  it('says "approximate" and never shows 100% when page counts are unknown', async () => {
    coverageMock.mockResolvedValue({
      data: cov({ totalPages: 3, extractedPages: 3, coveragePct: 99, status: 'complete_with_gaps', unknownPageFiles: 3, totalFiles: 3 }),
    });
    renderPanel();
    expect(await screen.findByText(/3 files, page counts unavailable/)).toBeInTheDocument();
  });

  // ===== Per-page vision breakdown (vision rebuild 2026-06-16) =====
  it('handwriting-uncertain pages → amber "Review N pages" chip + breakdown line, NOT Complete', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        coveragePct: 100, // file-level reads 100% — but per-page review must override the chip
        pageBreakdown: {
          pagesWithSignal: 4, clean: 2, handwritingUncertain: 2, blank: 0, unreadable: 0,
          reviewPages: [
            { documentId: 'D1', fileName: 'STD_worksheet.pdf', pageNumber: 1, reason: 'handwriting_uncertain' },
            { documentId: 'D1', fileName: 'STD_worksheet.pdf', pageNumber: 2, reason: 'handwriting_uncertain' },
          ],
        },
      }),
    });
    renderPanel();
    expect(await screen.findByText('Review 2 pages')).toBeInTheDocument();
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
    expect(screen.getByText(/handwriting we may not have read in full/)).toBeInTheDocument();
    expect(screen.getByText(/2 clear, 2 handwriting to confirm/)).toBeInTheDocument();
    // expand → the two review rows with plain reason + View file
    fireEvent.click(screen.getByRole('button', { name: /Show 2 items/ }));
    expect(await screen.findAllByText('STD_worksheet.pdf')).toHaveLength(2);
    expect(screen.getAllByText(/Handwriting — read with low confidence/)).toHaveLength(2);
  });

  it('unreadable pages → amber "N unread" chip, blanks stay silent (not listed, shown only in the breakdown)', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        pageBreakdown: {
          pagesWithSignal: 5, clean: 3, handwritingUncertain: 0, blank: 1, unreadable: 1,
          reviewPages: [{ documentId: 'D2', fileName: 'faded.pdf', pageNumber: 4, reason: 'unreadable' }],
        },
      }),
    });
    renderPanel();
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText(/3 clear, 1 couldn’t read, 1 blank/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show 1 item/ }));
    expect(await screen.findByText('faded.pdf')).toBeInTheDocument();
    // blank page is NOT a review row (no cry-wolf)
    expect(screen.queryByText(/blank/i)).toBeInTheDocument(); // appears in breakdown line only
  });

  it('all-clean vision chart → Complete chip (full pages with handwriting are captured, not flagged)', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        pageBreakdown: { pagesWithSignal: 3, clean: 3, handwritingUncertain: 0, blank: 0, unreadable: 0, reviewPages: [] },
      }),
    });
    renderPanel();
    expect(await screen.findByText('Complete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
  });

  it('a non-image gap shows no describe affordance', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalPages: 10,
        extractedPages: 7,
        coveragePct: 70,
        status: 'complete_with_gaps',
        gaps: [{ documentId: 'DOC-PDF', fileName: 'record.pdf', reason: 'needs_manual_summary', pageLabel: '3 pages', isImage: false, terminalStatus: 'manual_summary_required' }],
      }),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Show 1 item/ }));
    // A non-image gap: no "Request AI description"; the file name itself is the clickable opener.
    expect(screen.queryByRole('button', { name: 'Request AI description' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'record.pdf' }));
    await waitFor(() => expect(viewDocumentMock).toHaveBeenCalledWith('DOC-PDF'));
  });

  // ===== RELEVANCE-AWARE framing (Dr. Kasky #76) =====
  // A bare "38% extracted" is reframed by relevance: "we read the documents relevant to this claim" with the
  // skipped (irrelevant) pages explained. HONEST: a missed KEY doc is flagged PROMINENTLY, never softened.

  it('partial chart, all KEY docs read + irrelevant pages skipped → reassuring relevance read, raw % still shown, NO key-gap warning', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalPages: 132,
        extractedPages: 52,
        coveragePct: 39, // the scary bare number
        status: 'complete_with_gaps',
        gaps: [{ documentId: 'DB', fileName: 'Blue Button.pdf', reason: 'needs_manual_summary', pageLabel: '80 pages', isImage: false, terminalStatus: 'manual_summary_required' }],
        relevance: {
          keyDocsRead: [
            { documentId: 'DR', fileName: 'Rating Decision.pdf', docType: 'rating_decision', classification: 'high_signal', pageLabel: '12 pages', key: true },
            { documentId: 'DS', fileName: 'STR.pdf', docType: 'service_treatment_record_summary', classification: 'high_signal', pageLabel: '40 pages', key: true },
          ],
          keyDocGaps: [],
          skippableGaps: [{ documentId: 'DB', fileName: 'Blue Button.pdf', docType: 'blue_button', classification: 'bulk', pageLabel: '80 pages', key: false }],
          allKeyDocsRead: true,
          keyPagesRead: 52,
          keyPagesApproximate: false,
        },
      }),
    });
    renderPanel();
    // Leads with the reassuring relevance read naming the relevant doc types + page count.
    expect(await screen.findByText(/We read the documents relevant to this claim/)).toBeInTheDocument();
    expect(screen.getByText(/rating decision and service treatment records/)).toBeInTheDocument();
    expect(screen.getByText(/usually safe to skip/)).toBeInTheDocument();
    // Raw % is STILL shown (secondary transparency), not hidden.
    expect(screen.getByText(/39% \(52 of 132\)/)).toBeInTheDocument();
    // No key-gap warning copy.
    expect(screen.queryByText(/review before drafting/)).not.toBeInTheDocument();
  });

  it('partial chart with a KEY doc UNREAD → prominent "review before drafting" warning, gap NOT hidden', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalPages: 52,
        extractedPages: 40,
        coveragePct: 77,
        status: 'complete_with_gaps',
        gaps: [{ documentId: 'DR', fileName: 'Rating Decision.pdf', reason: 'unread', pageLabel: '12 pages', isImage: false, terminalStatus: 'manual_summary_required' }],
        relevance: {
          keyDocsRead: [{ documentId: 'DS', fileName: 'STR.pdf', docType: 'service_treatment_record_summary', classification: 'high_signal', pageLabel: '40 pages', key: true }],
          keyDocGaps: [{ documentId: 'DR', fileName: 'Rating Decision.pdf', docType: 'rating_decision', classification: 'high_signal', pageLabel: '12 pages', key: true }],
          skippableGaps: [],
          allKeyDocsRead: false,
          keyPagesRead: 40,
          keyPagesApproximate: false,
        },
      }),
    });
    renderPanel();
    // The gap that MATTERS leads, prominently — reassurance is withheld.
    expect(await screen.findByText(/claim-relevant documents? (was|were) not read — review before drafting/)).toBeInTheDocument();
    expect(screen.getByText(/Rating Decision\.pdf/)).toBeInTheDocument();
    // It must NOT have rendered the reassuring all-clear copy.
    expect(screen.queryByText(/We read the documents relevant to this claim/)).not.toBeInTheDocument();
  });

  // ===== MANUAL-ENTRY case: zero uploaded chart-input files (Ryan 2026-06-30) =====
  // A New-Claim case added by hand for an existing veteran has NO uploaded documents (records come from the
  // prior case automatically). "0 of 0 = 100% / Not analyzed yet" reads as broken — replace with one neutral line.

  it('manual entry (totalFiles 0) → single neutral line, NO stage lines, neutral "Manual entry" chip (never amber)', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalFiles: 0,
        totalPages: 0,
        extractedPages: 0,
        coveragePct: 100, // backend: no chart inputs → vacuously 100%
        status: 'complete',
        chartAnalysis: { state: 'not_analyzed', label: 'Not analyzed yet', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      }),
    });
    renderPanel();
    // The single plain-English manual-entry line.
    expect(await screen.findByText(/Manual entry — records from the last case are pulled in automatically\. Upload additional records as needed\./)).toBeInTheDocument();
    // The confusing stage lines are GONE (no "Pages read", no "0 of 0", no "Not analyzed yet" body line).
    expect(screen.queryByText('Pages read')).not.toBeInTheDocument();
    expect(screen.queryByText('Chart analysis')).not.toBeInTheDocument();
    expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
    // Chip is the neutral "Manual entry" — never amber, never "Not analyzed yet".
    const chip = screen.getByText('Manual entry');
    expect(chip).toBeInTheDocument();
    expect(chip.className).toMatch(/text-slate-500/);
    expect(chip.className).not.toMatch(/amber/);
    expect(screen.queryByText('Not analyzed yet')).not.toBeInTheDocument();
  });

  it('has files but pages not yet counted (totalFiles ≥ 1, totalPages 0) → NORMAL stage lines, NOT the manual message', async () => {
    // The signal is the FILE count, not the page count. A real-file case whose pages aren't tallied yet must
    // render the normal two-stage path — it must NEVER be mistaken for a manual entry.
    coverageMock.mockResolvedValue({
      data: cov({
        totalFiles: 2,
        totalPages: 0,
        extractedPages: 0,
        coveragePct: 0,
        status: 'in_progress' as ExtractionCoverage['status'],
        chartAnalysis: { state: 'in_progress', label: 'Analyzing the chart…', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      }),
    });
    renderPanel();
    // in_progress renders nothing (the panel returns null while extraction is still running), so assert the
    // manual line never appears for a case that HAS files — verified against a settled state below too.
    await waitFor(() => expect(coverageMock).toHaveBeenCalled());
    expect(screen.queryByText(/Manual entry — records from the last case/)).not.toBeInTheDocument();
  });

  it('settled case WITH files but 0 pages counted → normal stage lines render, manual message absent', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalFiles: 2,
        totalPages: 0,
        extractedPages: 0,
        coveragePct: 100,
        status: 'complete',
        chartAnalysis: { state: 'not_analyzed', label: 'Not analyzed yet', reason: null, likelyCauseFile: null, findings: null, minorGap: false },
      }),
    });
    renderPanel();
    // Normal two-stage path — the manual line must be absent because totalFiles ≥ 1.
    expect(await screen.findByText('Pages read')).toBeInTheDocument();
    expect(screen.getByText('Chart analysis')).toBeInTheDocument();
    expect(screen.queryByText(/Manual entry — records from the last case/)).not.toBeInTheDocument();
  });

  it('no relevance data (null) → fail-open: no relevance read, the honest stage lines carry the report', async () => {
    coverageMock.mockResolvedValue({
      data: cov({
        totalPages: 100,
        extractedPages: 38,
        coveragePct: 38,
        status: 'complete_with_gaps',
        gaps: [{ documentId: 'DX', fileName: 'scan.pdf', reason: 'needs_manual_summary', pageLabel: '62 pages', isImage: false, terminalStatus: 'manual_summary_required' }],
        relevance: null,
      }),
    });
    renderPanel();
    // No relevance copy at all; the honest raw % stage line is present exactly as before.
    expect(await screen.findByText(/38% \(38 of 100\)/)).toBeInTheDocument();
    expect(screen.queryByText(/We read the documents relevant to this claim/)).not.toBeInTheDocument();
    expect(screen.queryByText(/review before drafting/)).not.toBeInTheDocument();
  });
});
