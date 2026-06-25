import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianMobileQueuePage } from '../routes/physician/PhysicianMobileQueuePage';
import { listCases, type CaseLite } from '../api/cases';
import { getPhysicianMe } from '../api/physicians';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, listCases: vi.fn() };
});
vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, getPhysicianMe: vi.fn() };
});
vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const listCasesMock = vi.mocked(listCases);
const getPhysicianMeMock = vi.mocked(getPhysicianMe);

const row: CaseLite = {
  id: 'CASE-1',
  veteranId: 'VET-1',
  claimedCondition: 'Obstructive sleep apnea',
  claimType: 'supplemental',
  status: 'physician_review',
  version: 3,
  currentVersion: 2,
  assignedPhysicianId: 'PH-1',
  assignedRnId: null,
  refundEligible: false,
  createdAt: '2026-05-25T12:00:00.000Z',
  updatedAt: '2026-05-25T12:00:00.000Z',
  veteran: { id: 'VET-1', firstName: 'Matthew', lastName: 'Young', email: 'm@example.com' },
  assignedPhysician: null,
};

function renderQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PhysicianMobileQueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPhysicianMeMock.mockResolvedValue({ data: { id: 'PH-1', fullName: 'Jane Smith, DO', credentials: 'DO' } });
});

describe('PhysicianMobileQueuePage', () => {
  it('shows "N letters waiting for you" and a tappable review card per case', async () => {
    listCasesMock.mockResolvedValue({ data: [row], page: 1, pageSize: 50, total: 1 });
    renderQueue();

    expect(await screen.findByText('Obstructive sleep apnea')).toBeInTheDocument();
    expect(screen.getByText('1 letter is waiting for you.')).toBeInTheDocument();
    expect(screen.getByText('Young, Matthew')).toBeInTheDocument();
    // The card links to the MOBILE review route.
    const link = screen.getByRole('link', { name: /Review Obstructive sleep apnea/ });
    expect(link).toHaveAttribute('href', '/p/m/review/CASE-1');
  });

  it('filters the queue to the caller’s own cases via assignedPhysicianId once /me resolves', async () => {
    listCasesMock.mockResolvedValue({ data: [row], page: 1, pageSize: 50, total: 1 });
    renderQueue();

    await waitFor(() =>
      expect(listCasesMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'physician_review', assignedPhysicianId: 'PH-1' }),
      ),
    );
  });

  it('falls back to the unfiltered physician queue when /me has no mapping (404)', async () => {
    getPhysicianMeMock.mockRejectedValue(new Error('404 not_found'));
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    renderQueue();

    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    const call = listCasesMock.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining({ status: 'physician_review' }));
    expect(call).not.toHaveProperty('assignedPhysicianId');
  });

  it('shows a clear empty state when nothing is waiting', async () => {
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    renderQueue();

    expect(await screen.findByText('Queue is clear')).toBeInTheDocument();
    expect(screen.getByText('No letters waiting for you.')).toBeInTheDocument();
  });
});
