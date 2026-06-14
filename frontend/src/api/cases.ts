import { apiDelete, apiGet, apiPatch, apiPost } from './client';
import type { Case, CaseStatus, ClaimType, Correction, Document, DraftJob, Email, Payment } from '../types/prisma';

export interface CaseVeteranLite {
  readonly id: string; readonly firstName: string; readonly lastName: string; readonly email: string;
  // Demographics — populated on the case-DETAIL query (claim page header); absent on list rows.
  readonly dob?: string; readonly phone?: string | null; readonly address?: string | null;
  readonly branch?: string | null; readonly serviceStartYear?: number | null; readonly serviceEndYear?: number | null;
  readonly heightIn?: number | null; readonly weightLb?: number | null; readonly combatVeteran?: string | null;
}
export interface CasePhysicianLite { readonly id: string; readonly fullName: string; readonly email: string; }
export interface AssignedRnLite { readonly id: string; readonly email: string; readonly name?: string | null; }

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
  readonly assignedRnId: string | null;
  readonly refundEligible: boolean;
  readonly quickNote?: string | null;
  readonly quickNoteBy?: string | null;
  readonly quickNoteAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly veteran?: CaseVeteranLite | null;
  readonly assignedPhysician?: CasePhysicianLite | null;
  readonly assignedRn?: AssignedRnLite | null;
  // RECORDS signal (binary): true once the case has >=1 veteran-UPLOADED document, EXCLUDING the
  // auto-generated intake summary and physician Doctor Pack. recordCount is that filtered count.
  // Lets the Cases list show "Records in" vs "Awaiting records" at a glance (Stage 2 done vs Stage-1-only).
  readonly recordsUploaded?: boolean;
  readonly recordCount?: number;
  // INVOICED signal: a letter_500 Payment row sits at status='invoiced' (the RN sent the invoice
  // email; the case status deliberately stays 'delivered' until payment reconciles to 'paid').
  readonly invoiced?: boolean;
}

export interface QuickNote { readonly id: string; readonly quickNote: string | null; readonly quickNoteBy: string | null; readonly quickNoteAt: string | null; }

// Overwrite the claim's quick-note scratchpad (empty string clears it). Does not bump case version.
// PATCH not PUT — the API Gateway CORS only allows GET/POST/PATCH/DELETE (a PUT preflight is blocked).
export async function updateQuickNote(id: string, note: string): Promise<{ data: QuickNote }> {
  return apiPatch(`/api/v1/cases/${encodeURIComponent(id)}/quick-note`, { note });
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
  // Multi-status filter (group-tile deep-links, D2). Sent as a comma-joined `statuses` param →
  // where.status.in. Takes precedence over single `status` server-side when both are present.
  readonly statuses?: readonly CaseStatus[];
  readonly claimType?: ClaimType;
  readonly veteranId?: string;
  readonly assignedPhysicianId?: string;
  // Single AppUser id, '__none__' (unassigned), or a comma-separated mix — the RN multi-filter.
  readonly assignedRnId?: string;
  readonly archived?: boolean; // true = show only archived (soft-deleted) claims
  readonly page?: number;
  readonly pageSize?: number;
}

export async function listCases(params: ListCasesParams = {}): Promise<CaseListResult> {
  const sp = new URLSearchParams();
  if (params.statuses && params.statuses.length > 0) sp.set('statuses', params.statuses.join(','));
  else if (params.status) sp.set('status', params.status);
  if (params.claimType) sp.set('claimType', params.claimType);
  if (params.veteranId) sp.set('veteranId', params.veteranId);
  if (params.assignedPhysicianId) sp.set('assignedPhysicianId', params.assignedPhysicianId);
  if (params.assignedRnId) sp.set('assignedRnId', params.assignedRnId);
  if (params.archived) sp.set('archived', 'true');
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  const qs = sp.toString();
  return apiGet<CaseListResult>(`/api/v1/cases${qs ? `?${qs}` : ''}`);
}

export interface CreateCaseInput {
  readonly id: string;
  readonly claimedCondition: string;
  // Multi-condition clustered claim (all in one body system). claimedCondition stays the primary.
  readonly claimedConditions?: string[];
  readonly claimType: ClaimType;
  readonly framingChoice?: string;
  readonly upstreamScCondition?: string;
  readonly veteranStatement?: string;
  readonly inServiceEvent?: string;
}

export async function createCase(veteranId: string, input: CreateCaseInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/cases`, input);
}

// Pre-flight approve gate flag (GET /cases/:id, physician_review only). Advisory mirror of the
// POST /letter/approve gates so the physician sees blockers BEFORE attesting; `code` matches the
// 409 envelope's details.reason verbatim. Absent field = fail-open (no banner).
export interface ApproveBlocker { readonly code: string; readonly message: string; }

export interface CaseDetail extends Case {
  readonly approveBlockers?: readonly ApproveBlocker[];
  readonly quickNote?: string | null;
  readonly quickNoteBy?: string | null;
  readonly quickNoteAt?: string | null;
  readonly veteran?: CaseVeteranLite | null;
  readonly assignedPhysician?: CasePhysicianLite | null;
  readonly assignedRn?: AssignedRnLite | null;
  readonly documents?: readonly Document[];
  readonly draftJobs?: readonly DraftJob[];
  readonly corrections?: readonly Correction[];
  readonly emails?: readonly Email[];
  readonly payments?: readonly Payment[];
  readonly _count?: { readonly documents: number; readonly draftJobs: number; readonly corrections: number; readonly emails: number; readonly payments: number };
  // Authoritative drafting cost summed over ALL the case's DraftJobs (backend aggregate, not the
  // truncated take:5 draftJobs list). null when no job carries a recorded cost → UI shows "—".
  readonly draftingCostUsd?: number | null;
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

export interface AssignPhysicianInput { readonly physicianId: string; readonly version: number }
export interface AssignRnInput { readonly rnUserId: string; readonly version: number }

export async function assignCasePhysician(id: string, input: AssignPhysicianInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/assign-physician`, input);
}

export async function assignCaseRn(id: string, input: AssignRnInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/assign-rn`, input);
}

// Archive (soft-delete, reversible) — same endpoint, now sets archived_at instead of hard-deleting.
export async function archiveCase(id: string): Promise<void> {
  return apiDelete(`/api/v1/cases/${encodeURIComponent(id)}`);
}
export async function restoreCase(id: string): Promise<{ data: unknown }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/restore`, {});
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
  // Clustered-claim enrichment (present when cdsRationale was built by evaluateCdsMulti). The
  // overall verdict/odds above belong to the driver condition; perCondition lists every member.
  readonly driverCondition?: string;
  readonly perCondition?: readonly { readonly condition: string; readonly result: CdsResult }[];
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
  // Queue enrichment (Package 1 (J), 2026-06-11) — present on the files-pending-manual payloads.
  // veteranName ("Last, First") + claimedCondition tell the RN WHO/WHAT; documentId is the matching
  // chart Document (null when the file was deleted — render plain text, not a dead link); fileName
  // is the human filename (uuid prefix stripped server-side). All optional for back-compat.
  readonly veteranName?: string | null;
  readonly claimedCondition?: string | null;
  readonly documentId?: string | null;
  readonly fileName?: string | null;
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

// === Phase 7B-revised closeout: KeyDoc RN acknowledgement ===

export interface KeyDocAckInput {
  readonly notes?: string;
}

export async function acknowledgeKeyDoc(
  keyDocId: string,
  input: KeyDocAckInput = {},
): Promise<{ data: { id: string; needsRnReview: boolean; selectorAcknowledgedAt: string | null } }> {
  return apiPost(`/api/v1/key-docs/${encodeURIComponent(keyDocId)}/acknowledge`, input);
}

export interface KeyDocReviewRow {
  readonly id: string;
  readonly caseId: string;
  readonly filePath: string;
  readonly docType: string;
  readonly classification: string;
  readonly importance: number;
  readonly needsRnReview: boolean;
  readonly selectorVersion: string | null;
  readonly selectorRationale: string | null;
  readonly notes: string | null;
  readonly updatedAt: string;
  readonly version: number;
  // Item 3 (2026-06-11): server-side join on Document.s3Key — human filename for display +
  // documentId for the presigned "Open" viewer. Null when the source Document is gone.
  readonly filename?: string | null;
  readonly documentId?: string | null;
  // WAVE 2 (assessment 2026-06-12 §3): server-computed '<DocType human name> — <original
  // filename>' ('unspecified' → just the filename). Card copy renders it when present.
  readonly displayLabel?: string | null;
}

export async function listKeyDocsNeedingReview(limit?: number): Promise<{ data: readonly KeyDocReviewRow[]; total: number }> {
  const qs = typeof limit === 'number' ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return apiGet(`/api/v1/rn/key-docs-needing-review${qs}`);
}

// Keystone 4b — case-level reprocess: re-OCR every document lacking a terminal read status (the
// shared CopyObject nudge) + force a chart re-extract via a salted triggerHash. Idempotent;
// admin/ops_staff. extractEnqueued=false with extractReason='ocr_in_progress' means the re-OCR'd
// docs will re-trigger extraction naturally when they finish reading.
export interface ReprocessSummary {
  readonly reocrQueued: number;
  readonly reocrFailed?: readonly { documentId: string; reason: string }[];
  readonly extractEnqueued: boolean;
  readonly extractReason?: string;
  readonly requestId: string;
}

export async function reprocessCase(caseId: string): Promise<{ data: ReprocessSummary }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/reprocess`, {});
}
