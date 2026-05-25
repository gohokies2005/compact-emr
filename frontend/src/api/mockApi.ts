import type { ApiEnvelope, CaseListResponse, MockHealth, VeteranListResponse } from '../types/api';
import type { Case, Veteran } from '../types/prisma';

const now = new Date().toISOString();
const veterans: readonly Veteran[] = [
  { id: 'VET-DEMO-001', firstName: 'Demo', lastName: 'Veteran', dob: '1980-01-01', email: 'demo@example.com', branch: 'Navy', serviceStartYear: 2001, serviceEndYear: 2007, combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', createdAt: now, updatedAt: now, version: 1 }
];
const cases: readonly Case[] = [
  { id: 'CASE-DEMO-001', veteranId: 'VET-DEMO-001', claimedCondition: 'Obstructive Sleep Apnea', claimType: 'supplemental', status: 'intake', cdsVerdict: 'not_yet_run', refundEligible: false, currentVersion: 0, createdAt: now, updatedAt: now, version: 1 }
];

export async function mockRequest<T>(path: string): Promise<T> {
  if (path === '/api/v1/health') return { data: { ok: true } satisfies MockHealth } as T;
  if (path === '/api/v1/veterans') return { data: veterans } satisfies VeteranListResponse as T;
  if (path === '/api/v1/cases') return { data: cases } satisfies CaseListResponse as T;
  return { data: {} } as T;
}
