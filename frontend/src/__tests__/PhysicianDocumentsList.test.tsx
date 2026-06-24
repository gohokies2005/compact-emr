import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PhysicianDocumentsList } from '../components/PhysicianDocumentsList';
import { listCaseDocuments } from '../api/veterans';

vi.mock('../api/veterans', () => ({ listCaseDocuments: vi.fn() }));
vi.mock('../components/PdfViewerModal', () => ({ PdfViewerModal: () => null }));
const listMock = vi.mocked(listCaseDocuments);

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PhysicianDocumentsList caseId="CASE-1" />
    </QueryClientProvider>,
  );
}

const doc = (over: Record<string, unknown>) => ({ id: 'D1', veteranId: 'VET-1', caseId: 'CASE-1', filename: 'f.pdf', autoTitle: 'A doc', contentType: 'application/pdf', s3Key: 'k', createdAt: '2026-06-24T00:00:00Z', ...over });

describe('PhysicianDocumentsList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the case-scoped files the server returns (scoping is server-side, not a client filter)', async () => {
    listMock.mockResolvedValue({ data: [doc({ id: 'D1', autoTitle: 'VA Rating Decision' }), doc({ id: 'D2', autoTitle: 'Service Treatment Records' })] } as never);
    renderList();
    await waitFor(() => expect(screen.getByText('VA Rating Decision')).toBeInTheDocument());
    expect(screen.getByText('Service Treatment Records')).toBeInTheDocument();
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
  });

  it('shows an empty state when the case has no documents', async () => {
    listMock.mockResolvedValue({ data: [] } as never);
    renderList();
    await waitFor(() => expect(screen.getByText(/No documents on this case/i)).toBeInTheDocument());
  });
});
