import { render, screen } from '@testing-library/react';
import { vi, test, expect, beforeEach } from 'vitest';
import { App } from '../App';

vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: vi.fn().mockRejectedValue(new Error('no session')),
  fetchUserAttributes: vi.fn().mockResolvedValue({}),
  fetchAuthSession: vi.fn().mockResolvedValue({ tokens: undefined }),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  setUpTOTP: vi.fn(),
  verifyTOTPSetup: vi.fn()
}));

beforeEach(() => { window.history.pushState({}, '', '/'); });

test('renders sign-in for unauthenticated users without console errors', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<App />);
  expect(await screen.findByText('Secure staff sign-in')).toBeInTheDocument();
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});
