import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../routes/HomePage';
import { listCases, listFilesPendingManualGlobal, listKeyDocsNeedingReview } from '../api/cases';
import { listVeterans } from '../api/veterans';
import { getMe } from '../api/users';

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user: { role: 'ops_staff' }, role: 'ops_staff', loading: false }),
}));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return {
    ...actual,
    listCases: vi.fn(),
    listFilesPendingManualGlobal: vi.fn(),
    listKeyDocsNeedingReview: vi.fn(),
  };
});

vi.mock('../api/veterans', () => ({
  listVeterans: vi.fn(),
}));

vi.mock('../api/users', async () => {
  const actual = await vi.importActual<typeof import('../api/users')>('../api/users');
  return { ...actual, getMe: vi.fn() };
});

const listCasesMock = vi.mocked(listCases);
const manualMock = vi.mocked(listFilesPendingManualGlobal);
const keyDocsMock = vi.mocked(listKeyDocsNeedingReview);
const veteransMock = vi.mocked(listVeterans);
const getMeMock = vi.mocked(getMe);

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listCasesMock.mockResolvedValue({ data: [], page: 1, pageSize: 1, total: 0 });
  manualMock.mockResolvedValue({ data: [], total: 0 });
  keyDocsMock.mockResolvedValue({ data: [], total: 0 });
  veteransMock.mockResolvedValue({ data: [] });
  getMeMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', name: 'Riley Staffer, RN', roles: ['ops_staff'], avatarUrl: null } });
});

describe('HomePage', () => {
  it('renders live dashboard tiles, not the phase placeholders', async () => {
    renderHome();

    expect(await screen.findByText('RN queue')).toBeInTheDocument();
    expect(screen.getByText('Pre-draft cases')).toBeInTheDocument();
    expect(screen.getByText('Physician review')).toBeInTheDocument();

    expect(screen.queryByText(/Coming in Phase/i)).not.toBeInTheDocument();
  });

  it('renders the RN workflow step links', async () => {
    renderHome();

    expect(await screen.findByText('1. Open or create the veteran chart')).toBeInTheDocument();
    expect(screen.getByText('2. Complete RN file review')).toBeInTheDocument();
    expect(screen.getByText('3. Send the case to the drafter')).toBeInTheDocument();
  });

  // P4: personalized hero — first name from /users/me, time-of-day greeting from the shared helper.
  it('greets the staff member by first name', async () => {
    renderHome();

    expect(await screen.findByText(/^Good (morning|afternoon|evening), Riley$/)).toBeInTheDocument();
  });

  it('falls back to the plain greeting when /users/me fails (no AppUser row)', async () => {
    getMeMock.mockRejectedValue(new Error('404 not_found'));
    renderHome();

    expect(await screen.findByText(/^Good (morning|afternoon|evening)$/)).toBeInTheDocument();
  });
});
