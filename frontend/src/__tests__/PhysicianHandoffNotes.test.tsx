import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PhysicianHandoffNotes } from '../components/PhysicianHandoffNotes';
import { listCaseMessages } from '../api/case-messages';

vi.mock('../api/case-messages', () => ({ listCaseMessages: vi.fn() }));
const listMock = vi.mocked(listCaseMessages);

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PhysicianHandoffNotes caseId="CASE-1" />
    </QueryClientProvider>,
  );
}

describe('PhysicianHandoffNotes (Spring handoff-note bug fix)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the RN handoff note the doctor could not see before', async () => {
    listMock.mockResolvedValue({
      data: [{ id: 'M1', caseId: 'CASE-1', senderSub: 'rn-1', senderRole: 'ops_staff', body: 'Flagging the 1996 weight note as the key in-service hook.', readAt: null, readBySub: null, createdAt: '2026-06-24T18:00:00.000Z' }],
      unreadCount: 1,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/1996 weight note/)).toBeInTheDocument());
    expect(screen.getByText(/Notes from the care team/i)).toBeInTheDocument();
    expect(screen.getByText(/Care team \(RN\)/i)).toBeInTheDocument();
  });

  it('renders NOTHING when there are no notes (no empty clutter on the review page)', async () => {
    listMock.mockResolvedValue({ data: [], unreadCount: 0 });
    const { container } = renderPanel();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('fails open — a fetch error hides the panel, never crashes the review page', async () => {
    listMock.mockRejectedValue(new Error('403'));
    const { container } = renderPanel();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
