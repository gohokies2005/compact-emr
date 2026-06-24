import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendToDoctorModal } from '../components/SendToDoctorModal';
import { createCaseMessage } from '../api/case-messages';

vi.mock('../api/case-messages', () => ({ createCaseMessage: vi.fn() }));
const createCaseMessageMock = vi.mocked(createCaseMessage);

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  createCaseMessageMock.mockResolvedValue({ data: {} } as never);
});

describe('SendToDoctorModal', () => {
  it('does not render when closed', () => {
    wrap(<SendToDoctorModal caseId="C1" open={false} onClose={() => {}} onConfirm={vi.fn()} />);
    expect(screen.queryByText('Send to doctor for review')).toBeNull();
  });

  it('empty message: transitions WITHOUT posting a message (behaves like the old confirm)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    wrap(<SendToDoctorModal caseId="C1" open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to doctor' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(createCaseMessageMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('with a message: posts the message THEN transitions', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    wrap(<SendToDoctorModal caseId="C1" open onClose={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByPlaceholderText(/Example:/), { target: { value: '  please double-check §VII  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send with message' }));

    await waitFor(() => expect(createCaseMessageMock).toHaveBeenCalledWith('C1', { body: 'please double-check §VII' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('transition failure: surfaces an error and does NOT close (case not moved)', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    const onClose = vi.fn();
    wrap(<SendToDoctorModal caseId="C1" open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to doctor' }));

    expect(await screen.findByText(/Could not send to the doctor/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
