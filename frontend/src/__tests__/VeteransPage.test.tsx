import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VeteransPage } from '../routes/veterans/VeteransPage';
import * as veteransApi from '../api/veterans';

vi.mock('../api/veterans', () => ({
  listVeterans: vi.fn(),
  createVeteran: vi.fn(),
}));

vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

function vet(id: string, firstName: string, lastName: string): veteransApi.VeteranListItem {
  return { id, firstName, lastName, dob: '1980-01-01', email: 'test@example.com', branch: 'Navy', serviceStartYear: 2001, serviceEndYear: 2005, combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, activeCases: 1 };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><VeteransPage /></MemoryRouter></QueryClientProvider>);
}

const listVeterans = vi.mocked(veteransApi.listVeterans);

beforeEach(() => {
  listVeterans.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VeteransPage', () => {
  it('renders the search box and veteran rows', async () => {
    listVeterans.mockResolvedValue({ data: [vet('TEST-001', 'John', 'Smith')], pagination: { page: 1, limit: 100, total: 1, hasMore: false } });
    renderPage();
    expect(screen.getByRole('textbox', { name: /search veterans/i })).toBeInTheDocument();
    expect(await screen.findByText('Smith, John')).toBeInTheDocument();
    expect(screen.getByText('MRN TEST-001')).toBeInTheDocument();
  });

  it('passes the typed query to the SERVER-side search (debounced), so search spans the full set not just the loaded page', async () => {
    const user = userEvent.setup();
    listVeterans.mockResolvedValue({ data: [vet('WARREN-1', 'Warren', 'Zylinski')], pagination: { page: 1, limit: 100, total: 1, hasMore: false } });
    renderPage();
    await screen.findByText('Zylinski, Warren');

    await user.type(screen.getByRole('textbox', { name: /search veterans/i }), 'warr');

    // The debounced query reaches the API as the `q` argument (server-side search).
    await waitFor(() => {
      expect(listVeterans).toHaveBeenCalledWith('warr', expect.anything());
    });
  });

  it('shows "Showing X of Y" and a working "Show more" that fetches the NEXT page when hasMore', async () => {
    const user = userEvent.setup();
    // Page 1 has more; page 2 completes the set. Proves every veteran is reachable via load-more.
    listVeterans.mockImplementation(async (_q: string, page = 1) => {
      if (page === 1) return { data: [vet('P1-001', 'Anna', 'Adams')], pagination: { page: 1, limit: 1, total: 2, hasMore: true } };
      return { data: [vet('P2-001', 'Warren', 'Zylinski')], pagination: { page: 2, limit: 1, total: 2, hasMore: false } };
    });
    renderPage();

    await screen.findByText('Adams, Anna');
    expect(screen.getByText(/showing 1 of 2 veterans/i)).toBeInTheDocument();

    const showMore = screen.getByRole('button', { name: /show more/i });
    await user.click(showMore);

    // Page-2 veteran (previously hidden past the cap) is now reachable.
    expect(await screen.findByText('Zylinski, Warren')).toBeInTheDocument();
    expect(screen.getByText(/showing 2 of 2 veterans/i)).toBeInTheDocument();
    expect(listVeterans).toHaveBeenCalledWith('', 2);
    // Fully loaded → no more "Show more".
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });
});
