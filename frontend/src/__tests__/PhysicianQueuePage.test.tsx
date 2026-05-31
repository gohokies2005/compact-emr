import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianQueuePage } from '../routes/physician/PhysicianQueuePage';
import { listCases, type CaseLite } from '../api/cases';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, listCases: vi.fn() };
});

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const listCasesMock = vi.mocked(listCases);

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
});

describe('PhysicianQueuePage', () => {
  it('renders cases awaiting physician review with a Review link', async () => {
    listCasesMock.mockResolvedValue({ data: [row], page: 1, pageSize: 50, total: 1 });
    renderQueue();

    expect(await screen.findByText('CASE-1')).toBeInTheDocument();
    expect(screen.getByText('Matthew Young')).toBeInTheDocument();
    expect(screen.getByText('Obstructive sleep apnea')).toBeInTheDocument();
    const reviewLink = screen.getByRole('link', { name: 'Review' });
    expect(reviewLink).toHaveAttribute('href', '/p/review/CASE-1');
  });

  it('shows an empty state when the queue is clear', async () => {
    listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
    renderQueue();

    expect(await screen.findByText('Queue is clear')).toBeInTheDocument();
  });
});
