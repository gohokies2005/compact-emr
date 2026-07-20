import axios from 'axios';
import { apiGet, apiPost, apiPatch } from './client';

// Staff directory + provisioning. Mirrors the backend /users contract.
export interface StaffUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly version: number;
  // CO-SIGN (DPT docket 2026-07-19): true when this provider's signed letters are co-signed by the
  // account owner (Dr. Kasky). Physician-linked rows only; false/undefined otherwise. Lets the edit
  // form PRE-FILL the "Dr. Kasky co-signs" checkbox. Optional so pre-feature responses stay valid.
  readonly coSigned?: boolean;
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
  // "I (the account owner) co-sign for this provider." Only honored when roles includes physician;
  // resolved server-side to the requesting admin's own physician id.
  readonly coSignByOwner?: boolean;
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
  readonly coSigned?: boolean;
}

export async function listUsers(params: { role?: StaffRole; includeInactive?: boolean } = {}): Promise<{ data: readonly StaffUser[] }> {
  const qs = new URLSearchParams();
  if (params.role) qs.set('role', params.role);
  if (params.includeInactive) qs.set('includeInactive', 'true');
  const query = qs.toString();
  return apiGet<{ data: readonly StaffUser[] }>(`/api/v1/users${query ? `?${query}` : ''}`);
}

// Messaging directory entry — keyed by the COGNITO SUB (the id staff-message recipients match on),
// readable by every staff role (physicians included). Minimal PII: name + role only.
export interface DirectoryEntry {
  readonly sub: string;
  readonly name: string;
  readonly role: 'admin' | 'ops_staff' | 'physician';
}

export async function listDirectory(): Promise<{ data: readonly DirectoryEntry[] }> {
  return apiGet<{ data: readonly DirectoryEntry[] }>('/api/v1/users/directory');
}

// The caller's own AppUser row (id is what assignedRnId etc. key on — NOT the Cognito sub).
// 404s when the login has no AppUser mapping; callers must degrade gracefully (e.g. hide "Me").
export interface MeUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly roles: readonly string[];
  // Freshly presigned GET for the avatar image; null when no avatar is set (render the
  // silhouette fallback). Short TTL — refetch /users/me rather than caching the URL long-term.
  readonly avatarUrl: string | null;
}

export async function getMe(): Promise<{ data: MeUser }> {
  return apiGet<{ data: MeUser }>('/api/v1/users/me');
}

// ---- P3 avatar upload (presign -> PUT -> register; mirrors the physician-signature flow) ----

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Client-side pre-flight; the server re-validates both rules on presign. Null = OK. */
export function validateAvatarFile(file: File): string | null {
  if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'Avatar must be a PNG, JPEG, or WebP image.';
  }
  if (file.size > MAX_AVATAR_BYTES) return 'Avatar must be 2 MB or smaller.';
  return null;
}

export interface PresignedAvatarUpload {
  readonly uploadUrl: string;
  readonly s3Key: string;
  readonly expiresInSeconds: number;
  readonly requiredHeaders: Record<string, string>;
}

export interface AttachedAvatar {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly version: number;
  readonly avatarUrl: string | null;
}

export async function presignUserAvatar(
  id: string,
  input: { contentType: string; sizeBytes: number },
): Promise<{ data: PresignedAvatarUpload }> {
  return apiPost(`/api/v1/users/${encodeURIComponent(id)}/avatar/presign`, input);
}

export async function attachUserAvatar(id: string, input: { s3Key: string }): Promise<{ data: AttachedAvatar }> {
  return apiPost(`/api/v1/users/${encodeURIComponent(id)}/avatar`, input);
}

export async function uploadAndAttachUserAvatar(id: string, file: File): Promise<{ data: AttachedAvatar }> {
  const problem = validateAvatarFile(file);
  if (problem !== null) throw new Error(problem);
  const presign = await presignUserAvatar(id, { contentType: file.type, sizeBytes: file.size });
  await axios.put(presign.data.uploadUrl, file, { headers: presign.data.requiredHeaders });
  return attachUserAvatar(id, { s3Key: presign.data.s3Key });
}

export async function createStaff(input: CreateStaffInput): Promise<{ data: CreatedStaff }> {
  return apiPost<{ data: CreatedStaff }, CreateStaffInput>('/api/v1/users', input);
}

export async function setStaffActive(id: string, version: number, active: boolean): Promise<{ data: StaffUser }> {
  return apiPatch<{ data: StaffUser }, { version: number; active: boolean }>(`/api/v1/users/${encodeURIComponent(id)}`, { version, active });
}

// Correct a staff member's display name (e.g. a surname misspelled at onboarding). DB-only rename —
// updates the directory/picker name and, for a physician-linked account, Physician.fullName too; the
// signed-letter credential block is intentionally left untouched by this path.
export async function renameStaff(id: string, version: number, name: string): Promise<{ data: StaffUser }> {
  return apiPatch<{ data: StaffUser }, { version: number; name: string }>(`/api/v1/users/${encodeURIComponent(id)}`, { version, name });
}

// Edit a provider's profile: display name and/or the "Dr. Kasky co-signs" toggle, in ONE PATCH.
// coSignByOwner is honored only for a physician-linked account (server-validated: the co-signer must
// be an active physician with a signature on file, and never the provider themselves).
export interface UpdateStaffProfileInput { readonly name?: string; readonly coSignByOwner?: boolean }
export async function updateStaffProfile(id: string, version: number, patch: UpdateStaffProfileInput): Promise<{ data: StaffUser }> {
  return apiPatch<{ data: StaffUser }, { version: number } & UpdateStaffProfileInput>(`/api/v1/users/${encodeURIComponent(id)}`, { version, ...patch });
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
