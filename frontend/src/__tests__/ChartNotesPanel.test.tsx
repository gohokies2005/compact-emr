import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartNotesPanel } from '../routes/veterans/ChartNotesPanel';

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 'admin-sub', email: 'a@x.com', roles: ['admin'], role: 'admin' } }) }));
vi.mock('../api/chart-notes', () => ({
  // The backend now resolves createdByName (sub -> real name); the raw createdBy stays as the id.
  listChartNotes: vi.fn(async () => ({ data: [
    { id: 'N1', veteranId: 'VET-1', body: 'Spoke with the veteran today', createdBy: 'ops-sub', createdByName: 'Nina RN', isQuickNote: false, createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString(), version: 1 },
    { id: 'Q1', veteranId: 'VET-1', body: 'Awaiting records — C-file requested 6/8', createdBy: 'ops-sub', createdByName: 'Nina RN', isQuickNote: true, createdAt: new Date(Date.now() - 1_800_000).toISOString(), updatedAt: new Date().toISOString(), version: 1 },
  ] })),
  createChartNote: vi.fn(), patchChartNote: vi.fn(), deleteChartNote: vi.fn(), getLatestQuickNote: vi.fn(async () => ({ data: null })),
}));

describe('ChartNotesPanel', () => {
  it('renders existing notes with author + the add box', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ChartNotesPanel veteranId="VET-1" /></QueryClientProvider>);
    // The panel is now headless — the "Staff Notes" heading is the parent tab label, not an <h2> here.
    expect(screen.getByRole('button', { name: 'Save note' })).toBeInTheDocument();
    expect(await screen.findByText('Spoke with the veteran today')).toBeInTheDocument();
    // Shows the resolved NAME, never the raw Cognito sub (Ryan 2026-06-24).
    expect(screen.getAllByText(/Added by Nina RN/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/ops-sub/)).not.toBeInTheDocument();
    // admin sees edit + delete affordances
    expect(screen.getAllByRole('button', { name: 'Edit note' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Delete note' }).length).toBeGreaterThan(0);
  });

  it('renders the quick-note sticky and badges a quick note inline in the same stream', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ChartNotesPanel veteranId="VET-1" /></QueryClientProvider>);
    // The "sticky" fast-add control.
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Awaiting records/)).toBeInTheDocument();
    // The flagged quick note shows inline in the chronological list with a "Quick note" badge.
    expect(await screen.findByText('Awaiting records — C-file requested 6/8')).toBeInTheDocument();
    // Badge text appears (sticky header + the inline row badge → at least one).
    expect(screen.getAllByText('Quick note').length).toBeGreaterThan(0);
  });
});
