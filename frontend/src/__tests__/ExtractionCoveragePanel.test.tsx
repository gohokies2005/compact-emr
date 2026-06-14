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
