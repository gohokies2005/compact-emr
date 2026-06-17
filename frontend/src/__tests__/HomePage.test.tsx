import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../routes/HomePage';
import { getDashboard, type DashboardResponse } from '../api/reports';
import { getMe } from '../api/users';

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user: { role: 'ops_staff' }, role: 'ops_staff', loading: false }),
}));

vi.mock('../layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../api/reports')>('../api/reports');
  return { ...actual, getDashboard: vi.fn() };
});

vi.mock('../api/users', async () => {
  const actual = await vi.importActual<typeof import('../api/users')>('../api/users');
  return { ...actual, getMe: vi.fn() };
});

const getDashboardMock = vi.mocked(getDashboard);
const getMeMock = vi.mocked(getMe);

// A full 10-tile payload mirroring the D1 contract (backend/src/routes/dashboard.ts), including the
// non-clickable turnaround tile and the three red-when-nonzero delinquency tiles.
const TILES: DashboardResponse = {
  generatedAt: '2026-06-13T12:00:00.000Z',
  timezone: 'America/Los_Angeles',
  pacificMidnightUtc: '2026-06-13T07:00:00.000Z',
  tiles: [
    { key: 'new_intakes_today', label: 'New intakes today', count: 4, clickable: true, filter: { kind: 'intakes', createdSince: '2026-06-13T07:00:00.000Z' } },
    { key: 'stage1_turnaround_7d', label: 'Avg intake-to-pickup (7d)', value: 18.4, unit: 'hours', clickable: false },
    { key: 'rn_queue', label: 'RN queue', count: 7, clickable: true, filter: { kind: 'cases', statuses: ['rn_review', 'needs_rn_decision', 'correction_requested', 'correction_review'] } },
    { key: 'pre_draft', label: 'Pre-draft', count: 3, clickable: true, filter: { kind: 'cases', statuses: ['intake', 'viability'] } },
    { key: 'rn_review', label: 'RN review', count: 2, clickable: true, filter: { kind: 'cases', status: 'rn_review' } },
    { key: 'physician_review', label: 'Physician review', count: 1, clickable: true, filter: { kind: 'cases', status: 'physician_review' } },
    { key: 'delinquent_intakes', label: 'Delinquent intakes', count: 5, clickable: true, filter: { kind: 'intakes', status: 'pending', olderThanDays: 7 } },
    { key: 'delinquent_payments', label: 'Delinquent payments', count: 2, clickable: true, filter: { kind: 'cases', status: 'delivered', unpaidLetter500OlderThanDays: 3 } },
    { key: 'stuck_drafts', label: 'Stuck drafts', count: 0, clickable: true, filter: { kind: 'draft-jobs', stuck: true, startedBeforeMinutes: 45, staleHeartbeat: true } },
    { key: 'total_veterans', label: 'Total veterans', count: 120, clickable: true, filter: { kind: 'veterans' } },
  ],
};

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
  getDashboardMock.mockResolvedValue(TILES);
  getMeMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', name: 'Riley Staffer, RN', roles: ['ops_staff'], avatarUrl: null } });
});

describe('HomePage', () => {
  it('renders all 10 dashboard tiles from getDashboard', async () => {
    renderHome();

    expect(await screen.findByText('New intakes today')).toBeInTheDocument();
    for (const tile of TILES.tiles) {
      expect(screen.getByText(tile.label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Coming in Phase/i)).not.toBeInTheDocument();
  });

  it('deep-links a single-status tile with ?status=', async () => {
    renderHome();
    const card = (await screen.findByText('Physician review')).closest('a');
    expect(card).toHaveAttribute('href', '/cases?status=physician_review');
  });

  it('deep-links a group tile with the comma-joined ?statuses=', async () => {
    renderHome();
    const card = (await screen.findByText('RN queue')).closest('a');
    expect(card).toHaveAttribute(
      'href',
      `/cases?statuses=${encodeURIComponent('rn_review,needs_rn_decision,correction_requested,correction_review')}`,
    );
  });

  it('deep-links the delinquent-intakes tile to the pending intake pool', async () => {
    renderHome();
    const card = (await screen.findByText('Delinquent intakes')).closest('a');
    expect(card).toHaveAttribute('href', '/intake?status=pending');
  });

  it('the 7-day turnaround tile is NOT a link and shows value + unit', async () => {
    renderHome();
    const label = await screen.findByText('Avg intake-to-pickup (7d)');
    expect(label.closest('a')).toBeNull();
    // Card renders a <section>; scope to it so we read THIS tile's value, not another's.
    const card = label.closest('section');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('18.4 hours')).toBeInTheDocument();
  });

  it('paints delinquent tiles red only when their count is > 0', async () => {
    renderHome();
    // delinquent_intakes count=5 → red value text; stuck_drafts count=0 → neutral. The Card is a
    // <section>, so scope to closest('section') (closest('div') would escape to the grid wrapper).
    const intakesValue = (await screen.findByText('Delinquent intakes')).closest('section')?.querySelector('p.text-3xl');
    expect(intakesValue?.className).toContain('text-rose-700');
    const stuckValue = screen.getByText('Stuck drafts').closest('section')?.querySelector('p.text-3xl');
    expect(stuckValue?.className).not.toContain('text-rose-700');
  });

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
