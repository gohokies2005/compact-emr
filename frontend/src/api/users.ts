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
  return apiGet<{ data: readonly StaffUser[] }>(`/users${query ? `?${query}` : ''}`);
}

export async function createStaff(input: CreateStaffInput): Promise<{ data: CreatedStaff }> {
  return apiPost<{ data: CreatedStaff }, CreateStaffInput>('/users', input);
}

export async function setStaffActive(id: string, version: number, active: boolean): Promise<{ data: StaffUser }> {
  return apiPatch<{ data: StaffUser }, { version: number; active: boolean }>(`/users/${id}`, { version, active });
}
