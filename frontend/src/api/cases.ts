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

// === Phase 6 sign-off ===

export type SignOffQuestionKey =
  | 'records_reviewed'
  | 'diagnosis_documented'
  | 'nexus_supported'
  | 'no_phi_in_letter'
  | 'final_pdf_correct';

export type SignOffAnswers = Record<SignOffQuestionKey, boolean>;

export interface SignOffInput {
  readonly answers: SignOffAnswers;
  readonly notes?: string;
}

export interface SignOff {
  readonly id: string;
  readonly caseId: string;
  readonly physicianId: string;
  readonly signedAt: string;
  readonly answersJson: Partial<SignOffAnswers>;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export async function signOffCase(id: string, input: SignOffInput): Promise<{ data: SignOff }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/sign-off`, input);
}

export async function listCaseSignOffs(id: string): Promise<{ data: readonly SignOff[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}/sign-offs`);
}

// === Phase 6 clarifications ===

export type ClarificationAudience = 'physician' | 'ops_staff' | 'veteran';
export type ClarificationStatus = 'open' | 'resolved' | 'dismissed';

export interface Clarification {
  readonly id: string;
  readonly caseId: string;
  readonly audience: ClarificationAudience;
  readonly status: ClarificationStatus;
  readonly question: string;
  readonly resolution: string | null;
  readonly raisedBy: string;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}

export interface CreateClarificationInput {
  readonly audience: ClarificationAudience;
  readonly question: string;
}

export interface ResolveClarificationInput {
  readonly status: 'resolved' | 'dismissed';
  readonly resolution?: string;
}

export async function listClarifications(
  id: string,
  status?: ClarificationStatus,
): Promise<{ data: readonly Clarification[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}/clarifications${qs}`);
}

export async function createClarification(
  id: string,
  input: CreateClarificationInput,
): Promise<{ data: Clarification }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/clarifications`, input);
}

export async function resolveClarification(
  id: string,
  input: ResolveClarificationInput,
): Promise<{ data: Clarification }> {
  return apiPatch(`/api/v1/clarifications/${encodeURIComponent(id)}/resolve`, input);
}

// === Phase 7B-revised Build 2: RN manual-summary queue ===

export interface FileReadAttemptSummary {
  readonly method: string;
  readonly wordCount: number;
  readonly corruptedTokenRatio: number;
  readonly attemptedAt: string;
  readonly note: string | null;
}

export interface FileReadStatus {
  readonly id: string;
  readonly caseId: string;
  readonly filePath: string;
  readonly fileSha256: string;
  readonly terminalStatus: 'read' | 'manual_summary_required' | 'manual_summary_provided';
  readonly attemptsJson: readonly FileReadAttemptSummary[];
  readonly manualSummary: string | null;
  readonly manualSummaryAt: string | null;
  readonly manualSummaryBy: string | null;
  readonly lastCheckedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export async function listFilesPendingManualForCase(caseId: string): Promise<{ data: readonly FileReadStatus[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/files-pending-manual`);
}

export async function listFilesPendingManualGlobal(limit?: number): Promise<{ data: readonly FileReadStatus[]; total: number }> {
  const qs = typeof limit === 'number' ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return apiGet(`/api/v1/rn/files-pending-manual${qs}`);
}

export interface ManualSummaryInput {
  readonly summary: string;
}

export async function postManualSummary(
  caseId: string,
  fileReadStatusId: string,
  input: ManualSummaryInput,
): Promise<{ data: FileReadStatus }> {
  return apiPost(
    `/api/v1/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(fileReadStatusId)}/manual-summary`,
    input,
  );
}
