import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { VeteranChart } from '../routes/veterans/VeteranChart';

vi.mock('../api/veterans', () => ({
  getVeteran: vi.fn(async () => ({ data: { id: 'TEST-001', firstName: 'John', lastName: 'Smith', dob: '1980-01-01', email: 'test@example.com', branch: 'Navy', serviceStartYear: 2001, serviceEndYear: 2005, combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, scConditions: [], activeProblems: [], activeMedications: [], cases: [] } })),
  listDocuments: vi.fn(async () => ({ data: [] })), addScCondition: vi.fn(), updateScCondition: vi.fn(), addProblem: vi.fn(), addMedication: vi.fn(), deleteScCondition: vi.fn(), deleteProblem: vi.fn(), deleteMedication: vi.fn(), presignDocument: vi.fn(), recordDocument: vi.fn(), uploadToPresignedUrl: vi.fn(), downloadDocument: vi.fn(), deleteDocument: vi.fn(),
}));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 'u', email: 'a@x.com', roles: ['admin'], role: 'admin' } }) }));
vi.mock('../api/chart-notes', () => ({ listChartNotes: vi.fn(async () => ({ data: [] })), createChartNote: vi.fn(), patchChartNote: vi.fn(), deleteChartNote: vi.fn() }));
vi.mock('../api/lookup', () => ({ getConditions: vi.fn(async () => ({ groups: [{ system: 'Mental health', conditions: [{ value: 'PTSD', label: 'PTSD' }] }] })) }));

describe('VeteranChart', () => {
  it('renders veteran chart panels', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/veterans/TEST-001']}><Routes><Route path="/veterans/:id" element={<VeteranChart />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('Smith, John')).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes('MRN TEST-001'))).toBeInTheDocument();
    // Vet-file tab ORDER lock (UI sweep P2b, Ryan item 12): Claims, Staff Notes, then the shared
    // tail (Documents, SC Conditions, Active Problems, Medications) — only tabs a VETERAN owns.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Claims', 'Staff Notes', 'Documents', 'SC Conditions', 'Active Problems', 'Medications',
    ]);
    // The claim-scoped Email tab is dropped from the veteran chart (it belongs to a claim).
    expect(screen.queryByRole('tab', { name: 'Email' })).not.toBeInTheDocument();
    // Sticky tab bar (P2a) — class assertion on the shared TabBar.
    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('sticky');
    expect(tablist.className).toContain('top-0');
  });
});
