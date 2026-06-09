import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider';
import { ProtectedRoute } from '../auth/ProtectedRoute';
import { NoAccessPage } from '../routes/NoAccessPage';

vi.mock('aws-amplify/auth', () => ({ signIn: vi.fn(), confirmSignIn: vi.fn(), signOut: vi.fn(), setUpTOTP: vi.fn(), verifyTOTPSetup: vi.fn(), getCurrentUser: vi.fn(), fetchUserAttributes: vi.fn(), fetchAuthSession: vi.fn() }));

const baseAuth: AuthContextValue = {
  user: null,
  role: null,
  loading: false,
  challengeStep: 'idle',
  totpSetupDetails: null,
  signIn: vi.fn(),
  confirmNewPassword: vi.fn(),
  confirmMfaCode: vi.fn(),
  confirmTotpSetup: vi.fn(),
  signOut: vi.fn(),
  refreshUser: vi.fn()
};

function renderWithAuth(value: AuthContextValue) {
  return render(<AuthContext.Provider value={value}><MemoryRouter initialEntries={['/secure']}><Routes><Route path="/secure" element={<ProtectedRoute requiredRole={['admin']}><div>Allowed content</div></ProtectedRoute>} /><Route path="/403" element={<NoAccessPage />} /></Routes></MemoryRouter></AuthContext.Provider>);
}

describe('ProtectedRoute', () => {
  test('unauthenticated users see sign-in', () => { renderWithAuth(baseAuth); expect(screen.getByText('For those who served.')).toBeInTheDocument(); });
  test('wrong role redirects to 403', async () => { renderWithAuth({ ...baseAuth, user: { sub: 's', email: 'doc@example.com', roles: ['physician'], role: 'physician' }, role: 'physician' }); expect(await screen.findByText('403 — No access')).toBeInTheDocument(); });
  test('allowed role renders child', () => { renderWithAuth({ ...baseAuth, user: { sub: 's', email: 'admin@example.com', roles: ['admin'], role: 'admin' }, role: 'admin' }); expect(screen.getByText('Allowed content')).toBeInTheDocument(); });
});
