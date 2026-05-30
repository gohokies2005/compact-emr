import { apiGet, apiPost, apiPut } from './client';

// Mirrors the backend contract (routes/letter.ts). The TXT is the single source of truth;
// surgical-AI returns an OPAQUE structured `proposal` (echo it back to apply) plus a `preview`
// (the full resulting text, for display). Warnings are { rule, detail }.

export type LetterRole = 'ops_staff' | 'physician' | 'admin';

export interface LetterLockedRange {
  readonly start: number;
  readonly end: number;
  readonly label?: string | null;
}

export interface LetterRenderedUrls {
  readonly pdfUrl: string | null;
  readonly docxUrl: string | null;
}

export interface LetterWarning {
  readonly rule: string;
  readonly detail: string;
}

export interface LetterPayload {
  readonly version: number;
  readonly txt: string;
  readonly locked_ranges: readonly LetterLockedRange[];
  readonly rendered: LetterRenderedUrls;
  readonly role: LetterRole;
}

export interface LetterSaveResult {
  readonly version: number;
  readonly txt: string;
  // PUT returns render-success flags (not URLs); refetch GET for fresh presigned URLs.
  readonly rendered?: { readonly pdf: boolean; readonly docx: boolean };
  readonly warnings: readonly LetterWarning[];
}

/** Opaque structured edit from the proposer — echo back to apply verbatim. */
export interface SurgicalProposal {
  readonly operation: 'replace' | 'insert_after' | 'insert_before';
  readonly anchor_text: string;
  readonly new_text: string;
}

export interface SurgicalPreviewResult {
  readonly proposal: SurgicalProposal;
  readonly preview: string; // full resulting letter text, for on-screen preview
  readonly warnings: readonly LetterWarning[];
  readonly costUsd: number;
  readonly model: string;
}

export interface LetterApproveResult {
  readonly version: number;
  readonly status: string;
  readonly finalPdfKey: string;
}

function caseLetterPath(caseId: string, suffix = ''): string {
  return `/api/v1/cases/${encodeURIComponent(caseId)}/letter${suffix}`;
}

export function getLetter(caseId: string): Promise<{ data: LetterPayload }> {
  return apiGet<{ data: LetterPayload }>(caseLetterPath(caseId));
}

export function saveLetter(caseId: string, input: { base_version: number; txt: string }): Promise<{ data: LetterSaveResult }> {
  return apiPut<{ data: LetterSaveResult }, typeof input>(caseLetterPath(caseId), input);
}

export function previewSurgicalAi(caseId: string, input: { instruction: string }): Promise<{ data: SurgicalPreviewResult }> {
  return apiPost<{ data: SurgicalPreviewResult }, typeof input>(caseLetterPath(caseId, '/surgical-ai'), input);
}

export function applySurgicalAi(caseId: string, proposal: SurgicalProposal): Promise<{ data: LetterSaveResult }> {
  return apiPost<{ data: LetterSaveResult }, { apply: true; proposal: SurgicalProposal }>(caseLetterPath(caseId, '/surgical-ai'), { apply: true, proposal });
}

export function approveLetter(caseId: string): Promise<{ data: LetterApproveResult }> {
  return apiPost<{ data: LetterApproveResult }, Record<string, never>>(caseLetterPath(caseId, '/approve'), {});
}

export function declineLetter(caseId: string, input: { reason: string }): Promise<{ data: { status: string } }> {
  return apiPost<{ data: { status: string } }, typeof input>(caseLetterPath(caseId, '/decline'), input);
}
