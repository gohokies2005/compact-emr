import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendToDrafterPanel } from '../components/SendToDrafterPanel';
import { getChartReadiness } from '../api/chart-readiness';
import { postDraft } from '../api/drafter';

vi.mock('../api/chart-readiness', () => ({
  getChartReadiness: vi.fn(),
}));

vi.mock('../api/drafter', () => ({
  postDraft: vi.fn(),
}));

const readinessMock = vi.mocked(getChartReadiness);
const postDraftMock = vi.mocked(postDraft);

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<SendToDrafterPanel caseId="CASE-1" />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  postDraftMock.mockResolvedValue({ data: { job: { id: 'job-1' }, publish: {} } });
});

describe('SendToDrafterPanel', () => {
  it('enables the button and calls postDraft when the chart is ready', async () => {
    readinessMock.mockResolvedValue({ data: { ready: true } });
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Send to Drafter' });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(await screen.findByText('Chart is ready for drafting.')).toBeInTheDocument();

    button.click();
    await waitFor(() => expect(postDraftMock).toHaveBeenCalledWith('CASE-1'));
  });

  it('disables the button and explains the blocker when the chart is not ready', async () => {
    readinessMock.mockResolvedValue({
      data: {
        ready: false,
        blockingFiles: [
          { filePath: 'records/garbled.pdf', terminalStatus: 'manual_summary_required' },
        ],
      },
    });
    renderPanel();

    expect(await screen.findByText('Chart is not ready for drafting')).toBeInTheDocument();
    expect(
      screen.getByText('1 file(s) need RN manual summary before drafting.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Drafter' })).toBeDisabled();
    expect(postDraftMock).not.toHaveBeenCalled();
  });
});
