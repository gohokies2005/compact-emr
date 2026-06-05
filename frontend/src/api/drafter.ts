import { apiGet, apiPost } from './client';
import { createChartNote } from './chart-notes';
import { transitionCaseStatus, type TransitionInput } from './cases';
import type { CaseLite } from './cases';

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

export async function postGate1Attestations(caseId: string, draftAttempt: number, items: ReadonlyArray<{ item: string; decision: string; reason?: string }>): Promise<{ data: { written: number } }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-decisions`, { draftAttempt, items });
}

export interface DraftPublishResult {
  readonly job: unknown;
  readonly publish: unknown;
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

export async function sendBackToRn(input: SendBackToRnInput): Promise<{ data: CaseLite }> {
  const trimmedNote = input.note?.trim();

  if (trimmedNote) {
    await createChartNote(input.veteranId, trimmedNote);
  }

  return transitionCaseStatus(input.caseId, {
    from: input.from,
    to: 'correction_requested',
    version: input.version,
    ...(trimmedNote && { transitionReason: 'physician requested major rework' }),
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
