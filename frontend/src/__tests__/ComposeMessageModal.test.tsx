import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeMessageModal } from '../components/messaging/ComposeMessageModal';
import { sendMessage } from '../api/messaging';
import { listUsers } from '../api/users';
import { listPhysicians } from '../api/physicians';
import { listCases } from '../api/cases';

vi.mock('../api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../api/messaging')>('../api/messaging');
  return { ...actual, sendMessage: vi.fn() };
});
vi.mock('../api/users', () => ({ listUsers: vi.fn() }));
vi.mock('../api/physicians', () => ({ listPhysicians: vi.fn() }));
vi.mock('../api/cases', () => ({ listCases: vi.fn() }));

const sendMock = vi.mocked(sendMessage);
const listUsersMock = vi.mocked(listUsers);
const listPhysiciansMock = vi.mocked(listPhysicians);
const listCasesMock = vi.mocked(listCases);

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const onSent = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ComposeMessageModal onClose={onClose} onSent={onSent} />
    </QueryClientProvider>,
  );
  return { onClose, onSent };
}

describe('ComposeMessageModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUsersMock.mockResolvedValue({
      data: [{ id: 'rn-sub-1', email: 'rn@example.com', name: 'Nurse Joy', active: true, roles: ['ops_staff'], version: 1 }],
    });
    listPhysiciansMock.mockResolvedValue({ data: [] });
    listCasesMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 5 });
    sendMock.mockResolvedValue({ threadId: 'thread-1', messageId: 'msg-1' });
  });

  it('disables Send until a recipient + subject + body are all present', async () => {
    renderModal();
    const sendButton = screen.getByRole('button', { name: 'Send' });
    // Nothing filled in → disabled.
    expect(sendButton).toBeDisabled();

    // Subject + body but no recipient → still disabled.
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Question' } });
    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Hello there' } });
    expect(sendButton).toBeDisabled();

    // Add a recipient via the type-ahead.
    fireEvent.change(screen.getByLabelText('Add recipients'), { target: { value: 'Joy' } });
    fireEvent.click(await screen.findByText('Nurse Joy'));

    // Now all three present → enabled.
    expect(sendButton).toBeEnabled();
  });

  it('keeps the case search hidden until the optional "Link a case" toggle is on', () => {
    renderModal();
    // Toggle defaults OFF → no case search field.
    expect(screen.queryByLabelText('Search cases')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    // Toggled ON → the Cases-style search reveals.
    expect(screen.getByLabelText('Search cases')).toBeInTheDocument();

    // Toggling OFF again hides it (clearly skippable).
    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    expect(screen.queryByLabelText('Search cases')).not.toBeInTheDocument();
  });
});
