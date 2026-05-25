import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClarificationsPanel } from '../components/ClarificationsPanel';
import { ConflictError } from '../api/client';
import {
  createClarification,
  listClarifications,
  resolveClarification,
  type Clarification,
} from '../api/cases';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return {
    ...actual,
    listClarifications: vi.fn(),
    createClarification: vi.fn(),
    resolveClarification: vi.fn(),
  };
});

vi.mock('../lib/date', () => ({
  formatRelativeTime: (value: string) => value,
}));

const listClarificationsMock = vi.mocked(listClarifications);
const createClarificationMock = vi.mocked(createClarification);
const resolveClarificationMock = vi.mocked(resolveClarification);

const openClarification: Clarification = {
  id: 'CLAR-1',
  caseId: 'CASE-1',
  audience: 'physician',
  status: 'open',
  question: 'Please confirm whether the diagnosis appears in the uploaded records.',
  resolution: null,
  raisedBy: 'ops-user-sub',
  resolvedBy: null,
  createdAt: '2026-05-25T12:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
  resolvedAt: null,
};

const resolvedClarification: Clarification = {
  ...openClarification,
  status: 'resolved',
  resolution: 'Reviewed by physician.',
  resolvedBy: 'physician-sub',
  updatedAt: '2026-05-25T13:00:00.000Z',
  resolvedAt: '2026-05-25T13:00:00.000Z',
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ClarificationsPanel caseId="CASE-1" />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  listClarificationsMock.mockResolvedValue({ data: [openClarification] });
  createClarificationMock.mockResolvedValue({
    data: { ...openClarification, id: 'CLAR-2', audience: 'veteran', question: 'Upload the denial letter.' },
  });
  resolveClarificationMock.mockResolvedValue({ data: resolvedClarification });
});

describe('ClarificationsPanel', () => {
  it('renders rows from listClarifications', async () => {
    renderPanel();
    expect(await screen.findByText(openClarification.question)).toBeInTheDocument();
    expect(screen.getByText('Physician')).toBeInTheDocument();
    // 'Open' appears twice (filter chip + status pill on the row) — at least one matches.
    expect(screen.getAllByText('Open').length).toBeGreaterThanOrEqual(1);
  });

  it('switching filter chips refetches with the right statusParam', async () => {
    renderPanel();
    await screen.findByText(openClarification.question);

    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await waitFor(() => expect(listClarificationsMock).toHaveBeenCalledWith('CASE-1', 'resolved'));

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(listClarificationsMock).toHaveBeenCalledWith('CASE-1', undefined));
  });

  it('raise form posts the right body shape with the chosen audience', async () => {
    renderPanel();
    await screen.findByText(openClarification.question);

    fireEvent.click(screen.getByRole('button', { name: 'Raise clarification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Veteran' }));
    fireEvent.change(
      screen.getByPlaceholderText('What needs to be clarified before this case can move forward?'),
      { target: { value: 'Upload the denial letter.' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(createClarificationMock).toHaveBeenCalledWith('CASE-1', {
        audience: 'veteran',
        question: 'Upload the denial letter.',
      }),
    );
  });

  it('shows the veteran-audience info banner when veteran is selected', async () => {
    renderPanel();
    await screen.findByText(openClarification.question);
    fireEvent.click(screen.getByRole('button', { name: 'Raise clarification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Veteran' }));
    expect(screen.getByText(/will appear in the records request the veteran receives/i)).toBeInTheDocument();
  });

  it('resolve flips the row to resolved with the right body shape', async () => {
    // After resolve fires, the list query is invalidated and refetched. Have the mock return
    // the resolved row on subsequent calls so the resolution text actually shows up in the DOM.
    listClarificationsMock.mockImplementation(async (_caseId, status) => {
      if (status === 'resolved') return { data: [resolvedClarification] };
      // 'open' filter (default) — after resolve the row is no longer open.
      return { data: [] };
    });
    renderPanel();
    // Switch to 'All' so the resolved row stays visible after the flip.
    await screen.findByRole('button', { name: 'Raise clarification' });
    // Re-prime the mock for the 'all' fetch (status=undefined).
    listClarificationsMock.mockImplementation(async (_caseId, status) => {
      if (status === undefined) return { data: [resolvedClarification] };
      if (status === 'resolved') return { data: [resolvedClarification] };
      return { data: [openClarification] };
    });
    // Re-list with original mock to render the open row first.
    listClarificationsMock.mockResolvedValueOnce({ data: [openClarification] });

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByText(openClarification.question);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    fireEvent.change(screen.getByPlaceholderText('Optional resolution note.'), {
      target: { value: 'Reviewed by physician.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm resolved' }));

    await waitFor(() =>
      expect(resolveClarificationMock).toHaveBeenCalledWith('CLAR-1', {
        status: 'resolved',
        resolution: 'Reviewed by physician.',
      }),
    );
    expect(await screen.findByText('Reviewed by physician.')).toBeInTheDocument();
  });

  it('on 409 ConflictError, shows "already resolved" message', async () => {
    resolveClarificationMock.mockRejectedValueOnce(new ConflictError());
    renderPanel();
    await screen.findByText(openClarification.question);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm resolved' }));
    expect(await screen.findByText('This clarification was already resolved.')).toBeInTheDocument();
  });
});
