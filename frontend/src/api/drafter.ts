import axios from 'axios';
import { apiGet, apiPost } from './client';
import { transitionCaseStatus, type TransitionInput } from './cases';
import { declineLetter } from './letter';

export interface RnDecisionInput {
  readonly gate2Override?: boolean;
  readonly switchToCondition?: string;
  readonly proceed?: boolean;
  readonly reason?: string;
  readonly rnUser?: string;
}

export interface DraftRequestInput {
  readonly strategyOverride?: string;
  readonly parentVersion?: number;
  // Override the chart-readiness / essential-docs block and draft anyway (logged reason). Never a dead-end.
  readonly acknowledgeMissingDocs?: boolean;
  readonly overrideReason?: string;
  // Gate-2 resume: the RN's decision on a parked (needs_rn_decision) case.
  readonly rnDecision?: RnDecisionInput;
}

export interface DraftDecision {
  readonly id: string;
  readonly caseId: string;
  readonly draftAttempt: number;
  readonly gate: number; // 1 = checklist, 2 = ai_verification
  readonly item: string;
  readonly decision: string;
  readonly reason: string | null;
  readonly rnUser: string;
  readonly createdAt: string;
}

export async function getDraftDecisions(caseId: string): Promise<{ data: readonly DraftDecision[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-decisions`);
}

// Cancel an in-flight draft (stops the ~$15 spend — the drafter aborts on its next heartbeat).
export async function cancelDraftJob(caseId: string, jobId: string): Promise<{ data: unknown }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

export async function postGate1Attestations(caseId: string, draftAttempt: number, items: ReadonlyArray<{ item: string; decision: string; reason?: string }>): Promise<{ data: { written: number } }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-decisions`, { draftAttempt, items });
}

// Queue-position snapshot computed by the backend from the DraftJob table. `running` excludes
// zombie (crashed-but-unreaped) jobs; `max` is the drafter's concurrency ceiling. When running===max
// and queuedAhead>=1 the drafter is genuinely full and this job is waiting in line.
export interface DraftConcurrency {
  readonly running: number;
  readonly max: number;
  readonly queuedAhead: number;
  readonly queuePosition: number;
}

export interface DraftPublishResult {
  // AUTO-RECOVERY (document auto-recovery loop, 2026-06-14): a 202 "preparing" response means the chart
  // wasn't ready so the backend auto-fired a re-read/re-extract instead of dead-ending. There is NO job
  // yet — the panel shows "Reading the documents…" and its readiness poll auto-resumes the draft when
  // the chart reaches chart_ready. Absent on a normal 201 (a real queued job).
  readonly preparing?: boolean;
  readonly autoRemediated?: boolean;
  readonly reocrQueued?: number;
  readonly message?: string;
  readonly job?: unknown;
  readonly publish?: unknown;
  // Folded into the POST /draft 201 so the click knows its place in line immediately. null when the
  // count could not be computed (never fails the enqueue).
  readonly concurrency?: DraftConcurrency | null;
}

// Thin poll read for the queue-position panel: the live concurrency snapshot for this case's newest
// in-flight DraftJob. concurrency is null when no queued/running job exists for the case.
export interface DraftConcurrencyResult {
  readonly jobId?: string;
  readonly state?: string;
  readonly concurrency: DraftConcurrency | null;
}

export async function getDraftConcurrency(caseId: string): Promise<{ data: DraftConcurrencyResult }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-concurrency`);
}

export async function postDraft(
  caseId: string,
  input: DraftRequestInput = {},
): Promise<{ data: DraftPublishResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/draft`, input);
}

export interface SendBackToRnInput {
  readonly caseId: string;
  readonly veteranId: string;
  readonly from: TransitionInput['from'];
  readonly version: number;
  readonly note?: string;
}

export async function sendBackToRn(input: SendBackToRnInput): Promise<void> {
  const trimmedNote = input.note?.trim();

  if (trimmedNote) {
    // The doctor's note MUST reach the RN on the case ACTION page. /letter/decline is the purpose-built
    // path: in ONE transaction it sets Case.operatorMessage (the amber "the doctor sent this back with a
    // correction note" box the RN Action tab reads) AND drops a case-linked StaffMessage into the RN's
    // inbox AND does the correction_requested transition + activity log. The OLD path wrote the note to a
    // veteran-scoped chart note (invisible on the Action page) and flipped status with a GENERIC hardcoded
    // reason, so the RN saw only the status change with NO content (Dr. Kasky 2026-06-26). declineLetter
    // requires a non-empty reason — which is exactly this note.
    await declineLetter(input.caseId, { reason: trimmedNote });
    return;
  }

  // No note → just flip the status; there is no message to deliver.
  await transitionCaseStatus(input.caseId, {
    from: input.from,
    to: 'correction_requested',
    version: input.version,
  });
}

// Phase 8 PDF download — backend endpoint returns a 5-min presigned GET URL for the
// DraftJob's artifactPdfS3Key. The PhysicianLetterReadyPanel's onOpenPdf callback uses
// this; the brief intentionally left "Open PDF" as an injected callback rather than
// inventing a URL.
export interface ArtifactPdfUrlResult {
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export async function getArtifactPdfUrl(
  caseId: string,
  jobId: string,
): Promise<{ data: ArtifactPdfUrlResult }> {
  return apiGet(
    `/api/v1/cases/${encodeURIComponent(caseId)}/draft-jobs/${encodeURIComponent(jobId)}/artifact-pdf-url`,
  );
}

// ── Import final letter (2026-06-14) ────────────────────────────────────────
// Drop an already-FINISHED letter PDF (a rig-origin draft or an externally-signed letter) onto a
// case so it lands in the RN review queue and flows RN -> physician -> delivery. No re-render —
// the exact PDF bytes are preserved. Three steps: presign -> S3 PUT -> commit (mirrors the avatar
// upload pattern in api/users.ts).
export interface PresignImportLetter {
  readonly uploadUrl: string;
  readonly s3Key: string;
  readonly version: number;
  readonly expiresInSeconds: number;
  readonly requiredHeaders: Record<string, string>;
}

export interface ImportLetterResult {
  readonly ok: boolean;
  readonly version: number;
  readonly draftJobId?: string;
  readonly alreadyImported?: boolean;
}

export function validateImportLetterFile(file: File): string | null {
  if (file.type !== 'application/pdf') return 'The imported letter must be a PDF.';
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > 50 * 1024 * 1024) return 'The PDF must be 50 MB or smaller.';
  return null;
}

// The presign route wraps under { data }; the commit route returns the result FLAT
// ({ ok, version, ... }) — matching the backend res.json shapes exactly.
export async function presignImportLetter(caseId: string): Promise<{ data: PresignImportLetter }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/letter/import-presign`, {});
}

export async function commitImportLetter(
  caseId: string,
  input: { s3Key: string; filename?: string },
): Promise<ImportLetterResult> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/letter/import`, input);
}

// Presign -> PUT the exact bytes -> commit. Returns the import result (version + idempotency flag).
export async function uploadAndImportLetter(caseId: string, file: File): Promise<ImportLetterResult> {
  const problem = validateImportLetterFile(file);
  if (problem !== null) throw new Error(problem);
  const presign = await presignImportLetter(caseId);
  await axios.put(presign.data.uploadUrl, file, { headers: presign.data.requiredHeaders });
  return commitImportLetter(caseId, { s3Key: presign.data.s3Key, filename: file.name });
}
