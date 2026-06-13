import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeMessageModal } from '../components/messaging/ComposeMessageModal';
import { sendMessage } from '../api/messaging';
import { listDirectory } from '../api/users';
import { listCases } from '../api/cases';
import { listVeterans } from '../api/veterans';

vi.mock('../api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../api/messaging')>('../api/messaging');
  return { ...actual, sendMessage: vi.fn() };
});
vi.mock('../api/users', () => ({ listDirectory: vi.fn() }));
vi.mock('../api/cases', () => ({ listCases: vi.fn() }));
vi.mock('../api/veterans', () => ({ listVeterans: vi.fn() }));

const sendMock = vi.mocked(sendMessage);
const listDirectoryMock = vi.mocked(listDirectory);
const listCasesMock = vi.mocked(listCases);
const listVeteransMock = vi.mocked(listVeterans);

// Minimal CaseLite/VeteranListItem shapes — only the fields the picker reads. Cast keeps the test
// from re-declaring the full Prisma row.
function vet(id: string, firstName: string, lastName: string, activeCases: number) {
  return { id, firstName, lastName, email: `${id}@example.com`, activeCases } as never;
}
function caseRow(id: string, veteranId: string, claimedCondition: string) {
  return { id, veteranId, claimedCondition } as never;
}

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
    listDirectoryMock.mockResolvedValue({
      data: [{ sub: 'rn-sub-1', name: 'Nurse Joy', role: 'ops_staff' }],
    });
    listCasesMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 5 });
    listVeteransMock.mockResolvedValue({ data: [] });
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

  it('keeps the veteran search hidden until the optional "Link a case" toggle is on', () => {
    renderModal();
    // Toggle defaults OFF → no veteran search field.
    expect(screen.queryByLabelText('Search veterans')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    // Toggled ON → the Cases-style veteran search reveals.
    expect(screen.getByLabelText('Search veterans')).toBeInTheDocument();

    // Toggling OFF again hides it (clearly skippable).
    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    expect(screen.queryByLabelText('Search veterans')).not.toBeInTheDocument();
  });

  it('searches veterans by name (not claim number) and auto-links a single-case veteran', async () => {
    listVeteransMock.mockResolvedValue({
      data: [
        vet('vet-smith', 'John', 'Smith', 1),
        vet('vet-smalls', 'Amy', 'Smalls', 1),
      ],
    });
    listCasesMock.mockResolvedValue({
      data: [caseRow('case-osa-1', 'vet-smith', 'osa')],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    renderModal();

    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    // Typing "Sm" surfaces matching veterans by NAME.
    fireEvent.change(screen.getByLabelText('Search veterans'), { target: { value: 'Sm' } });
    expect(await screen.findByText('Smith, John')).toBeInTheDocument();
    expect(screen.getByText('Smalls, Amy')).toBeInTheDocument();
    // The search went out by name, and never by a claim/case number.
    expect(listVeteransMock).toHaveBeenCalledWith('Sm');

    // Pick the veteran → single case auto-resolves to a name+condition chip (no claim number shown).
    fireEvent.click(screen.getByText('Smith, John'));
    expect(await screen.findByText('Smith, John — Obstructive Sleep Apnea (OSA)')).toBeInTheDocument();
    expect(screen.queryByText(/case-osa-1/)).not.toBeInTheDocument();
    expect(listCasesMock).toHaveBeenCalledWith({ veteranId: 'vet-smith', pageSize: 50 });
  });

  it('lets you pick which case for a multi-case veteran, resolving to a single caseId', async () => {
    listVeteransMock.mockResolvedValue({ data: [vet('vet-smith', 'John', 'Smith', 2)] });
    listCasesMock.mockResolvedValue({
      data: [caseRow('case-osa-1', 'vet-smith', 'osa'), caseRow('case-ptsd-1', 'vet-smith', 'ptsd')],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    renderModal();

    fireEvent.click(screen.getByLabelText('Link a case (optional)'));
    fireEvent.change(screen.getByLabelText('Search veterans'), { target: { value: 'Smith' } });
    fireEvent.click(await screen.findByText('Smith, John'));

    // Multi-case → per-case rows keyed on the condition, not a claim number.
    expect(await screen.findByText('Obstructive Sleep Apnea (OSA)')).toBeInTheDocument();
    expect(screen.getByText('PTSD')).toBeInTheDocument();

    // Choosing PTSD locks that one case.
    fireEvent.click(screen.getByText('PTSD'));
    expect(await screen.findByText('Smith, John — PTSD')).toBeInTheDocument();
  });
});
