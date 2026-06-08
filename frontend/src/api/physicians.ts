import axios from 'axios';
import { apiGet, apiPatch, apiPost } from './client';

export interface PhysicianPublic {
  readonly id: string;
  readonly cognitoSub: string | null;
  readonly fullName: string;
  readonly npi: string;
  readonly specialty: string;
  readonly medicalLicense: string;
  readonly email: string;
  readonly phone: string | null;
  readonly hasSignature: boolean;
  // Credential-block facts (printed in Section I + the signature block). null until the profile
  // has a complete block; hasCredentialBlock false means the physician cannot sign yet.
  readonly hasCredentialBlock: boolean;
  readonly boardName: string | null;
  readonly boardAbbreviation: string | null;
  readonly licenseState: string | null;
  readonly licenseNumber: string | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface UpdatePhysicianFields {
  readonly fullName?: string;
  readonly npi?: string;
  readonly specialty?: string;
  readonly medicalLicense?: string;
  readonly email?: string;
  readonly phone?: string | null;
  readonly cognitoSub?: string | null;
  readonly active?: boolean;
  readonly boardName?: string;
  readonly boardAbbreviation?: string;
  readonly licenseState?: string;
  readonly licenseNumber?: string;
}

export interface UpdatePhysicianInput {
  readonly version: number;
  readonly fields: UpdatePhysicianFields;
}

export interface PresignPhysicianSignatureInput {
  readonly contentType: 'image/png';
  readonly sizeBytes: number;
}

export interface PresignedPhysicianSignatureUpload {
  readonly uploadUrl: string;
  readonly s3Key: string;
  readonly expiresInSeconds: number;
  readonly requiredHeaders: Record<string, string>;
}

export interface PhysicianSignatureDownload {
  readonly downloadUrl: string;
  readonly expiresInSeconds: number;
}

export async function listPhysicians(): Promise<{ data: readonly PhysicianPublic[] }> {
  return apiGet('/api/v1/physicians');
}

export async function getPhysician(id: string): Promise<{ data: PhysicianPublic }> {
  return apiGet(`/api/v1/physicians/${encodeURIComponent(id)}`);
}

export async function updatePhysician(id: string, input: UpdatePhysicianInput): Promise<{ data: PhysicianPublic }> {
  return apiPatch(`/api/v1/physicians/${encodeURIComponent(id)}`, input);
}

export async function presignPhysicianSignature(
  id: string,
  input: PresignPhysicianSignatureInput,
): Promise<{ data: PresignedPhysicianSignatureUpload }> {
  return apiPost(`/api/v1/physicians/${encodeURIComponent(id)}/signature/presign`, input);
}

export async function attachPhysicianSignature(id: string, input: { s3Key: string }): Promise<{ data: PhysicianPublic }> {
  return apiPost(`/api/v1/physicians/${encodeURIComponent(id)}/signature`, input);
}

export async function downloadPhysicianSignature(id: string): Promise<{ data: PhysicianSignatureDownload }> {
  return apiGet(`/api/v1/physicians/${encodeURIComponent(id)}/signature/download`);
}

export interface LinkPhysicianLoginResult {
  readonly physicianId: string;
  readonly cognitoSub: string;
  readonly email: string;
  readonly appUserId: string;
  readonly credential: string;
}

// Link an orphaned (cognitoSub null) physician credential profile to a Cognito login. credential
// 'invite' emails an onboarding invite (default); 'temp_password' sets a known one-login password
// (12+ upper/lower/digit/symbol). 409 already_linked if the profile already has a login.
export async function linkPhysicianLogin(
  id: string,
  body: { credential: 'invite' | 'temp_password'; tempPassword?: string },
): Promise<{ data: LinkPhysicianLoginResult }> {
  return apiPost(`/api/v1/physicians/${encodeURIComponent(id)}/link-login`, body);
}

export async function uploadAndAttachPhysicianSignature(id: string, file: File): Promise<{ data: PhysicianPublic }> {
  if (file.type !== 'image/png') {
    throw new Error('Signature must be a PNG file.');
  }
  const presign = await presignPhysicianSignature(id, { contentType: 'image/png', sizeBytes: file.size });
  await axios.put(presign.data.uploadUrl, file, { headers: presign.data.requiredHeaders });
  return attachPhysicianSignature(id, { s3Key: presign.data.s3Key });
}
