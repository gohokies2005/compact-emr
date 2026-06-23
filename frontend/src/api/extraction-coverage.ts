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
  | 'extraction_gap'
  | 'extraction_incomplete'; // the chart analysis (semantic extract) did not finish — distinct from OCR

export type CoverageStatus = 'complete' | 'complete_with_gaps' | 'in_progress' | 'failed';

// TWO-STAGE honesty model (Ryan 2026-06-23) — mirrors backend/src/services/extraction-coverage.ts.
export interface PagesReadStage {
  readonly pct: number;
  readonly readUnits: number;
  readonly totalUnits: number;
  readonly approximate: boolean;
  readonly label: string; // "100% (28 of 28)" / "28 files, page counts unavailable"
}

// 'not_analyzed' (Ryan 2026-06-23): no analysis run on record yet OR nothing to analyze — NOT a failure/gap;
// does NOT trip the SOAP banner / provisional verdict / cause-file. Mirrors backend extraction-coverage.ts.
export type ChartAnalysisState = 'complete' | 'in_progress' | 'incomplete' | 'failed' | 'not_analyzed';

export interface ChartAnalysisStage {
  readonly state: ChartAnalysisState;
  readonly label: string; // "✓ Complete (253 findings)" / "⚠ Chart analysis didn’t finish — retry"
  readonly reason: string | null;
  readonly likelyCauseFile: string | null;
  readonly findings: number | null;
}

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

// Per-page vision breakdown (vision rebuild 2026-06-16). null for non-vision charts (Textract/native/
// legacy) → the panel shows only the file-level numbers, exactly as before.
export interface PageReviewRef {
  readonly documentId: string;
  readonly fileName: string;
  readonly pageNumber: number;
  readonly reason: 'handwriting_uncertain' | 'unreadable';
}

export interface PageCoverageBreakdown {
  readonly pagesWithSignal: number;
  readonly clean: number; // captured with confidence
  readonly handwritingUncertain: number; // content present, low-confidence regions — confirm
  readonly blank: number; // verified empty — silent, not a gap to chase
  readonly unreadable: number; // almost nothing read — needs a look
  readonly reviewPages: readonly PageReviewRef[];
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
  readonly pageBreakdown: PageCoverageBreakdown | null;
  // Two-stage SSOT: the card renders these two lines; the SOAP banner reads chartAnalysis.state.
  readonly pagesRead: PagesReadStage;
  readonly chartAnalysis: ChartAnalysisStage;
}

export async function getExtractionCoverage(caseId: string): Promise<{ data: ExtractionCoverage }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/extraction-coverage`);
}
