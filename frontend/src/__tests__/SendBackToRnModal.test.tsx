import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendBackToRnModal } from '../components/SendBackToRnModal';
import { sendBackToRn } from '../api/drafter';

vi.mock('../api/drafter', async () => {
  const actual = await vi.importActual<typeof import('../api/drafter')>('../api/drafter');
  return { ...actual, sendBackToRn: vi.fn() };
});

const sendBackToRnMock = vi.mocked(sendBackToRn);

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const onClose = vi.fn();
  const onDone = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <SendBackToRnModal
        caseId="CASE-3"
        veteranId="VET-3"
        from="physician_review"
        version={7}
        open
        onClose={onClose}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );

  return { onClose, onDone };
}

describe('SendBackToRnModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // sendBackToRn resolves void (it routes to /letter/decline or a plain status transition).
    sendBackToRnMock.mockResolvedValue(undefined);
  });

  it('submitting calls sendBackToRn with the textarea content', async () => {
    const { onClose, onDone } = renderModal();

    expect(screen.getByText('Send back for major rework')).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText(
        'Example: Rework the overall theory around aggravation rather than direct service connection.',
      ),
      {
        target: { value: 'Use a different overall approach.' },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));

    await waitFor(() => {
      expect(sendBackToRnMock).toHaveBeenCalledWith({
        caseId: 'CASE-3',
        veteranId: 'VET-3',
        from: 'physician_review',
        version: 7,
        note: 'Use a different overall approach.',
      });
    });

    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
