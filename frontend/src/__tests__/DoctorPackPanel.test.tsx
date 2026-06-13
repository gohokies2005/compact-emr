import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoctorPackPanel } from '../components/DoctorPackPanel';
import {
  generateDoctorPack,
  getDoctorPackPdfUrl,
  getLatestDoctorPack,
  type DoctorPack,
} from '../api/doctorPack';
import { useAuth } from '../auth/useAuth';

// Minimal panel (Ryan 2026-06-12): JUST Open + Regenerate buttons — no title/subtitle, no doc list,
// no omission notes. The Case-documents list lives in the Documents tab now.
vi.mock('../api/doctorPack', async () => {
  const actual = await vi.importActual<typeof import('../api/doctorPack')>('../api/doctorPack');
  return {
    ...actual,
    getLatestDoctorPack: vi.fn(),
    generateDoctorPack: vi.fn(),
    getDoctorPackPdfUrl: vi.fn(),
  };
});

vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }));

const getLatestMock = vi.mocked(getLatestDoctorPack);
const generateMock = vi.mocked(generateDoctorPack);
const pdfUrlMock = vi.mocked(getDoctorPackPdfUrl);
const useAuthMock = vi.mocked(useAuth);

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
});

describe('DoctorPackPanel — just the buttons', () => {
  it('ready: shows the Open button with the page count and opens the presigned URL in a new tab', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    pdfUrlMock.mockResolvedValue({ data: { url: 'https://signed.example/pack.pdf', expiresAt: 'x', ttlSeconds: 300 } });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPanel();

    const openBtn = await screen.findByRole('button', { name: 'Open abridged notes (12pp)' });
    fireEvent.click(openBtn);

    await waitFor(() => expect(pdfUrlMock).toHaveBeenCalledWith('CASE-1', 'pack-1'));
    expect(openSpy).toHaveBeenCalledWith('https://signed.example/pack.pdf', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('ready: shows Regenerate for staff', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('ready + physician: Open only, NO Regenerate (view-only)', async () => {
    setRole('physician');
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    renderPanel();
    await screen.findByRole('button', { name: 'Open abridged notes (12pp)' });
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });

  it('does NOT render a title, subtitle, document list, or "Not included" clutter', async () => {
    getLatestMock.mockResolvedValue({ data: READY_PACK });
    renderPanel();
    await screen.findByRole('button', { name: 'Open abridged notes (12pp)' });
    expect(screen.queryByText('Abridged notes and records')).not.toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
    expect(screen.queryByText(/Curated chart abridgement/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Case documents/)).not.toBeInTheDocument();
  });

  it('generating: shows the in-flight spinner, no Open button', async () => {
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, state: 'generating', pageCount: null } });
    renderPanel();
    expect(await screen.findByText('Abridged notes generating…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open abridged notes/ })).toBeNull();
  });

  it('failed: surfaces the worker errorMessage VERBATIM and offers Regenerate to staff', async () => {
    const realError = 'pypdf failed to open cases/CASE-1/Misc_4.pdf: EOF marker not found';
    getLatestMock.mockResolvedValue({ data: { ...READY_PACK, state: 'failed', errorMessage: realError } });
    generateMock.mockResolvedValue({ data: { ...READY_PACK, state: 'queued' } });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Abridged notes generation failed');
    expect(alert).toHaveTextContent(realError); // verbatim — NO-SILENT-ERRORS

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(generateMock).toHaveBeenCalledWith('CASE-1'));
  });

  it('null + physician: explains the RN generates it; no Generate button (D-2 decision)', async () => {
    setRole('physician');
    getLatestMock.mockResolvedValue({ data: null });
    renderPanel();
    expect(await screen.findByText('No abridged notes yet — ask your RN to generate them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
  });

  it('null + staff: shows the "Generate now" button and it kicks off generation', async () => {
    getLatestMock.mockResolvedValue({ data: null });
    generateMock.mockResolvedValue({ data: { ...READY_PACK, state: 'queued' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate abridged notes' }));
    await waitFor(() => expect(generateMock).toHaveBeenCalledWith('CASE-1'));
  });

  it('generate failure surfaces the real API error via describeApiError (loud, not silent)', async () => {
    getLatestMock.mockResolvedValue({ data: null });
    generateMock.mockRejectedValue(new Error('chart_not_ready: 2 files still unread'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Generate abridged notes' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(String(alertSpy.mock.calls[0]?.[0])).toContain('chart_not_ready: 2 files still unread');
    alertSpy.mockRestore();
  });
});
