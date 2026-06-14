import { isScreeningSummaryKey, type ExtractionRunRef } from './chart-build-state.js';
import { isEffectivelyRead, isIntakeSummaryPath, originalFileName } from './chart-readiness.js';
import type { FileReadStatusRecord } from './db-types.js';

/**
 * Chart Extraction Coverage — a per-case TRANSPARENCY report (Ryan 2026-06-14).
 *
 * The owner has low confidence in the extractor and wants VISIBLE, specific coverage: "95% of pages
 * successfully extracted" with a hyperlinked, specific list of WHAT was not extracted — file name +
 * page + reason — easy to check, NEVER a hard failure. This module ASSEMBLES that report from data
 * that ALREADY exists; it does NOT re-extract anything:
 *
 *   • document rows           → the universe of chart pages (filename, s3Key, pageCount).
 *   • file_read_status rows    → per-file read outcome, judged through the SHARED isEffectivelyRead
 *                                predicate (the SAME one GET /chart-readiness + the gates use — no
 *                                divergent readiness read, the recurring divergence class).
 *   • latest ChartExtractionRun → resultJson.gaps.{uncoveredPages,truncatedWindows} + status, the
 *                                 EXTRACTION-phase gaps (pages OCR'd but not folded into the chart).
 *
 * Advisory ONLY. This is a report; it blocks nothing. Coverage < 100% is amber, never red.
 *
 * EXCLUSIONS (extraction OUTPUTS, not chart inputs — must NOT count as chart pages):
 *   • the screening-summary file        (isScreeningSummaryKey — `…00000000-screening-summary.txt`)
 *   • rendered outputs under `_rendered/` (cover index, statement, letter PDFs the EMR generates)
 * The generated intake-summary PDF (isIntakeSummaryPath) IS a real readable chart input and counts.
 *
 * HONESTY ABOUT UNKNOWNS: when a Document has no pageCount we count it as ONE unit and SAY SO
 * (pageCountKnown=false on the doc, and `unknownPageFiles` on the summary), rather than fabricating a
 * page total. We never claim 100% of pages when some page counts are unavailable.
 */

// A rendered EMR output (cover index, veteran statement, the letter PDFs) is minted under the
// `cases/<caseId>/_rendered/...` prefix (doctor-pack-generate.ts / record-text-render.ts). It is an
// OUTPUT, never an uploaded chart record, so it must never count as a chart page nor appear as a gap.
// Single recogniser here so the exclusion lives in one place (mirrors isScreeningSummaryKey's pattern).
export function isRenderedOutputKey(s3Key: string): boolean {
  return typeof s3Key === 'string' && /\/_rendered\//.test(s3Key);
}

/** A Document is a chart INPUT iff it is not a screening-summary and not a rendered output. */
export function isChartInputKey(s3Key: string): boolean {
  return !isScreeningSummaryKey(s3Key) && !isRenderedOutputKey(s3Key);
}

// ====================== Inputs ======================

export interface CoverageDocInput {
  readonly id: string;
  readonly s3Key: string;
  // The stored original filename (Document.filename). Optional: the service falls back to recovering
  // the human name from the s3Key (originalFileName) when absent, so a caller that only has the key
  // still produces a readable label.
  readonly filename?: string | null;
  readonly contentType?: string | null;
  readonly pageCount?: number | null;
}

export type CoverageGapReason =
  | 'unreadable_image' // a textless image file (jpg/png) → can request an AI description
  | 'unread' // a file that failed OCR and has no manual summary (manual_summary_required)
  | 'truncated_dense' // the extraction run truncated dense windows (resultJson.gaps.truncatedWindows)
  | 'needs_manual_summary' // alias surface for a blocking file awaiting an RN summary
  | 'extraction_gap'; // pages OCR'd but left uncovered by the extraction run (gaps.uncoveredPages)

export interface CoverageGap {
  // documentId is null for a run-level gap (truncated/uncovered pages aren't tied to one document in
  // resultJson today — only counts are recorded). File-level gaps always carry it so the UI can open
  // a presigned view.
  readonly documentId: string | null;
  readonly fileName: string;
  readonly reason: CoverageGapReason;
  // Human-readable scope of the gap: "p.6" / "3 of 12 pages" / "whole file" / "12 pages".
  readonly pageLabel: string;
  // True when the gap is an image file (content-type image/* or a jpg/png/gif/webp/tiff/heic key) →
  // the UI can offer "Request AI description". Run-level gaps are never images.
  readonly isImage: boolean;
  // The readiness terminalStatus that produced a file-level gap (null for run-level gaps) — lets the
  // UI tailor copy ("needs a manual summary" vs "auto-skipped") without re-deriving readiness.
  readonly terminalStatus: FileReadStatusRecord['terminalStatus'] | null;
}

export type CoverageStatus = 'complete' | 'complete_with_gaps' | 'in_progress' | 'failed';

export interface ExtractionCoverage {
  readonly totalPages: number;
  readonly extractedPages: number;
  // 0–100, rounded. 100 ONLY when extractedPages === totalPages AND no page counts were unknown.
  readonly coveragePct: number;
  readonly gaps: readonly CoverageGap[];
  readonly status: CoverageStatus;
  // HONESTY surface: how many counted files had no pageCount (counted as 1 unit each). > 0 means the
  // page totals are approximate and the UI must say so ("N files, page counts unavailable").
  readonly unknownPageFiles: number;
  readonly totalFiles: number;
}

// Image content-type / extension recognition for the "request AI description" affordance.
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|tiff?|heic|bmp)$/i;
function isImageDoc(doc: CoverageDocInput): boolean {
  if (typeof doc.contentType === 'string' && doc.contentType.toLowerCase().startsWith('image/')) return true;
  return IMAGE_EXT.test(doc.s3Key);
}

function displayName(doc: CoverageDocInput): string {
  if (typeof doc.filename === 'string' && doc.filename.trim().length > 0) return doc.filename;
  return originalFileName(doc.s3Key);
}

// A Document contributes `pageCount` pages when known, else 1 UNIT (honest: we don't fabricate a total).
function pageUnits(doc: CoverageDocInput): number {
  return typeof doc.pageCount === 'number' && doc.pageCount > 0 ? doc.pageCount : 1;
}

// Human page-label for a whole-file gap. "12 pages" when known (>1), "whole file" when 1/unknown.
function wholeFileLabel(doc: CoverageDocInput): string {
  const n = typeof doc.pageCount === 'number' && doc.pageCount > 0 ? doc.pageCount : null;
  return n !== null && n > 1 ? `${n} pages` : 'whole file';
}

// Map a blocking file's terminalStatus → a coverage gap reason. An image whose read failed is
// surfaced as 'unreadable_image' (the can-describe path); everything else is unread / needs-summary.
function fileGapReason(doc: CoverageDocInput, terminalStatus: FileReadStatusRecord['terminalStatus']): CoverageGapReason {
  if (isImageDoc(doc)) return 'unreadable_image';
  if (terminalStatus === 'manual_summary_required') return 'needs_manual_summary';
  return 'unread';
}

/**
 * Assemble the coverage report. PURE — no DB, no IO; the route loads rows and passes them in.
 *
 * Algorithm:
 *   1. Universe = Documents that are chart INPUTS (drop screening-summary + _rendered outputs).
 *   2. For each input doc, look up its readiness row by filePath === s3Key. A file that is
 *      effectively-read (isEffectivelyRead — incl. 'read', a valid manual summary, the retroactive
 *      heal, AND 'auto_skipped') contributes ALL its pages as EXTRACTED. A file that is NOT
 *      effectively-read (manual_summary_required / failed) contributes its pages to GAPS (whole-file)
 *      with the right reason. A doc with NO readiness row yet is still being OCR'd → counts as
 *      in-progress, NOT a gap (it would be alarming + wrong to call a file "not extracted" mid-OCR).
 *   3. Run-level EXTRACTION gaps from the latest run's resultJson.gaps:
 *        uncoveredPages  → an 'extraction_gap' gap (pages OCR'd but not folded into the chart),
 *        truncatedWindows → a 'truncated_dense' gap.
 *      These are SEPARATE from per-file page accounting (a file can be fully read yet have some pages
 *      the chunker didn't fold in). They are surfaced as their own rows and subtracted from
 *      extractedPages (clamped >= 0) so the headline reflects them honestly.
 *   4. status: 'failed' if the run failed; 'in_progress' if any input doc has no terminal read row;
 *      'complete_with_gaps' if there are any gaps OR unknown page counts; else 'complete'.
 */
export function computeExtractionCoverage(
  docs: readonly CoverageDocInput[],
  fileReadStatuses: readonly FileReadStatusRecord[],
  latestRun: Pick<ExtractionRunRef, 'status'> & { resultJson?: unknown } | null,
): ExtractionCoverage {
  const inputs = docs.filter((d) => isChartInputKey(d.s3Key));
  const statusByPath = new Map(fileReadStatuses.map((r) => [r.filePath, r] as const));

  let totalPages = 0;
  let extractedPages = 0;
  let unknownPageFiles = 0;
  let inProgress = false;
  const gaps: CoverageGap[] = [];

  for (const doc of inputs) {
    const units = pageUnits(doc);
    totalPages += units;
    if (typeof doc.pageCount !== 'number' || doc.pageCount <= 0) unknownPageFiles += 1;

    const row = statusByPath.get(doc.s3Key);
    if (row === undefined) {
      // No readiness row yet → the file is still in the OCR pipeline. Not extracted, but NOT a gap:
      // it's in progress. Its pages are neither extracted nor gapped (they resolve on the next poll).
      inProgress = true;
      continue;
    }
    if (isEffectivelyRead(row)) {
      extractedPages += units;
      continue;
    }
    // Not effectively read → a whole-file gap (we can't know which specific pages failed; OCR failed
    // the file as a unit). Reason is image-aware so the UI can offer "Request AI description".
    gaps.push({
      documentId: doc.id,
      fileName: displayName(doc),
      reason: fileGapReason(doc, row.terminalStatus),
      pageLabel: wholeFileLabel(doc),
      isImage: isImageDoc(doc),
      terminalStatus: row.terminalStatus,
    });
  }

  // Run-level EXTRACTION gaps (separate plane from per-file OCR). Only meaningful once a run exists.
  const rj = (latestRun?.resultJson ?? null) as { gaps?: { uncoveredPages?: unknown; truncatedWindows?: unknown } } | null;
  const uncoveredPages = toNonNegInt(rj?.gaps?.uncoveredPages);
  const truncatedWindows = toNonNegInt(rj?.gaps?.truncatedWindows);

  if (uncoveredPages > 0) {
    gaps.push({
      documentId: null,
      fileName: 'Chart extraction',
      reason: 'extraction_gap',
      pageLabel: uncoveredPages === 1 ? '1 page' : `${uncoveredPages} pages`,
      isImage: false,
      terminalStatus: null,
    });
    // These pages were OCR'd (so counted in totalPages via their file) but not folded into the chart —
    // subtract them from extracted so the headline is honest. Clamp at 0.
    extractedPages = Math.max(0, extractedPages - uncoveredPages);
  }
  if (truncatedWindows > 0) {
    gaps.push({
      documentId: null,
      fileName: 'Chart extraction',
      reason: 'truncated_dense',
      pageLabel: truncatedWindows === 1 ? '1 dense section' : `${truncatedWindows} dense sections`,
      isImage: false,
      terminalStatus: null,
    });
  }

  // coveragePct: honest. 100 ONLY when every page is extracted AND no page counts were unknown.
  let coveragePct: number;
  if (totalPages === 0) {
    coveragePct = 100; // no chart inputs yet — vacuously complete (nothing to extract)
  } else {
    const raw = (extractedPages / totalPages) * 100;
    const rounded = Math.round(raw);
    // Never round UP to 100 when there's a real shortfall or unknown counts (don't fake completeness).
    coveragePct = (extractedPages < totalPages || unknownPageFiles > 0) ? Math.min(rounded, 99) : rounded;
    // ...but if the only reason for <100 is unknown page counts on otherwise-read files and the raw is
    // exactly 100 (all read), cap at 99 above already conveys "approximate". Leave as-is.
  }

  const runFailed = latestRun?.status === 'failed';
  const status: CoverageStatus = runFailed
    ? 'failed'
    : inProgress
      ? 'in_progress'
      : gaps.length > 0 || unknownPageFiles > 0
        ? 'complete_with_gaps'
        : 'complete';

  return {
    totalPages,
    extractedPages,
    coveragePct,
    gaps,
    status,
    unknownPageFiles,
    totalFiles: inputs.length,
  };
}

function toNonNegInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
