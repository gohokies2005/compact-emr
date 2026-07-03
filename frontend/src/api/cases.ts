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
  // Latest PERSISTENT quick note for this case's veteran (newest chart-notes-stream entry flagged
  // isQuickNote), batch-attached server-side. Replaces the retired overwritable scratchpad
  // (case.quick_note*, "Feature A"). Null when the veteran has no quick note yet. (Ryan 2026-06-21)
  readonly latestQuickNote?: LatestQuickNote | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  // Soft-delete timestamp (C5 lifecycle, 2026-06-13). Non-null = archived → the Closed view
  // labels it under the "Archived" status group. Absent on older API responses → treated active.
  readonly archivedAt?: string | null;
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

// Latest persistent quick note attached to a Cases-list row (subset of the chart-notes-stream entry
// the backend surfaces). The list shows the body + a relative timestamp; author name is resolved by
// the case-detail / chart latest-quick endpoint when needed, not on the list row.
export interface LatestQuickNote {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

// RETIRED 2026-06-21: the overwritable case quick-note scratchpad (PATCH /cases/:id/quick-note → 410
// Gone) and its updateQuickNote() client are gone. Quick notes are now persistent chart-notes-stream
// entries written via createChartNote(veteranId, body, /*isQuickNote*/ true) in api/chart-notes.ts.

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
  // true = archived ONLY; 'all' = active + archived in one query (the Closed toggle, C5
  // lifecycle 2026-06-13); omitted/false = active only (default).
  readonly archived?: boolean | 'all';
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
  if (params.archived === 'all') sp.set('archived', 'all');
  else if (params.archived) sp.set('archived', 'true');
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
  // Soft-delete timestamp (C6 lifecycle, 2026-06-13). Non-null = archived → the claim page shows
  // Reopen instead of Archive. GET /cases/:id returns the full Case row, so this is already present.
  readonly archivedAt?: string | null;
  // DEPRECATED (Feature-A scratchpad retired 2026-06-21): the DB columns still exist (nullable) so the
  // full Case row may still carry them, but nothing writes them anymore — always null in practice. The
  // case header now reads the latest PERSISTENT quick note from the chart-notes stream, not these.
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
  // "Date submitted" (Item 2): the STAGE-2 records-received moment — the earliest veteran-uploaded
  // record's uploadedAt (excluding the generated intake summary + Doctor Pack), captured once and
  // STATIC (MIN never moves when later records arrive). null until the first real record lands. Shown
  // on the physician review header. Computed server-side on GET /cases/:id.
  readonly recordsReceivedAt?: string | null;
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

// "Return to physician" (Item 1): RN/ops sends a FINALIZED (Ready for delivery) letter BACK to the
// assigned physician's review queue with a MANDATORY explanatory message. Dedicated route (NOT the
// generic /status flip, which stays admin-only) — the backend writes the delivered->physician_review
// transition AND the case message atomically, so the physician always sees why it came back.
export interface ReturnToPhysicianInput { readonly version: number; readonly message: string }
export async function returnCaseToPhysician(id: string, input: ReturnToPhysicianInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/return-to-physician`, input);
}

// "Revise letter" (Ryan 2026-07-03): RN reopens a DELIVERED or PAID letter for a surgical edit — moves it
// to correction_requested (the RN-editable state) with a MANDATORY note. NOT a redraft; the signed letter
// stays current until the RN edits it. Dedicated route (no billing change; physician still re-signs).
export interface ReviseLetterInput { readonly version: number; readonly message: string }
export async function reviseLetter(id: string, input: ReviseLetterInput): Promise<{ data: CaseLite }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/revise-letter`, input);
}

// "Publish corrected letter" (Ryan 2026-07-03): after a correction is re-signed, re-issue the customer's
// secure download link to the corrected version (expires the stale link, emails a fresh one). No re-charge.
export interface PublishCorrectionResult {
  readonly status: 'reissued' | 'reissued_email_pending' | 'already_current' | string;
  readonly version?: number;
  readonly emailId?: string;
  readonly reason?: string;
}
export async function publishCorrection(id: string): Promise<{ data: PublishCorrectionResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(id)}/delivery/publish-correction`, {});
}

// "What changed since the physician last signed" (Ryan 2026-07-03): deterministic sentence-level diff
// between the last-signed version and the current version, so the physician re-signing an RN correction can
// glance instead of re-reading. Fail-open: { available:false } means no panel is shown.
export interface LetterDiffSegment { readonly kind: 'unchanged' | 'added' | 'removed'; readonly text: string }
export interface LetterChangesSinceSigned {
  readonly available: boolean;
  readonly changed?: boolean;
  readonly signedVersion?: number;
  readonly currentVersion?: number;
  readonly signedAt?: string;
  readonly addedCount?: number;
  readonly removedCount?: number;
  readonly segments?: readonly LetterDiffSegment[];
  readonly reason?: string;
}
export async function getLetterChangesSinceSigned(id: string): Promise<{ data: LetterChangesSinceSigned }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(id)}/letter/changes-since-signed`);
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
  // Chart-readiness machine-read gate override (CLM-4DACAF4A80, 2026-06-14). Set when a physician/admin
  // signs off despite uploaded files that could not be auto-read, which they have personally reviewed.
  // The backend requires BOTH the flag AND a non-empty reason AND a signing role — otherwise it keeps
  // the descriptive 409. Absent on the normal (gate-passes) flow — the payload is byte-identical then.
  readonly overrideChartReadiness?: boolean;
  readonly chartReadinessOverrideReason?: string;
}

// The structured chart-readiness blocking file the gate's 409 carries in error.details.blockingFiles.
// Mirrors the backend ChartReadinessBlocker shape (the fields the override UI needs).
export interface ChartReadinessBlockingFile {
  readonly fileReadStatusId: string;
  readonly filePath: string;
  readonly terminalStatus: string;
  readonly lastAttempt: { readonly note: string | null } | null;
  readonly documentId?: string | null;
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

// REMOVED (C7 lifecycle, 2026-06-13): KeyDocAckInput / acknowledgeKeyDoc / KeyDocReviewRow /
// listKeyDocsNeedingReview — the API client for the vestigial RN "Confirm pack pages" review tab.
// The backend endpoints (GET /rn/key-docs-needing-review, POST /key-docs/:id/acknowledge) were
// deleted with it. The live doctor-pack panel uses the separate /cases/:id/key-docs path (see
// api/doctorPack.ts), which is untouched.

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

// documentIds (optional) — the "Reprocess documents" modal selection. When provided, those exact docs
// are FORCE re-read (their prior OCR pages are cleared so even an already-'read' doc re-runs through the
// vision pipeline — the Stephens fix). Omit = legacy behavior (only re-OCR docs without a terminal read).
export async function reprocessCase(caseId: string, documentIds?: readonly string[]): Promise<{ data: ReprocessSummary }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/reprocess`, documentIds ? { documentIds } : {});
}
