import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmSignIn as amplifyConfirmSignIn, fetchAuthSession, fetchUserAttributes, getCurrentUser, rememberDevice as amplifyRememberDevice, signIn as amplifySignIn, signOut as amplifySignOut } from 'aws-amplify/auth';
import type { Role } from '../types/prisma';
import { env } from '../env';
import { IdleWarningModal } from './IdleWarningModal';

// DEV/DEMO ONLY: fixed physician identity used when VITE_DEMO_MODE=true (skips Amplify/Cognito).
// `sub` matches the demo-seed physician app-user + the dev bypass token's subject.
const DEMO_PHYSICIAN: AuthUser = { sub: 'demo-physician-sub', email: 'dr.physician@flatratenexus.local', roles: ['physician'], role: 'physician' };

// Idle auto-logout (Ryan 2026-07-10, HIPAA idle-lock): sign the user out after this much INPUT inactivity,
// warning DEFAULT_IDLE_WARN_MS before so a walked-away session doesn't silently lose unsaved work. Cross-tab
// synced via localStorage (activity in any tab keeps every tab alive). Timings are AuthProvider props for tests.
const DEFAULT_IDLE_LOGOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_IDLE_WARN_MS = 2 * 60 * 1000; // warn 2 min before logout
const ACTIVITY_THROTTLE_MS = 5000; // record activity at most once per 5s (mousemove fires constantly)
const IDLE_ACTIVITY_KEY = 'emr:lastActivity';

export interface AuthUser { readonly sub: string; readonly email: string; readonly roles: readonly Role[]; readonly role: Role; }
export type AuthStep = 'idle' | 'new_password_required' | 'mfa_setup' | 'software_token_mfa' | 'signed_in';
export interface TotpSetupDetails { readonly sharedSecret?: string | undefined; readonly uri?: string | undefined; }
export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly role: Role | null;
  readonly loading: boolean;
  readonly challengeStep: AuthStep;
  readonly totpSetupDetails: TotpSetupDetails | null;
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly confirmNewPassword: (password: string) => Promise<void>;
  readonly confirmMfaCode: (code: string) => Promise<void>;
  readonly confirmTotpSetup: (code: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly refreshUser: () => Promise<void>;
  // Idle-lock: seconds remaining before an inactivity logout (null = no warning showing). `stayActive`
  // dismisses the warning + resets the idle timer.
  readonly idleWarningSecondsLeft: number | null;
  readonly stayActive: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const rolePriority: readonly Role[] = ['admin', 'physician', 'ops_staff'];

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'physician' || value === 'ops_staff';
}

export function derivePrimaryRole(groups: readonly unknown[]): Role | null {
  const valid = groups.filter(isRole);
  return rolePriority.find((role) => valid.includes(role)) ?? null;
}

function normalizeGroups(rawGroups: unknown): readonly Role[] {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups.filter(isRole);
}

function extractGroupsFromPayload(payload: Record<string, unknown> | undefined): readonly Role[] {
  return normalizeGroups(payload?.['cognito:groups']);
}

async function readCurrentAuthUser(): Promise<AuthUser | null> {
  try {
    const [currentUser, attributes, session] = await Promise.all([
      getCurrentUser(),
      fetchUserAttributes(),
      fetchAuthSession()
    ]);
    const idPayload = session.tokens?.idToken?.payload as Record<string, unknown> | undefined;
    const roles = extractGroupsFromPayload(idPayload);
    const role = derivePrimaryRole(roles);
    const email = attributes.email ?? '';
    if (!role || !email) return null;
    return { sub: currentUser.userId, email, roles, role };
  } catch {
    return null;
  }
}

function nextStepToAuthStep(signInStep: string | undefined): AuthStep {
  if (signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'new_password_required';
  if (signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return 'mfa_setup';
  if (signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' || signInStep === 'CONFIRM_SIGN_IN_WITH_SMS_CODE') return 'software_token_mfa';
  if (signInStep === 'DONE') return 'signed_in';
  return 'idle';
}

export function AuthProvider({
  children,
  idleTimeoutMs = DEFAULT_IDLE_LOGOUT_MS,
  idleWarnMs = DEFAULT_IDLE_WARN_MS,
}: {
  readonly children: ReactNode;
  readonly idleTimeoutMs?: number; // overridable for tests
  readonly idleWarnMs?: number;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [challengeStep, setChallengeStep] = useState<AuthStep>('idle');
  const [totpSetupDetails, setTotpSetupDetails] = useState<TotpSetupDetails | null>(null);
  const [idleWarningSecondsLeft, setIdleWarningSecondsLeft] = useState<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const signingOutRef = useRef(false); // non-overlap guard: don't stack idle-logout signOut() calls

  const refreshUser = useCallback(async () => {
    // DEV/DEMO ONLY: bypass Amplify and present a fixed signed-in physician.
    if (env.demoMode) {
      setUser(DEMO_PHYSICIAN);
      setLoading(false);
      setChallengeStep('signed_in');
      return;
    }
    setLoading(true);
    const current = await readCurrentAuthUser();
    setUser(current);
    setLoading(false);
    if (current) setChallengeStep('signed_in');
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const signOut = useCallback(async () => {
    // Fail-CLOSED: clear local auth state even if Amplify's network token-revoke rejects (offline/5xx).
    // Otherwise an idle-logout whose revoke blips would never null `user` → the idle interval would call
    // signOut() every second forever (HIPAA fail-open + unhandled-rejection flood). (architect QA 2026-07-10)
    try { await amplifySignOut(); }
    finally {
      setUser(null);
      setChallengeStep('idle');
      setTotpSetupDetails(null);
    }
  }, []);

  const stayActive = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdleWarningSecondsLeft(null);
    try { localStorage.setItem(IDLE_ACTIVITY_KEY, String(lastActivityRef.current)); } catch { /* private mode */ }
  }, []);

  // Idle auto-logout: after `idleTimeoutMs` of no user INPUT, sign out; warn `idleWarnMs` before. Only when
  // actually signed in (not demo). Network/background polling does NOT reset it — only real user input — so a
  // walked-away session with a live poll still locks. Cross-tab: `storage` events let activity in any tab
  // keep every tab alive.
  useEffect(() => {
    if (env.demoMode || !user) { setIdleWarningSecondsLeft(null); return; }
    lastActivityRef.current = Date.now();
    setIdleWarningSecondsLeft(null);
    signingOutRef.current = false;
    // Single, non-overlapping logout (architect QA): the fail-closed signOut() nulls `user` which tears
    // this effect down, but guard anyway so a slow (>1s) revoke can't stack in-flight calls.
    const lockOut = () => {
      setIdleWarningSecondsLeft(null);
      if (signingOutRef.current) return;
      signingOutRef.current = true;
      void signOut().catch(() => { /* fail-closed already cleared local state */ }).finally(() => { signingOutRef.current = false; });
    };
    let lastRecord = 0;
    const record = () => {
      const now = Date.now();
      if (now - lastRecord < ACTIVITY_THROTTLE_MS) return;
      lastRecord = now;
      lastActivityRef.current = now;
      setIdleWarningSecondsLeft((prev) => (prev === null ? prev : null)); // activity dismisses a showing warning
      try { localStorage.setItem(IDLE_ACTIVITY_KEY, String(now)); } catch { /* private mode */ }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== IDLE_ACTIVITY_KEY || !e.newValue) return;
      const t = Number(e.newValue);
      if (Number.isFinite(t) && t > lastActivityRef.current) { lastActivityRef.current = t; setIdleWarningSecondsLeft(null); }
    };
    // A hidden tab's setInterval is browser-throttled, so its idle countdown can run late. When a tab
    // becomes visible, re-check idle against wall-clock BEFORE any activity handler resets it (architect QA).
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivityRef.current >= idleTimeoutMs) lockOut();
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll', 'click'] as const;
    events.forEach((ev) => window.addEventListener(ev, record, { passive: true }));
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    const tick = window.setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= idleTimeoutMs) { lockOut(); return; }
      if (idle >= idleTimeoutMs - idleWarnMs) setIdleWarningSecondsLeft(Math.max(1, Math.ceil((idleTimeoutMs - idle) / 1000)));
      else setIdleWarningSecondsLeft((prev) => (prev === null ? prev : null));
    }, 1000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, record));
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(tick);
    };
  }, [user, signOut, idleTimeoutMs, idleWarnMs]);

  const applyNextStep = useCallback(async (nextStep: { signInStep: string; totpSetupDetails?: { sharedSecret?: string; getSetupUri?: (appName: string) => URL } }) => {
    const step = nextStepToAuthStep(nextStep.signInStep);
    setChallengeStep(step);
    if (step === 'mfa_setup') {
      const totp = nextStep.totpSetupDetails;
      if (totp) {
        const sharedSecret = totp.sharedSecret;
        const uri = typeof totp.getSetupUri === 'function' ? totp.getSetupUri('Compact EMR').toString() : undefined;
        setTotpSetupDetails({ sharedSecret, uri });
      }
      return;
    }
    if (step === 'signed_in') {
      // Remember THIS device so future logins on it skip the TOTP challenge (Ryan 2026-07-18:
      // "still needing google authenticator to login"). Best-effort — a failure here must NEVER
      // block sign-in. The pool keeps ChallengeRequiredOnNewDevice=true, so a brand-new device
      // still gets exactly one OTP; after that it's remembered (Cognito uses DEVICE_SRP_AUTH and
      // does not re-challenge MFA). Opt-in device mode requires this explicit call to mark it.
      try { await amplifyRememberDevice(); } catch { /* non-fatal: device just won't be remembered */ }
      await refreshUser();
    }
  }, [refreshUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await amplifySignIn({ username: email, password });
    await applyNextStep(result.nextStep as unknown as Parameters<typeof applyNextStep>[0]);
  }, [applyNextStep]);

  const confirmNewPassword = useCallback(async (password: string) => {
    const result = await amplifyConfirmSignIn({ challengeResponse: password });
    await applyNextStep(result.nextStep as unknown as Parameters<typeof applyNextStep>[0]);
  }, [applyNextStep]);

  const confirmMfaCode = useCallback(async (code: string) => {
    const result = await amplifyConfirmSignIn({ challengeResponse: code });
    await applyNextStep(result.nextStep as unknown as Parameters<typeof applyNextStep>[0]);
  }, [applyNextStep]);

  const confirmTotpSetup = useCallback(async (code: string) => {
    const result = await amplifyConfirmSignIn({ challengeResponse: code });
    await applyNextStep(result.nextStep as unknown as Parameters<typeof applyNextStep>[0]);
  }, [applyNextStep]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    role: user?.role ?? null,
    loading,
    challengeStep,
    totpSetupDetails,
    signIn,
    confirmNewPassword,
    confirmMfaCode,
    confirmTotpSetup,
    signOut,
    refreshUser,
    idleWarningSecondsLeft,
    stayActive
  }), [challengeStep, confirmMfaCode, confirmNewPassword, confirmTotpSetup, idleWarningSecondsLeft, loading, refreshUser, signIn, signOut, stayActive, totpSetupDetails, user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <IdleWarningModal />
    </AuthContext.Provider>
  );
}
