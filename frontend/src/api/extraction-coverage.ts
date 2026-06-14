import { apiGet } from './client';

// Chart Extraction Coverage — the per-case TRANSPARENCY report (Ryan 2026-06-14). The backend
// (GET /api/v1/cases/:id/extraction-coverage) assembles this from existing data; the panel renders
// "N% of pages extracted" + a specific list of what was not. ADVISORY — it blocks nothing.
// Shapes mirror backend/src/services/extraction-coverage.ts exactly.

export type CoverageGapReason =
  | 'unreadable_image'
  | 'unread'
  | 'truncated_dense'
  | 'needs_manual_summary'
  | 'extraction_gap';

export type CoverageStatus = 'complete' | 'complete_with_gaps' | 'in_progress' | 'failed';

export interface CoverageGap {
  // null for a run-level gap (truncated/uncovered pages aren't tied to one document); a documentId
  // for a file-level gap → the panel opens a presigned inline view.
  readonly documentId: string | null;
  readonly fileName: string;
  readonly reason: CoverageGapReason;
  readonly pageLabel: string;
  // image file → the panel offers "Request AI description".
  readonly isImage: boolean;
  readonly terminalStatus: string | null;
}

export interface ExtractionCoverage {
  readonly totalPages: number;
  readonly extractedPages: number;
  readonly coveragePct: number;
  readonly gaps: readonly CoverageGap[];
  readonly status: CoverageStatus;
  // > 0 → some files had no page count (counted as 1 unit each); the headline must say "approximate".
  readonly unknownPageFiles: number;
  readonly totalFiles: number;
}

export async function getExtractionCoverage(caseId: string): Promise<{ data: ExtractionCoverage }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/extraction-coverage`);
}
