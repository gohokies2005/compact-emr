import { render, screen, act, fireEvent } from '@testing-library/react';
import { useContext } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Ryan 2026-07-10 (HIPAA idle-lock): AuthProvider signs the user out after INPUT inactivity, warning first.
vi.mock('../env', () => ({ env: { demoMode: false } }));
vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn(), confirmSignIn: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
  getCurrentUser: vi.fn().mockResolvedValue({ userId: 'u1' }),
  fetchUserAttributes: vi.fn().mockResolvedValue({ email: 'doc@flatratenexus.com' }),
  fetchAuthSession: vi.fn().mockResolvedValue({ tokens: { idToken: { payload: { 'cognito:groups': ['admin'] } } } }),
}));
import { signOut as amplifySignOut } from 'aws-amplify/auth';
import { AuthContext, AuthProvider } from '../auth/AuthProvider';

function Probe() {
  const ctx = useContext(AuthContext)!;
  return (
    <div>
      <span data-testid="signed">{ctx.user ? 'in' : 'out'}</span>
      <span data-testid="warn">{String(ctx.idleWarningSecondsLeft)}</span>
    </div>
  );
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe('AuthProvider idle auto-logout', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-10T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('warns before the timeout, signs out after it, and real activity resets the timer', async () => {
    render(<AuthProvider idleTimeoutMs={6000} idleWarnMs={2000}><Probe /></AuthProvider>);
    await flush(); // refreshUser resolves → signed in
    expect(screen.getByTestId('signed').textContent).toBe('in');

    // Past the warn threshold (6000 − 2000 = 4000ms idle) → warning modal shows, not yet logged out.
    await act(async () => { vi.advanceTimersByTime(4200); });
    expect(screen.getByTestId('warn').textContent).not.toBe('null');
    expect(screen.getByText('Still there?')).toBeInTheDocument();
    expect(amplifySignOut).not.toHaveBeenCalled();

    // Real user input resets the timer → warning clears, still signed in.
    await act(async () => { fireEvent.keyDown(window); vi.advanceTimersByTime(1100); });
    expect(screen.getByTestId('warn').textContent).toBe('null');
    expect(amplifySignOut).not.toHaveBeenCalled();

    // Now go fully idle past the timeout → signed out.
    await act(async () => { vi.advanceTimersByTime(6500); });
    expect(amplifySignOut).toHaveBeenCalled();
  });

  it('fail-CLOSED: logs out even if the Amplify revoke REJECTS, and does not spam signOut every second', async () => {
    vi.mocked(amplifySignOut).mockRejectedValue(new Error('network blip during revoke'));
    render(<AuthProvider idleTimeoutMs={3000} idleWarnMs={1000}><Probe /></AuthProvider>);
    await flush();
    expect(screen.getByTestId('signed').textContent).toBe('in');
    // Go idle past the timeout + let several ticks fire while the revoke keeps rejecting.
    await act(async () => { vi.advanceTimersByTime(3300); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); await Promise.resolve(); });
    // Local state was cleared despite the reject (fail-closed) → user is signed out.
    expect(screen.getByTestId('signed').textContent).toBe('out');
    // And signOut was NOT called once per second (the non-overlap guard + fail-closed teardown).
    expect(vi.mocked(amplifySignOut).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('does NOT arm the idle timer before sign-in (no logout, no warning)', async () => {
    (await import('aws-amplify/auth')).getCurrentUser = vi.fn().mockRejectedValue(new Error('no user')) as never;
    render(<AuthProvider idleTimeoutMs={3000} idleWarnMs={1000}><Probe /></AuthProvider>);
    await flush();
    expect(screen.getByTestId('signed').textContent).toBe('out');
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByTestId('warn').textContent).toBe('null');
    expect(amplifySignOut).not.toHaveBeenCalled();
  });
});
