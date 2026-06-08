import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysiciansPage } from '../routes/admin/PhysiciansPage';
import { listPhysicians, linkPhysicianLogin, type PhysicianPublic } from '../api/physicians';

vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, listPhysicians: vi.fn(), linkPhysicianLogin: vi.fn(), updatePhysician: vi.fn() };
});
// AppShell + the signature control pull auth/layout; stub them so the page renders in isolation.
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../components/PhysicianSignatureControl', () => ({ PhysicianSignatureControl: () => <div>signature-control</div> }));

const listMock = vi.mocked(listPhysicians);
const linkMock = vi.mocked(linkPhysicianLogin);

function physician(overrides: Partial<PhysicianPublic> = {}): PhysicianPublic {
  return {
    id: 'P-1', cognitoSub: null, fullName: 'Dr. Linked, MD', npi: '1111111111', specialty: 'FM',
    medicalLicense: 'NV-1', email: 'linked@x.test', phone: null, hasSignature: false, hasCredentialBlock: true,
    boardName: 'ABFM', boardAbbreviation: 'ABFM', licenseState: 'Nevada', licenseNumber: '1', active: true,
    createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', version: 1, ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><PhysiciansPage /></MemoryRouter></QueryClientProvider>);
}

describe('PhysiciansPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ data: [
      physician({ id: 'P-NULL', email: 'orphan@x.test', cognitoSub: null }),
      physician({ id: 'P-LINKED', email: 'haslogin@x.test', cognitoSub: 'sub-existing' }),
    ] });
    linkMock.mockResolvedValue({ data: { physicianId: 'P-NULL', cognitoSub: 'sub-new', email: 'orphan@x.test', appUserId: 'U-9', credential: 'invite' } });
  });

  it('is titled "Physician credentials" and no longer offers a New physician create card', async () => {
    renderPage();
    expect(await screen.findByText('Physician credentials')).toBeInTheDocument();
    expect(screen.queryByText('New physician')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create physician' })).not.toBeInTheDocument();
  });

  it('shows Link login ONLY for profiles whose cognitoSub is null', async () => {
    renderPage();
    await screen.findByText('orphan@x.test');
    // Exactly one Link login button — for the cognitoSub-null row only.
    expect(screen.getAllByRole('button', { name: 'Link login' })).toHaveLength(1);
  });

  it('link-login dialog defaults to invite-email and posts credential invite', async () => {
    renderPage();
    await screen.findByText('orphan@x.test');
    fireEvent.click(screen.getByRole('button', { name: 'Link login' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create login (email invite)' }));
    await waitFor(() => expect(linkMock).toHaveBeenCalledWith('P-NULL', { credential: 'invite' }));
  });

  it('link-login temp-password mode validates strength before posting', async () => {
    renderPage();
    await screen.findByText('orphan@x.test');
    fireEvent.click(screen.getByRole('button', { name: 'Link login' }));
    fireEvent.click(await screen.findByLabelText(/Set a temporary password/));
    fireEvent.change(screen.getByPlaceholderText(/12\+ chars/), { target: { value: 'weak' } });
    const submit = screen.getByRole('button', { name: 'Create login (temp password)' });
    expect(submit).toBeDisabled();
    expect(linkMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/12\+ chars/), { target: { value: 'FrnTest-2026!!' } });
    fireEvent.click(submit);
    await waitFor(() => expect(linkMock).toHaveBeenCalledWith('P-NULL', { credential: 'temp_password', tempPassword: 'FrnTest-2026!!' }));
  });
});
