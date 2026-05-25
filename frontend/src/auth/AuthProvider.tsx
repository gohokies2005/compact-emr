import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { confirmSignIn as amplifyConfirmSignIn, fetchAuthSession, fetchUserAttributes, getCurrentUser, signIn as amplifySignIn, signOut as amplifySignOut, setUpTOTP, verifyTOTPSetup } from 'aws-amplify/auth';
import type { Role } from '../types/prisma';

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

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [challengeStep, setChallengeStep] = useState<AuthStep>('idle');
  const [totpSetupDetails, setTotpSetupDetails] = useState<TotpSetupDetails | null>(null);

  const refreshUser = useCallback(async () => {
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
    await amplifySignOut();
    setUser(null);
    setChallengeStep('idle');
    setTotpSetupDetails(null);
  }, []);

  const completeIfSignedIn = useCallback(async (step: AuthStep) => {
    setChallengeStep(step);
    if (step === 'mfa_setup') {
      const setup = await setUpTOTP();
      const sharedSecret = 'sharedSecret' in setup ? setup.sharedSecret : undefined;
      const uri = typeof setup.getSetupUri === 'function' ? setup.getSetupUri('Compact EMR').toString() : undefined;
      setTotpSetupDetails({ sharedSecret, uri });
      return;
    }
    if (step === 'signed_in') await refreshUser();
  }, [refreshUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await amplifySignIn({ username: email, password });
    await completeIfSignedIn(nextStepToAuthStep(result.nextStep.signInStep));
  }, [completeIfSignedIn]);

  const confirmNewPassword = useCallback(async (password: string) => {
    const result = await amplifyConfirmSignIn({ challengeResponse: password });
    await completeIfSignedIn(nextStepToAuthStep(result.nextStep.signInStep));
  }, [completeIfSignedIn]);

  const confirmMfaCode = useCallback(async (code: string) => {
    const result = await amplifyConfirmSignIn({ challengeResponse: code });
    await completeIfSignedIn(nextStepToAuthStep(result.nextStep.signInStep));
  }, [completeIfSignedIn]);

  const confirmTotpSetup = useCallback(async (code: string) => {
    await verifyTOTPSetup({ code });
    const result = await amplifyConfirmSignIn({ challengeResponse: code });
    await completeIfSignedIn(nextStepToAuthStep(result.nextStep.signInStep));
  }, [completeIfSignedIn]);

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
    refreshUser
  }), [challengeStep, confirmMfaCode, confirmNewPassword, confirmTotpSetup, loading, refreshUser, signIn, signOut, totpSetupDetails, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
