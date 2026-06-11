import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianQueuePage } from '../routes/physician/PhysicianQueuePage';
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
  assignedPhysicianId: null,
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
        <PhysicianQueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPhysicianMeMock.mockResolvedValue({ data: { id: 'PH-1', fullName: 'Jane Smith, DO', credentials: 'DO' } });
});

describe('PhysicianQueuePage', () => {
  it('renders cases awaiting physician review with a Review link', async () => {
    listCasesMock.mockResolvedValue({ data: [row], page: 1, pageSize: 50, total: 1 });
    renderQueue();

    expect(await screen.findByText('CASE-1')).toBeInTheDocument();
    expect(screen.getByText('Young, Matthew')).toBeInTheDocument();
    expect(screen.getByText('Obstructive sleep apnea')).toBeInTheDocument();
    const reviewLink = screen.getByRole('link', { name: 'Review' });
    expect(reviewLink).toHaveAttribute('href', '/p/review/CASE-1');
  });

  it('shows an empty state when the queue is clear', async () => {
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    renderQueue();

    expect(await screen.findByText('Queue is clear')).toBeInTheDocument();
  });

  // P4: personalized hero — "Good <tod>, Dr. <LastName>" from /physicians/me, with the
  // "Physician queue" framing below it.
  it('greets the physician as Dr. <LastName> with the Physician queue subtitle', async () => {
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    renderQueue();

    expect(await screen.findByText(/^Good (morning|afternoon|evening), Dr\. Smith$/)).toBeInTheDocument();
    expect(screen.getByText(/Physician queue/)).toBeInTheDocument();
  });

  it('falls back to the plain greeting when /physicians/me fails', async () => {
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    getPhysicianMeMock.mockRejectedValue(new Error('404 not_found'));
    renderQueue();

    expect(await screen.findByText(/^Good (morning|afternoon|evening)$/)).toBeInTheDocument();
  });
});
