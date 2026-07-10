import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SendToDoctorModal } from '../components/SendToDoctorModal';

// Ryan 2026-07-09 lost-notes fix: the handoff note no longer posts via a separate createCaseMessage
// call (which 403'd + silently dropped off-assignment). It rides WITH the transition — onConfirm(note)
// carries it, the parent's /status call persists it server-side atomically. So there is NOTHING to mock
// here beyond onConfirm; the ONLY load-bearing call is onConfirm(trimmedNote).

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe('SendToDoctorModal', () => {
  it('does not render when closed', () => {
    wrap(<SendToDoctorModal caseId="C1" open={false} onClose={() => {}} onConfirm={vi.fn()} />);
    expect(screen.queryByText('Send to doctor for review')).toBeNull();
  });

  it('empty message: transitions with an EMPTY handoff note (behaves like the old bare confirm)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    wrap(<SendToDoctorModal caseId="C1" open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to doctor' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // The single load-bearing call carries an empty note; the parent omits handoffMessage from /status.
    expect(onConfirm).toHaveBeenCalledWith('');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('with a message: the trimmed note rides WITH the transition (one atomic call, no separate POST)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    wrap(<SendToDoctorModal caseId="C1" open onClose={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByPlaceholderText(/Example:/), { target: { value: '  please double-check §VII  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send with message' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // The note is passed to the transition (trimmed) — it can no longer be dropped by a separate gated POST.
    expect(onConfirm).toHaveBeenCalledWith('please double-check §VII');
  });

  it('no-block preserved: the note can never block the send because it is one atomic call (server truncates, never rejects)', async () => {
    // With the note folded into the transition, there is no independent note step that can fail while the
    // case moves. Either the send (with note) succeeds, or it fails cleanly and nothing moved. This test
    // locks that there is exactly ONE call and no window.alert "wasn't attached" fallback path remains.
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    wrap(<SendToDoctorModal caseId="C1" open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByPlaceholderText(/Example:/), { target: { value: 'a note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send with message' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith('a note');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // No "your note wasn't attached" alert path anymore — the note is guaranteed to have been saved.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('transition failure: surfaces an error and does NOT close (case not moved, note not saved)', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    const onClose = vi.fn();
    wrap(<SendToDoctorModal caseId="C1" open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send to doctor' }));

    expect(await screen.findByText(/Could not send to the doctor/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
