import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../api/client';
import { CaseMessagesPanel } from '../components/CaseMessagesPanel';
import { getCaseThreads } from '../api/messaging';
import { listUsers, listDirectory } from '../api/users';
import { listPhysicians } from '../api/physicians';

// The panel renders the case's STAFF-MESSAGE threads (new system). The reusable ThreadView +
// ComposeMessageModal have their own tests; here we mock them to focus on the panel's list/compose
// wiring (thread list, unread badge, locked case-link + default recipients, Open in Inbox link).
vi.mock('../api/messaging', () => ({ getCaseThreads: vi.fn() }));
vi.mock('../api/users', () => ({ listUsers: vi.fn(), listDirectory: vi.fn() }));
vi.mock('../api/physicians', () => ({ listPhysicians: vi.fn() }));
vi.mock('../lib/date', () => ({ formatRelativeTime: (value: string) => value }));

vi.mock('../components/messaging/ThreadView', () => ({
  ThreadView: ({ threadId }: { threadId: string }) => <div data-testid="thread-view">thread:{threadId}</div>,
}));

const composeProps = vi.fn();
vi.mock('../components/messaging/ComposeMessageModal', () => ({
  ComposeMessageModal: (props: Record<string, unknown>) => {
    composeProps(props);
    return <div data-testid="compose-modal">compose</div>;
  },
}));

const getCaseThreadsMock = vi.mocked(getCaseThreads);
const listUsersMock = vi.mocked(listUsers);
const listPhysiciansMock = vi.mocked(listPhysicians);
const listDirectoryMock = vi.mocked(listDirectory);

function renderPanel(props: Partial<Parameters<typeof CaseMessagesPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CaseMessagesPanel caseId="CASE-1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const THREAD = {
  threadId: 'thread-1',
  subject: 'Records question',
  caseId: 'CASE-1',
  lastMessageBody: 'Can you review this?',
  lastMessageAt: '2026-05-25T12:00:00.000Z',
  lastAuthorSub: 'rn-sub',
  messageCount: 1,
  unread: true,
};

describe('CaseMessagesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCaseThreadsMock.mockResolvedValue({ data: [THREAD] });
    listUsersMock.mockResolvedValue({
      data: [{ id: 'rn-sub', email: 'rn@example.com', name: 'Nurse Joy', active: true, roles: ['ops_staff'], version: 1 }],
    });
    // Messaging directory keys every row by the COGNITO SUB — the id message authors match on
    // (THREAD.lastAuthorSub === 'rn-sub'). This is what makes the sender resolve to a NAME, not "Staff".
    listDirectoryMock.mockResolvedValue({
      data: [
        { sub: 'rn-sub', name: 'Nurse Joy', role: 'ops_staff' },
        { sub: 'phys-sub', name: 'Dr. House', role: 'physician' },
      ],
    });
    listPhysiciansMock.mockResolvedValue({
      data: [
        {
          id: 'phys-1',
          cognitoSub: 'phys-sub',
          fullName: 'Dr. House',
          npi: '1',
          specialty: 'IM',
          medicalLicense: 'x',
          email: 'house@example.com',
          phone: null,
          hasSignature: true,
          hasCredentialBlock: true,
          boardName: null,
          boardAbbreviation: null,
          licenseState: null,
          licenseNumber: null,
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          version: 1,
        },
      ],
    });
  });

  it('renders the case threads, the unread badge, and the single thread inline', async () => {
    renderPanel();
    expect(await screen.findByText('Case messages')).toBeInTheDocument();
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
    // Exactly one thread → ThreadView renders inline (no list).
    expect(await screen.findByTestId('thread-view')).toHaveTextContent('thread:thread-1');
  });

  it('renders an Open in Inbox link that carries the case (so the inbox can default the case link)', async () => {
    renderPanel({ caseLabel: 'Smith — OSA' });
    const link = await screen.findByRole('link', { name: /Open in Inbox/ });
    expect(link).toHaveAttribute(
      'href',
      `/inbox?caseId=CASE-1&caseLabel=${encodeURIComponent('Smith — OSA')}`,
    );
  });

  it('composes a case-linked thread with the case locked + RN/physician defaulted as recipients', async () => {
    renderPanel({
      assignedRn: { id: 'rn-1', email: 'rn@example.com' },
      assignedPhysician: { id: 'phys-1', fullName: 'Dr. House', email: 'house@example.com' },
    });
    await screen.findByText('Case messages');
    // Resolve the directory queries before composing so defaults can be computed.
    await waitFor(() => expect(listPhysiciansMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    expect(await screen.findByTestId('compose-modal')).toBeInTheDocument();

    await waitFor(() => {
      const props = composeProps.mock.calls.at(-1)?.[0];
      // Case pre-linked + locked.
      expect(props.lockedCase).toEqual({ id: 'CASE-1', label: 'CASE-1' });
      // Recipients defaulted to the assigned RN (resolved by email -> sub) + physician (cognitoSub).
      const subs = props.initialRecipients.map((r: { send: { sub: string } }) => r.send.sub);
      expect(subs).toContain('rn-sub');
      expect(subs).toContain('phys-sub');
    });
  });

  it('shows a selectable list when there is more than one thread', async () => {
    getCaseThreadsMock.mockResolvedValue({
      data: [THREAD, { ...THREAD, threadId: 'thread-2', subject: 'Second thread', unread: false }],
    });
    renderPanel();
    expect(await screen.findByText('Records question')).toBeInTheDocument();
    expect(await screen.findByText('Second thread')).toBeInTheDocument();
    // The preview line resolves the author's cognito sub → their real name via the directory, NOT the
    // generic "Staff" fallback (the bug: staff authors were keyed by AppUser id and never matched).
    expect(await screen.findAllByText(/Nurse Joy/)).not.toHaveLength(0);
    expect(screen.queryByText(/^Staff:/)).not.toBeInTheDocument();
    // No thread auto-opens with multiple present until one is picked.
    expect(screen.queryByTestId('thread-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Second thread'));
    expect(await screen.findByTestId('thread-view')).toHaveTextContent('thread:thread-2');
  });

  it('renders a quiet not-available state on participant 403', async () => {
    getCaseThreadsMock.mockRejectedValueOnce(new ForbiddenError());
    renderPanel();
    expect(await screen.findByText('Messages are not available for this case.')).toBeInTheDocument();
  });
});
