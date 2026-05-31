import { apiGet } from './client';

// Minimal staff directory for assignment pickers (the RN-liaison selector). Mirrors the backend
// GET /users?role=ops_staff contract: id/email/roles only, no PHI.
export interface StaffUser {
  readonly id: string;
  readonly email: string;
  readonly roles: readonly string[];
}

export type StaffRole = 'admin' | 'ops_staff' | 'physician';

export async function listUsers(params: { role?: StaffRole } = {}): Promise<{ data: readonly StaffUser[] }> {
  const query = params.role ? `?role=${encodeURIComponent(params.role)}` : '';
  return apiGet<{ data: readonly StaffUser[] }>(`/users${query}`);
}
