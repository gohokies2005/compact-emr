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
  return {
    totalPages: 120,
    extractedPages: 120,
    coveragePct: 100,
    gaps: [],
    status: 'complete',
    unknownPageFiles: 0,
    totalFiles: 10,
    pageBreakdown: null,
    ...over,
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
  it('renders a 100% clean headline with no details toggle', async () => {
    coverageMock.mockResolvedValue({ data: cov() });
    renderPanel();
    expect(await screen.findByText(/100% of pages extracted \(120 of 120\)/)).toBeInTheDocument();
    expect(screen.getByText(/successfully read and extracted/)).toBeInTheDocument();
    // No gaps → no "Show items" toggle.
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
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

    expect(await screen.findByText(/98% of pages extracted \(118 of 120\)/)).toBeInTheDocument();

    // Expand the details.
    fireEvent.click(screen.getByRole('button', { name: /Show 1 item/ }));
    expect(await screen.findByText('scan.jpg')).toBeInTheDocument();
    expect(screen.getByText(/Image couldn’t be read as text/)).toBeInTheDocument();

    // View file → opens the inline viewer (presigned).
    fireEvent.click(screen.getByRole('button', { name: 'View file' }));
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
    expect(await screen.findByText('record.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request AI description' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View file' })).toBeInTheDocument();
  });
});
