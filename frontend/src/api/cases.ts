import { apiDelete, apiGet, apiPatch, apiPost } from './client';
import type { Case, CaseStatus, ClaimType, Correction, Document, DraftJob, Email, Payment } from '../types/prisma';

export interface CaseVeteranLite { readonly id: string; readonly firstName: string; readonly lastName: string; readonly email: string; }
export interface CasePhysicianLite { readonly id: string; readonly fullName: string; readonly email: string; }

// Matches the backend CASE_LITE_SELECT shape returned by GET /cases and the list rows.
export interface CaseLite {
  readonly id: string;
  readonly veteranId: string;
  readonly claimedCondition: string;
  readonly claimType: ClaimType;
  readonly status: CaseStatus;
  readonly version: number;
  readonly currentVersion: number;
  readonly assignedPhysicianId: string | null;
  readonly refundEligible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly veteran?: CaseVeteranLite | null;
  readonly assignedPhysician?: CasePhysicianLite | null;
}

// Offset-paginated envelope (cases list uses page/pageSize/total, not cursor).
export interface CaseListResult {
  readonly data: readonly CaseLite[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ListCasesParams {
  readonly status?: CaseStatus;
  readonly claimType?: ClaimType;
  readonly veteranId?: string;
  readonly assignedPhysicianId?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function listCases(params: ListCasesParams = {}): Promise<CaseListResult> {
  const sp = new URLSearchParams();
  if (params.status) sp.set('status', params.status);
  if (params.claimType) sp.set('claimType', params.claimType);
  if (params.veteranId) sp.set('veteranId', params.veteranId);
  if (params.assignedPhysicianId) sp.set('assignedPhysicianId', params.assignedPhysicianId);
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  const qs = sp.toString();
  return apiGet<CaseListResult>(`/api/v1/cases${qs ? `?${qs}` : ''}`);
}

export interface CreateCaseInput {
  readonly id: string;
  readonly claimedCondition: string;
  readonly claimType: ClaimType;
  readonly framingChoice?: string;
  readonly upstreamScCondition?: string;
  readonly veteranStatement?: string;
  readonly inServiceEvent?: string;
}

export async function createCase(veteranId: string, input: CreateCaseInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/cases`, input);
}

export interface CaseDetail extends Case {
  readonly veteran?: CaseVeteranLite | null;
  readonly assignedPhysician?: CasePhysicianLite | null;
  readonly documents?: readonly Document[];
  readonly draftJobs?: readonly DraftJob[];
  readonly corrections?: readonly Correction[];
  readonly emails?: readonly Email[];
  readonly payments?: readonly Payment[];
  readonly _count?: { readonly documents: number; readonly draftJobs: number; readonly corrections: number; readonly emails: number; readonly payments: number };
}

export interface PatchCaseInput {
  readonly version: number;
  readonly claimedCondition?: string;
  readonly framingChoice?: string | null;
  readonly upstreamScCondition?: string | null;
  readonly veteranStatement?: string | null;
  readonly inServiceEvent?: string | null;
}

export interface TransitionInput {
  readonly from: CaseStatus;
  readonly to: CaseStatus;
  readonly version: number;
  readonly transitionReason?: string;
}

export async function getCase(id: string): Promise<{ data: CaseDetail }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}`);
}

export async function patchCase(id: string, input: PatchCaseInput): Promise<{ data: CaseLite }> {
  return apiPatch(`/api/v1/cases/${encodeURIComponent(id)}`, input);
}

export async function transitionCaseStatus(id: string, input: TransitionInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/status`, input);
}

export async function deleteCase(id: string): Promise<void> {
  return apiDelete(`/api/v1/cases/${encodeURIComponent(id)}`);
}

export async function listDraftJobs(id: string): Promise<{ data: readonly DraftJob[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}/draft-jobs`);
}

export async function listCorrections(id: string): Promise<{ data: readonly Correction[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}/corrections`);
}

// === Phase 5 CDS (Clinical Decision Support) ===

export interface CdsResult {
  readonly verdict: 'accept' | 'caution' | 'reject';
  readonly oddsPct: number | null;
  readonly summary: string;
  readonly hardGate: {
    readonly triggered: boolean;
    readonly rule: string | null;
    readonly detail: string | null;
  };
  readonly bva: {
    readonly matched: boolean;
    readonly upstream: string | null;
    readonly claimed: string | null;
    readonly n: number | null;
    readonly tier: 'high' | 'moderate' | 'low' | null;
    readonly winPct: number | null;
    readonly imoWinPct: number | null;
  };
  readonly checkedAt: string;
  readonly engineVersion: string;
}

export async function runCds(id: string): Promise<{ data: CdsResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/cds`, {});
}
