import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartNotesPanel } from '../routes/veterans/ChartNotesPanel';

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 'admin-sub', email: 'a@x.com', roles: ['admin'], role: 'admin' } }) }));
vi.mock('../api/chart-notes', () => ({
  listChartNotes: vi.fn(async () => ({ data: [{ id: 'N1', veteranId: 'VET-1', body: 'Spoke with the veteran today', createdBy: 'ops-sub', createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString(), version: 1 }] })),
  createChartNote: vi.fn(), patchChartNote: vi.fn(), deleteChartNote: vi.fn(),
}));

describe('ChartNotesPanel', () => {
  it('renders existing notes with author + the add box', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ChartNotesPanel veteranId="VET-1" /></QueryClientProvider>);
    // The panel is now headless — the "Staff Notes" heading is the parent tab label, not an <h2> here.
    expect(screen.getByRole('button', { name: 'Save note' })).toBeInTheDocument();
    expect(await screen.findByText('Spoke with the veteran today')).toBeInTheDocument();
    expect(screen.getByText(/Added by ops-sub/)).toBeInTheDocument();
    // admin sees edit + delete affordances
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
  });
});
