import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { VeteransPage } from '../routes/veterans/VeteransPage';

vi.mock('../api/veterans', () => ({
  listVeterans: vi.fn(async () => ({ data: [{ id: 'TEST-001', firstName: 'John', lastName: 'Smith', dob: '1980-01-01', email: 'test@example.com', branch: 'Navy', serviceStartYear: 2001, serviceEndYear: 2005, combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, caseCount: 1, lastActivity: 'today' }] })),
  createVeteran: vi.fn(),
}));

vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

describe('VeteransPage', () => {
  it('renders search and veteran rows', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><VeteransPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('textbox', { name: /search veterans/i })).toBeInTheDocument();
    expect(await screen.findByText('TEST-001')).toBeInTheDocument();
  });
});
