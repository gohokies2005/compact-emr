import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../api/client';
import { CaseMessagesPanel } from '../components/CaseMessagesPanel';
import { createCaseMessage, listCaseMessages, markCaseMessagesRead } from '../api/case-messages';

vi.mock('../api/case-messages', () => ({ listCaseMessages: vi.fn(), createCaseMessage: vi.fn(), markCaseMessagesRead: vi.fn() }));
vi.mock('../lib/date', () => ({ formatRelativeTime: (value: string) => value }));

const listMock = vi.mocked(listCaseMessages);
const createMock = vi.mocked(createCaseMessage);
const markReadMock = vi.mocked(markCaseMessagesRead);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CaseMessagesPanel caseId="CASE-1" /></QueryClientProvider>);
}

describe('CaseMessagesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({
      unreadCount: 1,
      data: [{ id: 'msg-1', caseId: 'CASE-1', senderSub: 'rn-sub', senderRole: 'ops_staff', body: 'Can you review this question?', readAt: null, readBySub: null, createdAt: '2026-05-25T12:00:00.000Z' }],
    });
    createMock.mockResolvedValue({ data: { id: 'msg-2', caseId: 'CASE-1', senderSub: 'physician-sub', senderRole: 'physician', body: 'Yes, reviewed.', readAt: null, readBySub: null, createdAt: '2026-05-25T12:01:00.000Z' } });
    markReadMock.mockResolvedValue({ data: { markedCount: 1 } });
  });

  it('renders the thread and unread badge', async () => {
    renderPanel();
    expect(await screen.findByText('Case messages')).toBeInTheDocument();
    // Badge + thread are query-dependent — await them (the heading renders before the fetch resolves).
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText('RN')).toBeInTheDocument();
    expect(screen.getByText('Can you review this question?')).toBeInTheDocument();
  });

  it('marks messages read when opened', async () => {
    renderPanel();
    await screen.findByText('Can you review this question?');
    await waitFor(() => { expect(markReadMock).toHaveBeenCalledWith('CASE-1', { upToMessageId: 'msg-1' }); });
  });

  it('sends a composed message', async () => {
    renderPanel();
    await screen.findByText('Case messages');
    fireEvent.change(screen.getByPlaceholderText('Write a message for the assigned RN or physician.'), { target: { value: 'Yes, reviewed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => { expect(createMock).toHaveBeenCalledWith('CASE-1', { body: 'Yes, reviewed.' }); });
  });

  it('renders a quiet not-available state on participant 403', async () => {
    listMock.mockRejectedValueOnce(new ForbiddenError());
    renderPanel();
    expect(await screen.findByText('Messages are not available for this case.')).toBeInTheDocument();
  });
});
