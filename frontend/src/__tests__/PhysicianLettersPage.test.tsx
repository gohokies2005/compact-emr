import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianLettersPage } from '../routes/physician/PhysicianLettersPage';
import { listCases } from '../api/cases';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, listCases: vi.fn() };
});

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const listCasesMock = vi.mocked(listCases);

beforeEach(() => {
  vi.clearAllMocks();
  listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 50, total: 0 });
});

describe('PhysicianLettersPage', () => {
  // P4 rename lock: "My letters" -> "Completed Letters" (pairs with the "Completed Letters" nav tab).
  it('hero heading reads "Completed Letters"', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <PhysicianLettersPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Completed Letters' })).toBeInTheDocument();
    expect(screen.queryByText('My letters')).not.toBeInTheDocument();
    expect(await screen.findByText('No letters yet')).toBeInTheDocument();
  });
});
