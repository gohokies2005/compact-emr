import { apiGet, apiPost, apiPut } from './client';
import type { SignOffAnswers } from './cases';

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
  // The CURRENT LetterRevision's source (import deliver-as-is, 2026-06-14). 'external_import' means an
  // operator-imported finished PDF: it must be FINALIZED AS-IS (no re-render), never re-rendered by
  // the normal Approve. null on a plain DraftJob / older API responses (normal rendered lifecycle).
  readonly source?: string | null;
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

// ── Guided Revision (Guided Revision UI, 2026-06-13) ─────────────────────────────────────────
// The broader physician edit tier: highlight a verbatim `passage` of the current letter + give an
// instruction; Opus reshapes ONLY that passage. The backend pins operation='replace' +
// anchor_text=passage, runs the §VII-holding lock + citation-integrity guard, and returns a SAFE,
// dry-run preview the physician must inspect before accepting. Distinct response shape from the
// surgical preview: `warnings` is string[] (human sentences), plus `sanity` + `citationDiff`.

/** A cited-fact token (PMID / author-year / statistic) the integrity guard tracks. */
export interface CitationToken {
  readonly kind: 'pmid' | 'author_year' | 'stat';
  readonly key: string;
  readonly raw: string;
}

/** Cited facts ADDED (model-invented → backend REJECTS) vs REMOVED (dropped → backend WARNS). */
export interface CitationDiff {
  readonly added: readonly CitationToken[];
  readonly removed: readonly CitationToken[];
}

/** A letter-sanity finding on the would-be revised letter (rule + human-readable detail). */
export interface SanityFinding {
  readonly rule: string;
  readonly detail: string;
}

export interface GuidedRevisionResult {
  readonly mode: 'guided_revision';
  readonly proposal: SurgicalProposal;
  readonly preview: string; // full resulting letter text (dry-run), for on-screen preview
  readonly warnings: readonly string[]; // human sentences (e.g. a dropped-citation acknowledgement)
  readonly sanity: readonly SanityFinding[];
  readonly citationDiff: CitationDiff;
  readonly costUsd: number;
  readonly model: string;
}

/** The reasons a guided-revision PROPOSE is rejected (422) — carried on the error `details.reason`. */
export type GuidedRevisionRejectReason =
  | 'citation_invented'
  | 'holding_changed'
  | 'edit_unappliable'
  | 'passage_not_found'
  | 'passage_required';

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

// Guided-revision PROPOSE. Propose-only — never auto-applies. On success returns the dry-run
// preview + warnings + citationDiff; on a guard trip the API returns 422 (mapped to
// SurgicalEditUnappliableError by client.ts, whose `details.reason` is one of
// GuidedRevisionRejectReason and may carry `citationDiff`) or 503 (ServiceUnavailableError when the
// GUIDED_REVISION_ENABLED flag is off). APPLY reuses applySurgicalAi (the shared { apply, proposal }
// door) unchanged. (Guided Revision UI, 2026-06-13)
export function proposeGuidedRevision(caseId: string, input: { passage: string; instruction: string }): Promise<{ data: GuidedRevisionResult }> {
  return apiPost<{ data: GuidedRevisionResult }, { mode: 'guided_revision'; passage: string; instruction: string }>(
    caseLetterPath(caseId, '/surgical-ai'),
    { mode: 'guided_revision', passage: input.passage, instruction: input.instruction },
  );
}

export function applySurgicalAi(caseId: string, proposal: SurgicalProposal): Promise<{ data: LetterSaveResult }> {
  return apiPost<{ data: LetterSaveResult }, { apply: true; proposal: SurgicalProposal }>(caseLetterPath(caseId, '/surgical-ai'), { apply: true, proposal });
}

export function approveLetter(caseId: string): Promise<{ data: LetterApproveResult }> {
  return apiPost<{ data: LetterApproveResult }, Record<string, never>>(caseLetterPath(caseId, '/approve'), {});
}

// ── Finalize an IMPORTED letter for delivery AS-IS (import deliver-as-is, 2026-06-14) ──
// For a current revision whose source is 'external_import'. Records the physician sign-off bound to
// the EXACT imported PDF bytes + flips the case to 'delivered' WITHOUT re-rendering — the imported
// PDF is the final artifact. Distinct from approveLetter (which re-renders from the TXT and would
// mangle the imported PDF). Same affirmative-answers contract as the sign-off popup.
export interface LetterFinalizeImportResult {
  readonly version: number;
  readonly status: string;
  readonly signOffId: string;
  readonly finalPdfKey: string;
  readonly source: 'external_import';
}

export function finalizeImportLetter(caseId: string, input: { answers: SignOffAnswers; notes?: string }): Promise<{ data: LetterFinalizeImportResult }> {
  return apiPost<{ data: LetterFinalizeImportResult }, typeof input>(caseLetterPath(caseId, '/finalize-import'), input);
}

export function declineLetter(caseId: string, input: { reason: string }): Promise<{ data: { status: string } }> {
  return apiPost<{ data: { status: string } }, typeof input>(caseLetterPath(caseId, '/decline'), input);
}
