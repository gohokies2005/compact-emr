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
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreatePhysicianInput {
  readonly fullName: string;
  readonly npi: string;
  readonly specialty: string;
  readonly medicalLicense: string;
  readonly email: string;
  readonly phone?: string;
  readonly cognitoSub?: string;
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

export async function createPhysician(input: CreatePhysicianInput): Promise<{ data: PhysicianPublic }> {
  return apiPost('/api/v1/physicians', input);
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

export async function uploadAndAttachPhysicianSignature(id: string, file: File): Promise<{ data: PhysicianPublic }> {
  if (file.type !== 'image/png') {
    throw new Error('Signature must be a PNG file.');
  }
  const presign = await presignPhysicianSignature(id, { contentType: 'image/png', sizeBytes: file.size });
  await axios.put(presign.data.uploadUrl, file, { headers: presign.data.requiredHeaders });
  return attachPhysicianSignature(id, { s3Key: presign.data.s3Key });
}
