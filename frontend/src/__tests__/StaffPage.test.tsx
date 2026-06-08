import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffPage } from '../routes/admin/StaffPage';
import { createStaff, listUsers, setStaffActive, resetStaffPassword, unlockStaff } from '../api/users';

vi.mock('../api/users', async () => {
  const actual = await vi.importActual<typeof import('../api/users')>('../api/users');
  return { ...actual, listUsers: vi.fn(), createStaff: vi.fn(), setStaffActive: vi.fn(), resetStaffPassword: vi.fn(), unlockStaff: vi.fn() };
});
// AppShell pulls auth/layout; stub it to a passthrough so the page renders in isolation.
vi.mock('../layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const listMock = vi.mocked(listUsers);
const createMock = vi.mocked(createStaff);
const toggleMock = vi.mocked(setStaffActive);
const resetMock = vi.mocked(resetStaffPassword);
const unlockMock = vi.mocked(unlockStaff);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><StaffPage /></MemoryRouter></QueryClientProvider>);
}

describe('StaffPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ data: [
      { id: 'U-1', email: 'rn@x.test', name: 'RN One', active: true, roles: ['ops_staff'], version: 1 },
      { id: 'U-2', email: 'old@x.test', name: 'Old Staff', active: false, roles: ['ops_staff'], version: 4 },
    ] });
    createMock.mockResolvedValue({ data: { id: 'U-N', cognitoSub: 's', email: 'zzz@x.test', name: 'ZZZ', roles: ['ops_staff'], active: true, credential: 'temp_password', physicianId: null, physicianReadyToSign: false } });
    toggleMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', name: 'RN One', active: false, roles: ['ops_staff'], version: 2 } });
    resetMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', mode: 'email_code' } });
    unlockMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', targetIsAdmin: false } });
  });

  it('lists active + inactive staff (includeInactive)', async () => {
    renderPage();
    expect(await screen.findByText('rn@x.test')).toBeInTheDocument();
    expect(screen.getByText('old@x.test')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({ includeInactive: true });
  });

  it('requires physician credentials only when physician role is checked', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    expect(screen.queryByLabelText('NPI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Physician (can sign)'));
    expect(screen.getByText(/NPI/)).toBeInTheDocument();
  });

  it('creates an ops_staff with a temp password', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'ZZZ Nurse' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'zzz.nurse@x.test' } });
    fireEvent.click(screen.getByLabelText('Set temporary password (test users)'));
    fireEvent.change(screen.getByLabelText(/Temporary password/), { target: { value: 'Frn-Test-2026!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0]![0]).toMatchObject({ email: 'zzz.nurse@x.test', name: 'ZZZ Nurse', roles: ['ops_staff'], credential: 'temp_password', tempPassword: 'Frn-Test-2026!' });
  });

  it('explains why submit is blocked instead of silently doing nothing (weak temp password)', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'ZZZ Nurse' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'zzz.nurse@x.test' } });
    fireEvent.click(screen.getByLabelText('Set temporary password (test users)'));
    fireEvent.change(screen.getByLabelText(/Temporary password/), { target: { value: 'weak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    expect(await screen.findByText(/Temporary password must be at least 12 characters/)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('deactivates a staffer with their version (OCC)', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]!);
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith('U-1', 1, false));
  });

  it('renders the per-row Reset password + Unlock / clear MFA buttons', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    expect(screen.getAllByRole('button', { name: 'Reset password' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Unlock / clear MFA' }).length).toBeGreaterThan(0);
  });

  it('reset-password dialog defaults to email-code and posts with no temp-password mode', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Email reset code' }));
    await waitFor(() => expect(resetMock).toHaveBeenCalledWith('U-1', {}));
  });

  it('reset-password temp-password mode validates 12+ char strength client-side before posting', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    fireEvent.click(await screen.findByLabelText(/Set a temporary password/));
    fireEvent.change(screen.getByPlaceholderText(/12\+ chars/), { target: { value: 'weak' } });
    // Button is disabled for a weak password; force the submit path and assert no network call.
    const setBtn = screen.getByRole('button', { name: 'Set temporary password' });
    expect(setBtn).toBeDisabled();
    expect(resetMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/12\+ chars/), { target: { value: 'FrnTest-2026!!' } });
    expect(setBtn).not.toBeDisabled();
    fireEvent.click(setBtn);
    await waitFor(() => expect(resetMock).toHaveBeenCalledWith('U-1', { mode: 'temp_password', tempPassword: 'FrnTest-2026!!' }));
  });

  it('clear-MFA requires typing the target email before the action arms + fires', async () => {
    renderPage();
    await screen.findByText('rn@x.test');
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlock / clear MFA' })[0]!);
    const confirmBtn = await screen.findByRole('button', { name: /Clear MFA/ });
    // Disabled until the exact email is typed.
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('rn@x.test'), { target: { value: 'wrong@x.test' } });
    expect(confirmBtn).toBeDisabled();
    expect(unlockMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('rn@x.test'), { target: { value: 'rn@x.test' } });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(unlockMock).toHaveBeenCalledWith('U-1'));
  });
});
