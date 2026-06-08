import { apiGet, apiPost, apiPatch } from './client';

// Staff directory + provisioning. Mirrors the backend /users contract.
export interface StaffUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly version: number;
}

export type StaffRole = 'admin' | 'ops_staff' | 'physician';

export interface CreateStaffPhysician {
  readonly npi: string;
  readonly specialty: string;
  readonly medicalLicense: string;
  readonly boardName: string;
  readonly boardAbbreviation: string;
  readonly licenseState: string;
  readonly licenseNumber: string;
  readonly phone?: string | null;
}

export interface CreateStaffInput {
  readonly email: string;
  readonly name: string;
  readonly roles: readonly StaffRole[];
  readonly credential: 'invite' | 'temp_password';
  readonly tempPassword?: string;
  readonly physician?: CreateStaffPhysician;
}

export interface CreatedStaff {
  readonly id: string;
  readonly cognitoSub: string;
  readonly email: string;
  readonly name: string | null;
  readonly roles: readonly string[];
  readonly active: boolean;
  readonly credential: string;
  readonly physicianId: string | null;
  readonly physicianReadyToSign: boolean;
}

export async function listUsers(params: { role?: StaffRole; includeInactive?: boolean } = {}): Promise<{ data: readonly StaffUser[] }> {
  const qs = new URLSearchParams();
  if (params.role) qs.set('role', params.role);
  if (params.includeInactive) qs.set('includeInactive', 'true');
  const query = qs.toString();
  return apiGet<{ data: readonly StaffUser[] }>(`/api/v1/users${query ? `?${query}` : ''}`);
}

export async function createStaff(input: CreateStaffInput): Promise<{ data: CreatedStaff }> {
  return apiPost<{ data: CreatedStaff }, CreateStaffInput>('/api/v1/users', input);
}

export async function setStaffActive(id: string, version: number, active: boolean): Promise<{ data: StaffUser }> {
  return apiPatch<{ data: StaffUser }, { version: number; active: boolean }>(`/api/v1/users/${encodeURIComponent(id)}`, { version, active });
}

export interface ResetPasswordResult {
  readonly id: string;
  readonly email: string;
  readonly mode: string;
}

// Reset a staff login's password. Omit opts (or opts.mode !== 'temp_password') => Cognito emails a
// reset code (no plaintext leaves the server; the recommended default). { mode: 'temp_password',
// tempPassword } sets a known one-login temp password (must satisfy the 12+ upper/lower/digit/symbol
// policy server-side). The password is never echoed back.
export async function resetStaffPassword(
  id: string,
  opts: { mode?: 'temp_password'; tempPassword?: string } = {},
): Promise<{ data: ResetPasswordResult }> {
  const body = opts.mode === 'temp_password' ? { mode: 'temp_password' as const, tempPassword: opts.tempPassword } : {};
  return apiPost<{ data: ResetPasswordResult }, typeof body>(`/api/v1/users/${encodeURIComponent(id)}/reset-password`, body);
}

export interface UnlockStaffResult {
  readonly id: string;
  readonly email: string;
  readonly targetIsAdmin: boolean;
}

// Account-takeover-grade: clears the staff member's MFA factors and re-enables the login. The UI
// gates this behind a typed-email confirmation before firing.
export async function unlockStaff(id: string): Promise<{ data: UnlockStaffResult }> {
  return apiPost<{ data: UnlockStaffResult }, Record<string, never>>(`/api/v1/users/${encodeURIComponent(id)}/unlock`, {});
}
