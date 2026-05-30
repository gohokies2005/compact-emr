import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { VeteranChart } from '../routes/veterans/VeteranChart';

vi.mock('../api/veterans', () => ({
  getVeteran: vi.fn(async () => ({ data: { id: 'TEST-001', firstName: 'John', lastName: 'Smith', dob: '1980-01-01', email: 'test@example.com', branch: 'Navy', serviceStartYear: 2001, serviceEndYear: 2005, combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, scConditions: [], activeProblems: [], activeMedications: [], cases: [] } })),
  listDocuments: vi.fn(async () => ({ data: [] })), addScCondition: vi.fn(), updateScCondition: vi.fn(), addProblem: vi.fn(), addMedication: vi.fn(), deleteScCondition: vi.fn(), deleteProblem: vi.fn(), deleteMedication: vi.fn(), presignDocument: vi.fn(), recordDocument: vi.fn(), uploadToPresignedUrl: vi.fn(), downloadDocument: vi.fn(),
}));
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { sub: 'u', email: 'a@x.com', roles: ['admin'], role: 'admin' } }) }));
vi.mock('../api/chart-notes', () => ({ listChartNotes: vi.fn(async () => ({ data: [] })), createChartNote: vi.fn(), patchChartNote: vi.fn(), deleteChartNote: vi.fn() }));
vi.mock('../api/lookup', () => ({ getConditions: vi.fn(async () => ({ groups: [{ system: 'Mental health', conditions: [{ value: 'PTSD', label: 'PTSD' }] }] })) }));

describe('VeteranChart', () => {
  it('renders veteran chart panels', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/veterans/TEST-001']}><Routes><Route path="/veterans/:id" element={<VeteranChart />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes('MRN TEST-001'))).toBeInTheDocument();
    // The previously-buried tables are now top-level tabs, in owner-specified order.
    expect(screen.getByRole('tab', { name: 'FRN Claims' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Staff Notes' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Service Connected Conditions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Active Problems' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Medications' })).toBeInTheDocument();
  });
});
