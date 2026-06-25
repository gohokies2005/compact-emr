import { isScreeningSummaryKey, type ExtractionRunRef } from './chart-build-state.js';
import { isEffectivelyRead, originalFileName } from './chart-readiness.js';
import type { AppDb, FileReadStatusRecord } from './db-types.js';

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
  | 'extraction_gap' // pages OCR'd but left uncovered by the extraction run (gaps.uncoveredPages)
  | 'extraction_incomplete'; // the most-recent extraction run failed / is still queued/running — the
  // chart analysis did NOT finish, so the structured chart (and any verdict built on it) is unreliable
  // even though OCR ("pages read") is 100%. The honesty fix for the false "100% Complete" card.

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

// ===== TWO-STAGE honesty model (Ryan 2026-06-23) =====
// A chart goes through TWO separate phases, and the old card reported ONE "100% Complete" number that
// CONFLATED them — so a chart whose pages were all OCR'd but whose SEMANTIC analysis never finished read as
// "100% Complete", hiding a failed analysis the SOAP/verdict was then built on. We now report the two phases
// as two clearly-labeled, plain-English stages, BOTH derived from this one coverage object (single source of
// truth) so the card lines and the SOAP banner can never disagree:
//   • Stage 1 — Pages read (OCR): the raw text-capture phase. "Pages read: 100% (28 of 28)".
//   • Stage 2 — Chart analysis: the semantic extraction that builds the structured chart the SOAP is based on.
//     state ∈ complete / in_progress / incomplete / failed, with a plain label + a plain reason when not
//     complete, the likely-cause file when nameable, and a findings count when known.

/** Stage 1 — the OCR text-capture phase, in plain English. */
export interface PagesReadStage {
  readonly pct: number; // 0–100, the SAME number coveragePct carried (pages effectively read / total)
  readonly readUnits: number; // pages (or file-units) read
  readonly totalUnits: number; // total pages (or file-units)
  readonly approximate: boolean; // some files had no page count → "(N files, page counts unavailable)"
  readonly label: string; // "100% (28 of 28)" / "92% (118 of 128)" / "28 files, page counts unavailable"
}

// 'not_analyzed' (Ryan 2026-06-23, cry-wolf fix): NO analysis run exists yet (runStatus === null) OR there
// are no chart inputs to analyze. This is NOT a failure or a gap — it must NOT fire the SOAP banner, mark the
// verdict provisional, or name a likely-cause file. Only queued/running (a real run exists but is unfinished),
// failed, or a completed-run-with-real-gaps (→ 'incomplete') trip the honesty warning.
export type ChartAnalysisState = 'complete' | 'in_progress' | 'incomplete' | 'failed' | 'not_analyzed';

/** Stage 2 — the semantic extraction (the structured chart the SOAP/verdict is built on), in plain English. */
export interface ChartAnalysisStage {
  readonly state: ChartAnalysisState;
  readonly label: string; // "✓ Complete (253 findings)" / "⚠ Didn't finish — retry" / "Analyzing…" / "✗ Failed — re-run"
  readonly reason: string | null; // plain reason when not complete (null when complete; a CAUTION when minorGap)
  readonly likelyCauseFile: string | null; // the largest/densest records file, when nameable
  readonly findings: number | null; // count of structured findings extracted, when known
  // NEAR-COMPLETE TOLERANCE (Ryan 2026-06-24, Fitton CLM-4EC87FD0C4): true when a COMPLETED run left a SMALL
  // run-level shortfall (a few uncovered/truncated pages) but analyzed ≥ ANALYSIS_COVERAGE_FLOOR% of the chart.
  // The state is then 'complete' (the verdict proceeds + the red provisional banner does NOT fire) but `reason`
  // carries a CAUTION and this flag is set so the UI/verdict can surface a SOFT caution instead. On a 3029-page
  // chart, 16 pages not folded in must NOT block the SOAP — it's a caution, not a halt. Below the floor stays
  // 'incomplete' (provisional). A whole MISSING FILE is a separate, more serious gap and is NOT softened here.
  readonly minorGap: boolean;
}

// A completed run that analyzed at least this % of the chart is "good enough to proceed, with a caution"
// (Ryan 2026-06-24): the SOAP generates + the verdict is not forced provisional, but a soft caution is shown.
// Below it, a completed-run-with-gaps stays 'incomplete' (provisional). coveragePct already subtracts the
// uncovered pages, so it IS the analyzed-coverage fraction.
export const ANALYSIS_COVERAGE_FLOOR = 90;
// SIZE-AWARE floor (clinical-safety QA 2026-06-24). The flat 90% is scale-blind: 90% of a 3029-page chart is
// 16 unfolded pages (a caution — Fitton), but 90% of a 30-page chart is 3 missing pages, and on a tiny chart
// those few pages are far likelier to BE the rating decision / STR event the opinion hinges on. So on a SMALL
// chart we require near-complete before softening; large charts keep Ryan's 90%. Honors "90%+ is OK" where he
// meant it (Fitton-class charts) while protecting the small-chart edge he deferred ("if even lower IDK, rare").
export const SMALL_CHART_PAGES = 50; // at/under this many pages, each page is more load-bearing
export const SMALL_CHART_COVERAGE_FLOOR = 95;

// ===== Per-page provenance layer (vision rebuild 2026-06-16) =====
// SEPARATE from the file-level accounting above (which counts a file as read via the SHARED
// isEffectivelyRead predicate — untouched, four gates depend on it). This layer reads the per-page
// provenance the vision path stamps (document_pages.extraction_coverage / handwriting_present) so the
// RN can see, per page, what was captured cleanly vs read with low confidence vs couldn't be read —
// the honest answer the false-"100%" couldn't give. Pages with NO signal (Textract/native/legacy,
// coverage=null) are NOT counted here; they keep the file-level accounting. Advisory; blocks nothing.

export interface PageProvenanceInput {
  readonly documentId: string;
  readonly pageNumber: number;
  readonly extractionCoverage: string | null; // 'full' | 'partial' | 'illegible' | 'blank' | null
  readonly handwritingPresent: boolean | null;
}

export interface PageReviewRef {
  readonly documentId: string;
  readonly fileName: string;
  readonly pageNumber: number;
  // 'handwriting_uncertain' = vision read it but flagged faint/illegible regions (content present,
  // confirm it). 'unreadable' = almost nothing could be read (real content likely missing).
  readonly reason: 'handwriting_uncertain' | 'unreadable';
}

export interface PageCoverageBreakdown {
  readonly pagesWithSignal: number; // pages carrying a per-page vision signal (the denominator here)
  readonly clean: number; // coverage 'full' — captured with confidence
  readonly handwritingUncertain: number; // coverage 'partial' — content present, low-confidence regions
  readonly blank: number; // coverage 'blank' — verified empty (silent; not a gap to chase)
  readonly unreadable: number; // coverage 'illegible' — almost nothing read (needs a look)
  // The pages a human should glance at, in document order, capped (UI list). Blanks are NEVER here.
  readonly reviewPages: readonly PageReviewRef[];
}

// ===== RELEVANCE-AWARE coverage framing (Dr. Kasky, case #76, 2026-06-25) =====
// THE PROBLEM: a bare "38% of pages extracted" scares an RN off a case that is actually fine — the pages
// that MATTER to the claim (the rating decisions, the STRs, the nexus evidence) may ALL have been read, and
// the unread remainder is duplicates / unrelated / illegible bulk. The scary number conflates "we skipped
// irrelevant pages" (fine) with "we missed relevant pages" (act). This layer reframes coverage by RELEVANCE,
// using ONLY classification that ALREADY exists — the Doctor-Pack KeyDoc rows (caseId+filePath → docType +
// classification + importance). It invents NO new relevance model.
//
// HONESTY (Ryan HARD RULE — coverage must NEVER overstate): the reframe must NOT hide a real gap. A whole
// KEY document (high_signal: rating decision / STR / DBQ / C&P / nexus / etc.) that was NOT read is surfaced
// PROMINENTLY as a gap that matters. Only bulk (Blue Button)/normal/unclassified unread docs are framed as
// "safely skipped". Reassurance is EARNED — it is shown only when every key doc was actually read.
//
// FAIL-OPEN: when there is no KeyDoc classification for the case (relevance data absent), this returns null
// and the UI falls back to the honest raw %/stage lines exactly as before. Never crash, never invent.

// KeyDoc classification tier — the existing Doctor-Pack signal tier. Mirrors KeyDocClassification in
// db-types.ts (kept as a local minimal shape so this pure module has no DB dependency).
export type RelevanceClassification = 'high_signal' | 'bulk' | 'normal';

// The minimal per-document classification this layer needs, keyed by the document's s3Key (== KeyDoc.filePath).
export interface KeyDocClassInput {
  readonly filePath: string; // == Document.s3Key
  readonly docType: string; // KeyDocType (free VarChar in the DB; we only display/group it)
  readonly classification: RelevanceClassification;
  readonly importance: number; // 0–100
}

// One read/unread document in the relevance summary, carrying its classification so the UI can group it.
export interface RelevanceDocRef {
  readonly documentId: string | null; // null only for run-level entries (never used here — docs only)
  readonly fileName: string;
  readonly docType: string | null; // KeyDocType when classified, else null (group as "other records")
  readonly classification: RelevanceClassification | null; // null when the doc has no KeyDoc row
  readonly pageLabel: string; // "12 pages" / "whole file"
  readonly key: boolean; // true = a high_signal claim-relevant doc (rating decision / STR / DBQ / nexus …)
}

export interface RelevanceSummary {
  // The KEY (claim-relevant) documents that WERE read — what earns the reassuring framing.
  readonly keyDocsRead: readonly RelevanceDocRef[];
  // KEY documents that were NOT read — the gaps that MATTER. Non-empty → the UI flags PROMINENTLY and the
  // reassurance is withheld. This is the honesty core: a missed key doc is never softened away.
  readonly keyDocGaps: readonly RelevanceDocRef[];
  // Unread documents that are NOT claim-key (bulk Blue Button / normal / unclassified) — safely skippable.
  // Surfaced quietly ("N pages of duplicate/unrelated records were not extracted — usually fine").
  readonly skippableGaps: readonly RelevanceDocRef[];
  // true when at least one KEY doc was read AND no KEY doc was missed → the reframe may reassure. When a key
  // doc IS missed this is false and the UI leads with the warning, never the reassurance.
  readonly allKeyDocsRead: boolean;
  // Page totals for the read KEY docs (the "we read the N pages that matter" number). Honest: unknown counts
  // contribute 0 here (and `keyPagesApproximate` is set) rather than inflating the figure.
  readonly keyPagesRead: number;
  readonly keyPagesApproximate: boolean;
}

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
  // Per-page vision breakdown. null when NO page carries a vision signal (pure Textract/native/legacy
  // case) — the UI then shows only the file-level numbers, exactly as before the vision rebuild.
  readonly pageBreakdown: PageCoverageBreakdown | null;
  // TWO-STAGE honesty model (Ryan 2026-06-23). Both derived from the SAME fields above so they can never
  // disagree with coveragePct/status or with each other. The card renders these two lines; the SOAP banner
  // reads chartAnalysis.state. pagesRead is the OCR phase; chartAnalysis is the semantic-extract phase.
  readonly pagesRead: PagesReadStage;
  readonly chartAnalysis: ChartAnalysisStage;
  // RELEVANCE-AWARE framing (Dr. Kasky #76). null when no KeyDoc classification exists for the case
  // (fail-open → the UI shows the honest raw %). When present, the card LEADS with this relevance read and
  // demotes the raw % to a secondary line — UNLESS a key doc was missed, in which case the gap is prominent.
  readonly relevance: RelevanceSummary | null;
}

const REVIEW_PAGES_CAP = 200; // never enumerate more than this in the UI list (a 2000-page chart)

/**
 * Build the per-page breakdown from document_pages provenance. Returns null when no page has a vision
 * signal (so the response's pageBreakdown stays null and the UI is unchanged for non-vision charts).
 * PURE. Counts only pages belonging to chart-INPUT documents (drops screening-summary/_rendered).
 */
export function computePageCoverageBreakdown(
  docs: readonly CoverageDocInput[],
  pages: readonly PageProvenanceInput[],
): PageCoverageBreakdown | null {
  const inputs = docs.filter((d) => isChartInputKey(d.s3Key));
  const nameById = new Map(inputs.map((d) => [d.id, displayName(d)] as const));
  // only pages of chart-input docs that actually carry a per-page signal
  const signal = pages.filter((p) => nameById.has(p.documentId) && p.extractionCoverage !== null);
  if (signal.length === 0) return null;

  let clean = 0;
  let handwritingUncertain = 0;
  let blank = 0;
  let unreadable = 0;
  const reviewPages: PageReviewRef[] = [];
  // stable document order then page order, so the review list reads top-to-bottom like the chart
  const ordered = [...signal].sort((a, b) =>
    a.documentId === b.documentId ? a.pageNumber - b.pageNumber : a.documentId < b.documentId ? -1 : 1,
  );
  for (const p of ordered) {
    switch (p.extractionCoverage) {
      case 'full':
        clean += 1;
        break;
      case 'blank':
        blank += 1;
        break;
      case 'illegible':
        unreadable += 1;
        if (reviewPages.length < REVIEW_PAGES_CAP) {
          reviewPages.push({ documentId: p.documentId, fileName: nameById.get(p.documentId) ?? 'Document', pageNumber: p.pageNumber, reason: 'unreadable' });
        }
        break;
      case 'partial':
        handwritingUncertain += 1;
        if (reviewPages.length < REVIEW_PAGES_CAP) {
          reviewPages.push({ documentId: p.documentId, fileName: nameById.get(p.documentId) ?? 'Document', pageNumber: p.pageNumber, reason: 'handwriting_uncertain' });
        }
        break;
      default:
        break; // unknown value — already filtered to the 4 enums upstream, but be defensive
    }
  }
  return { pagesWithSignal: signal.length, clean, handwritingUncertain, blank, unreadable, reviewPages };
}

// ===== Relevance-aware framing (Dr. Kasky #76) =====

// A high_signal KeyDoc IS the claim-relevant evidence (rating decisions, STRs, DBQs, C&P exams, nexus
// letters, sleep studies, audiograms, etc. — see key-docs-classifier.ts PATTERNS). A bulk doc is a giant
// Blue Button / full-records dump (skimmable, rarely load-bearing in full); normal is everything else.
// "key" for the honesty gap = high_signal ONLY: a missed high_signal doc is a gap that MATTERS and must be
// surfaced prominently. bulk/normal/unclassified unread is framed as safely skippable. We deliberately do
// NOT invent a new relevance model — we read the existing Doctor-Pack tier.
function isKeyClassification(c: RelevanceClassification): boolean {
  return c === 'high_signal';
}

// Map a KeyDocType to a short human group label for the read/unread lists ("rating decisions", "service
// treatment records", "the nexus evidence", …). Unknown/unmapped types fall back to a generic "records".
// Pure display; never changes the gap logic.
const DOC_TYPE_LABEL: Record<string, string> = {
  rating_decision: 'rating decision',
  denial_letter: 'denial letter',
  supplemental_decision: 'supplemental decision',
  rated_disabilities_view: 'rated-disabilities list',
  benefit_summary: 'benefit summary',
  sc_conditions_list: 'service-connected conditions list',
  dbq: 'DBQ',
  c_and_p_exam: 'C&P exam',
  tera_memo: 'TERA memo',
  individual_exposure_summary: 'exposure summary',
  nexus_letter_prior: 'prior nexus letter',
  medical_opinion: 'medical opinion',
  audiogram: 'audiogram',
  sleep_study: 'sleep study',
  pulmonary_function_test: 'pulmonary function test',
  service_treatment_record_summary: 'service treatment records',
  separation_exam: 'separation exam',
  entrance_exam: 'entrance exam',
  personnel_record: 'personnel record',
  statement_in_support: 'statement in support',
  lay_statement: 'lay statement',
  buddy_statement: 'buddy statement',
  blue_button: 'health-record export',
  progress_notes: 'progress notes',
  imaging: 'imaging report',
  dd_214: 'DD-214',
  intake_summary: 'intake summary',
};
export function docTypeLabel(docType: string | null): string {
  if (docType === null) return 'records';
  return DOC_TYPE_LABEL[docType] ?? 'records';
}

/**
 * Build the relevance-aware coverage summary from the Doctor-Pack KeyDoc classification that ALREADY exists.
 * PURE — no DB. Returns null (fail-open) when NO chart-input document carries a KeyDoc row, so the UI falls
 * back to the honest raw %. Invents no relevance: a doc is "key" iff its existing classification is high_signal.
 *
 * Reads:
 *   • inputs  — the chart-INPUT docs (already filtered).
 *   • gaps    — the whole-file gaps already computed (documentId-bearing). A key doc that is gapped → keyDocGap.
 *   • classByPath — KeyDoc rows keyed by s3Key (== filePath).
 *   • readDocIds — documentIds with a readiness row indicating the file was PROCESSED/READ (isEffectivelyRead).
 *               A doc is READ iff it is in this set AND not gapped; a doc that is NEITHER read NOR gapped is
 *               still in OCR (no row yet) → in-progress, excluded from BOTH keyDocsRead and keyDocGaps so a
 *               mid-pipeline key doc can never produce a false all-clear. (Omitted by legacy callers → the old
 *               "read iff not gapped" behavior, fail-open.)
 *
 * HONESTY: a high_signal doc that was NOT read lands in keyDocGaps (surfaced prominently). allKeyDocsRead is
 * true ONLY when ≥1 key doc was read AND zero key docs were missed — reassurance is earned, never assumed,
 * and a key doc still mid-pipeline keeps allKeyDocsRead false (it is not yet a read, and never silently one).
 */
export function computeRelevanceSummary(
  inputs: readonly CoverageDocInput[],
  gaps: readonly CoverageGap[],
  classByPath: ReadonlyMap<string, KeyDocClassInput>,
  // documentIds with a readiness row indicating the file was PROCESSED/READ (isEffectivelyRead). A doc
  // that is NEITHER in this set NOR gapped is still in the OCR pipeline (no row yet) — in-progress, which
  // is neither read nor a gap. REQUIRED for `wasRead` to be honest: without it a mid-pipeline key doc was
  // mis-counted as read (false all-clear). Optional ONLY so legacy callers compile; when omitted we fall
  // back to "read iff not gapped" — the prior (looser) behavior — never a crash.
  readDocIds?: ReadonlySet<string>,
): RelevanceSummary | null {
  // Fail-open: no classification data for ANY input doc → no relevance read (UI shows the honest %).
  const anyClassified = inputs.some((d) => classByPath.has(d.s3Key));
  if (!anyClassified) return null;

  // The set of documentIds that are gapped at the FILE level (whole file not read). Run-level gaps
  // (documentId null) are not per-document and don't bear on relevance.
  const gappedDocIds = new Set<string>();
  for (const g of gaps) if (g.documentId !== null) gappedDocIds.add(g.documentId);

  const keyDocsRead: RelevanceDocRef[] = [];
  const keyDocGaps: RelevanceDocRef[] = [];
  const skippableGaps: RelevanceDocRef[] = [];
  let keyPagesRead = 0;
  let keyPagesApproximate = false;
  // Count key docs that are still mid-pipeline (no read row yet, not gapped). They are surfaced in NEITHER
  // list, but they MUST suppress allKeyDocsRead — an all-clear cannot be earned while a key doc is unread
  // because it hasn't finished processing (only when readDocIds is supplied; legacy path has no in-progress).
  let keyDocsInProgress = 0;

  for (const doc of inputs) {
    const cls = classByPath.get(doc.s3Key) ?? null;
    const classification: RelevanceClassification | null = cls?.classification ?? null;
    const docType = cls?.docType ?? null;
    const key = classification !== null && isKeyClassification(classification);
    const gapped = gappedDocIds.has(doc.id);
    // wasRead requires a readiness row that says the file was PROCESSED/READ — not merely "absent from
    // the gaps list". A key doc still in OCR (no row yet) is in-progress: NEITHER read NOR a gap. The old
    // `!gappedDocIds.has(doc.id)` counted that mid-pipeline doc as read, letting allKeyDocsRead report a
    // FALSE all-clear on a partially-processed chart. When readDocIds is supplied (live path), a doc is
    // read iff it has a read row AND is not gapped; when omitted (legacy caller), preserve the old
    // not-gapped behavior. inProgress = neither read nor gapped → excluded from keyDocsRead AND keyDocGaps.
    const wasRead = readDocIds ? (readDocIds.has(doc.id) && !gapped) : !gapped;
    const inProgress = !wasRead && !gapped;
    const ref: RelevanceDocRef = {
      documentId: doc.id,
      fileName: displayName(doc),
      docType,
      classification,
      pageLabel: wholeFileLabel(doc),
      key,
    };

    if (wasRead) {
      if (key) {
        keyDocsRead.push(ref);
        if (typeof doc.pageCount === 'number' && doc.pageCount > 0) keyPagesRead += doc.pageCount;
        else keyPagesApproximate = true; // a read key doc with an unknown count → say "approximate"
      }
      // a read non-key doc needs no surfacing — it's covered and not claim-load-bearing
      continue;
    }
    // In-progress (still mid-pipeline): neither read nor a gap. Exclude from both lists — it would be wrong
    // to call it a gap (it may yet read) or to count it read (it hasn't). It resolves on the next poll. A
    // KEY in-progress doc still suppresses the all-clear below (it is unread, just not yet a gap).
    if (inProgress) {
      if (key) keyDocsInProgress += 1;
      continue;
    }
    // Unread document (has a row, not effectively read). KEY → a gap that MATTERS (prominent). Non-key →
    // safely skippable (quiet).
    if (key) keyDocGaps.push(ref);
    else skippableGaps.push(ref);
  }

  // All-clear is EARNED: ≥1 key doc read, zero key gaps, AND no key doc still mid-pipeline. The last clause
  // is the #76 QA fix — a key doc with no readiness row yet can no longer be silently counted as read.
  const allKeyDocsRead = keyDocsRead.length > 0 && keyDocGaps.length === 0 && keyDocsInProgress === 0;
  return { keyDocsRead, keyDocGaps, skippableGaps, allKeyDocsRead, keyPagesRead, keyPagesApproximate };
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
  // Per-page provenance rows (document_pages). Optional + defaults to [] so every existing caller/test
  // is unchanged and pageBreakdown is null until the vision path stamps pages.
  pages: readonly PageProvenanceInput[] = [],
  // KeyDoc classification rows keyed by s3Key (== KeyDoc.filePath). Optional + defaults to [] so existing
  // callers/tests are unchanged and `relevance` is null (fail-open) until classification exists.
  keyDocClasses: readonly KeyDocClassInput[] = [],
): ExtractionCoverage {
  const inputs = docs.filter((d) => isChartInputKey(d.s3Key));
  const statusByPath = new Map(fileReadStatuses.map((r) => [r.filePath, r] as const));

  let totalPages = 0;
  let extractedPages = 0;
  let unknownPageFiles = 0;
  let inProgress = false;
  const gaps: CoverageGap[] = [];
  // documentIds that actually have a readiness row indicating the file was PROCESSED/READ (the same
  // isEffectivelyRead predicate the headline uses). A doc with NO row yet (still in OCR) is in-progress
  // and is deliberately NOT in this set — so relevance never counts a mid-pipeline doc as read.
  const readDocIds = new Set<string>();

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
      readDocIds.add(doc.id);
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

  // EXTRACTION DID-NOT-FINISH (card-honesty fix 2026-06-23). "Pages read" (OCR) finishing 100% does
  // NOT mean the chart was analyzed: the semantic extraction run is a SEPARATE, slower phase. If the
  // most-recent run failed, or is still queued/running, the structured chart is incomplete/empty and
  // any SOAP/route-picker verdict built on it is unreliable — NEVER render that as a confident
  // "Complete / not supportable". `failed` already routes to status 'failed' below; `queued`/`running`
  // (e.g. the crash re-enqueued the run, or the stuck-run watcher hasn't swept it yet) are the silent
  // case the old code mis-reported as 'complete'. We surface an explicit 'extraction_incomplete' gap
  // and force status off 'complete'. The CALLER (route loader) passes the LATEST run by createdAt, so
  // a newer unfinished run correctly overrides a stale earlier 'complete'.
  const runStatus = latestRun?.status ?? null;
  const extractionUnfinished = runStatus === 'queued' || runStatus === 'running';

  // Run-level EXTRACTION gaps (separate plane from per-file OCR). Only meaningful once a run exists.
  const rj = (latestRun?.resultJson ?? null) as { gaps?: { uncoveredPages?: unknown; truncatedWindows?: unknown }; items?: unknown } | null;
  const uncoveredPages = toNonNegInt(rj?.gaps?.uncoveredPages);
  const truncatedWindows = toNonNegInt(rj?.gaps?.truncatedWindows);
  // Findings count for the "Chart analysis: ✓ Complete (N findings)" label, when the run recorded items.
  const findings = Array.isArray(rj?.items) ? rj.items.length : null;

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
  if (extractionUnfinished) {
    gaps.push({
      documentId: null,
      fileName: 'Chart analysis',
      reason: 'extraction_incomplete',
      pageLabel: runStatus === 'running' ? 'in progress' : 'did not finish — retry',
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

  const runFailed = runStatus === 'failed';
  // A still-running extraction reads as in_progress. A queued-but-not-finished latest run (the silent
  // crash/re-enqueue case) is NOT 'complete' — it carries the extraction_incomplete gap and reads as
  // complete_with_gaps so the card says "chart analysis didn't finish — retry", never "Complete".
  const status: CoverageStatus = runFailed
    ? 'failed'
    : runStatus === 'running'
      ? 'in_progress'
      : inProgress
        ? 'in_progress'
        : gaps.length > 0 || unknownPageFiles > 0 || extractionUnfinished
          ? 'complete_with_gaps'
          : 'complete';

  // ── TWO-STAGE honesty model (Ryan 2026-06-23) — derived from the SAME numbers above ────────────────────
  // Stage 1: Pages read (OCR). This is exactly coveragePct + the page counts the headline already used.
  const approximate = unknownPageFiles > 0;
  const pagesReadLabel = (approximate && inputs.length > 0 && totalPages === inputs.length)
    ? `${inputs.length} ${inputs.length === 1 ? 'file' : 'files'}, page counts unavailable`
    : `${coveragePct}% (${extractedPages} of ${totalPages})`;
  const pagesRead: PagesReadStage = {
    pct: coveragePct,
    readUnits: extractedPages,
    totalUnits: totalPages,
    approximate,
    label: pagesReadLabel,
  };

  // Stage 2: Chart analysis (the semantic extract). The likely-cause file is the LARGEST chart-input doc by
  // page count (the dense records file — a Blue Button export is the usual culprit when analysis times out /
  // truncates). Only named when there is a clear large file (> 1 page and it stands out), so we don't point
  // at a random 1-pager. This NEVER re-runs anything; it's a label off existing data.
  const chartAnalysis = deriveChartAnalysisStage({
    runStatus, extractionUnfinished, runFailed, inProgress, uncoveredPages, truncatedWindows, findings, inputs,
    coveragePct, totalPages,
  });

  // SSOT INVARIANT (Ryan 2026-06-23): a 'complete' coverage object must NEVER carry a non-complete chart-analysis
  // state — except 'not_analyzed' (an empty/new case is vacuously 'complete' yet has nothing to analyze). If the two
  // stages ever disagreed, the card line and the SOAP banner would contradict. Defensive guard so a future edit to
  // either branch can't silently re-introduce the false-"100% Complete" the whole two-stage model exists to kill.
  if (status === 'complete' && chartAnalysis.state !== 'complete' && chartAnalysis.state !== 'not_analyzed') {
    throw new Error(`extraction-coverage SSOT invariant violated: status='complete' but chartAnalysis.state='${chartAnalysis.state}'`);
  }

  // RELEVANCE-AWARE framing (Dr. Kasky #76). Built from the existing Doctor-Pack KeyDoc classification +
  // the gaps we already computed. null (fail-open) when no chart-input doc is classified → UI shows raw %.
  const classByPath = new Map<string, KeyDocClassInput>(
    keyDocClasses.filter((k) => inputs.some((d) => d.s3Key === k.filePath)).map((k) => [k.filePath, k] as const),
  );
  const relevance = computeRelevanceSummary(inputs, gaps, classByPath, readDocIds);

  return {
    totalPages,
    extractedPages,
    coveragePct,
    gaps,
    status,
    unknownPageFiles,
    totalFiles: inputs.length,
    pageBreakdown: computePageCoverageBreakdown(docs, pages),
    pagesRead,
    chartAnalysis,
    relevance,
  };
}

/**
 * Derive the plain-English Stage-2 (Chart analysis) label from the run state + extraction gaps. PURE.
 *
 * State machine (honest about the silent-failure case the old single "100% Complete" hid — and the
 * cry-wolf case where a brand-new/empty case mis-read as "didn't finish"):
 *   • no inputs OR runStatus === null → 'not_analyzed' (no run on record yet / nothing to analyze). NOT a
 *                                     failure, NOT a gap — does NOT trip the banner / provisional / cause-file.
 *   • failed                        → 'failed'      "✗ Chart analysis failed — re-run extraction"
 *   • running                       → 'in_progress' (we can't have analyzed pages still being read).
 *   • queued                        → 'incomplete'  the silent crash/re-enqueue case (a real run exists).
 *   • inProgress (OCR still going)  → 'in_progress'.
 *   • complete run with gaps        → 'incomplete'  "⚠ Finished, but some pages weren't fully analyzed"
 *   • complete, no gaps             → 'complete'    "✓ Complete (N findings)".
 *
 * likelyCauseFile is named ONLY for 'failed' / 'incomplete' (a real shortfall to explain) — never for
 * 'not_analyzed' / 'in_progress' / 'complete' (there is nothing to blame yet).
 */
function deriveChartAnalysisStage(args: {
  runStatus: string | null;
  extractionUnfinished: boolean;
  runFailed: boolean;
  inProgress: boolean;
  uncoveredPages: number;
  truncatedWindows: number;
  findings: number | null;
  inputs: readonly CoverageDocInput[];
  coveragePct: number;
  totalPages: number;
}): ChartAnalysisStage {
  const { runStatus, runFailed, inProgress, uncoveredPages, truncatedWindows, findings, inputs, coveragePct, totalPages } = args;
  // The largest chart-input file by page count — the usual culprit when analysis truncates/times out. Named
  // only when it is meaningfully large (>1 page) so we never point at a stray single-pager. Computed once;
  // surfaced ONLY for 'failed' / 'incomplete' (a real shortfall to explain), never for not_analyzed/in_progress.
  const largest = [...inputs]
    .filter((d) => typeof d.pageCount === 'number' && (d.pageCount ?? 0) > 1)
    .sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0))[0];
  const likelyCauseFile = largest ? displayName(largest) : null;
  const findingsSuffix = findings !== null ? ` (${findings} ${findings === 1 ? 'finding' : 'findings'})` : '';

  // NOT-ANALYZED (cry-wolf fix, Ryan 2026-06-23): no chart inputs to analyze, OR no analysis run on record yet
  // (runStatus === null) with OCR settled. This is the brand-new / empty-case resting state — NOT a failure and
  // NOT a gap. It must not fire the banner, mark the verdict provisional, or blame a file. We DON'T treat a null
  // run as "didn't finish": a real run that was interrupted carries a 'queued'/'running'/'failed' status, not null.
  if (inputs.length === 0 || (runStatus === null && !inProgress)) {
    return { state: 'not_analyzed', label: 'Not analyzed yet', reason: null, likelyCauseFile: null, findings: findings ?? null, minorGap: false };
  }

  if (runFailed) {
    return {
      state: 'failed',
      label: '✗ Chart analysis failed — re-run extraction',
      reason: 'The chart analysis errored out, so no structured chart was built.',
      likelyCauseFile,
      findings: findings ?? null,
      minorGap: false,
    };
  }
  if (runStatus === 'running' || runStatus === 'queued' || inProgress) {
    // Genuinely working — OCR, a running analysis, OR a QUEUED run waiting for the worker (Ryan 2026-06-24,
    // "on first chart load… have to reprocess almost every time"). A freshly-enqueued/in-flight run is NOT a
    // failure: labeling 'queued' as "didn't finish — retry" cried wolf on every first open and trained RNs to
    // reprocess needlessly. It reads as "Analyzing…" (in_progress) so the card SELF-HEALS via the coverage poll
    // when the run lands — no manual reprocess. A GENUINELY stuck queued run is swept to 'failed' by the 45-min
    // stuck-run watcher (which then DOES show "re-run"), so this never hides a real crash for long. Never blame a
    // file mid-run. (Provisional-with-text on the SOAP side — the verdict still reads read_chart_first, not a
    // confident conclusion, so the Herman honesty guarantee holds.)
    return { state: 'in_progress', label: 'Analyzing the chart…', reason: 'The chart analysis is still running.', likelyCauseFile: null, findings: findings ?? null, minorGap: false };
  }
  // A completed run that left pages uncovered or truncated dense windows → finished but not fully.
  if (uncoveredPages > 0 || truncatedWindows > 0) {
    const bits: string[] = [];
    if (uncoveredPages > 0) bits.push(`${uncoveredPages} ${uncoveredPages === 1 ? 'page was' : 'pages were'} not folded into the chart`);
    if (truncatedWindows > 0) bits.push(`${truncatedWindows} dense ${truncatedWindows === 1 ? 'section was' : 'sections were'} only partly analyzed`);
    // NEAR-COMPLETE TOLERANCE (Ryan 2026-06-24, Fitton): a COMPLETED run that still analyzed ≥ the floor (e.g. 16
    // of 3029 pages not folded in = 99%) must NOT force the case provisional / block the SOAP. Treat it as
    // 'complete' WITH a caution (minorGap) so the verdict proceeds + the red banner is suppressed, but the soft
    // caution is still surfaced. Below the floor it stays 'incomplete' (provisional), the prior behavior. The
    // floor is SIZE-AWARE (clinical-safety QA): a small chart needs near-complete coverage before we soften,
    // because a few missing pages on a 30-page chart is far likelier to be the load-bearing document.
    const floor = totalPages <= SMALL_CHART_PAGES ? SMALL_CHART_COVERAGE_FLOOR : ANALYSIS_COVERAGE_FLOOR;
    if (coveragePct >= floor && totalPages > 0) {
      const causeClause = likelyCauseFile ? ` The largest records file (${likelyCauseFile}) is the likely source.` : '';
      return {
        state: 'complete',
        label: `✓ Mostly complete${findingsSuffix} — ${coveragePct}% analyzed`,
        reason: `${bits.join(' and ')} (${coveragePct}% of ${totalPages} pages analyzed). The chart is nearly complete.${causeClause} Review the records directly if the claim hinges on a specific document.`,
        likelyCauseFile,
        findings: findings ?? null,
        minorGap: true,
      };
    }
    return {
      state: 'incomplete',
      label: `⚠ Mostly complete${findingsSuffix} — some pages weren’t fully analyzed`,
      reason: `${bits.join(' and ')}. The chart may be missing some records.`,
      likelyCauseFile,
      findings: findings ?? null,
      minorGap: false,
    };
  }
  return { state: 'complete', label: `✓ Complete${findingsSuffix}`, reason: null, likelyCauseFile: null, findings: findings ?? null, minorGap: false };
}

function toNonNegInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * SHARED coverage loader (Ryan 2026-06-22, Zimmelman FIX C — "0% of pages read" though extraction is 100%).
 *
 * THE BUG IT KILLS: the SOAP assembler's deriveCoverageNote loaded the documents + per-page rows but passed
 * `fileReadStatuses=[]` and `latestRun=null` to computeExtractionCoverage. With NO read-status rows, EVERY
 * input doc fell to the "no readiness row → in_progress" branch → extractedPages stayed 0 → coveragePct=0,
 * so the SOAP Objective said "0% of pages read" while the chart chip (GET /extraction-coverage, which loads
 * the real rows) correctly said 100%. Two readers of the SAME report disagreed.
 *
 * THE FIX: ONE loader that assembles the EXACT inputs GET /cases/:id/extraction-coverage passes
 * (chart-readiness.ts) — the same Document select, the same file_read_status rows, the same latest
 * ChartExtractionRun, the same per-page provenance — so the route AND the assembler compute identical
 * coverage and can never drift again. The route handler is now a thin caller of this; the assembler calls it
 * too. Keep this in lockstep with the route's loads (they were copied here verbatim).
 *
 * `chartExtractionRun` is not a typed AppDb delegate (the route casts it), so we cast the same way here.
 * No fail-open swallow inside — the callers own that (the route lets errors bubble to asyncHandler; the
 * assembler wraps it in its own try/catch so a DB hiccup degrades the coverage NOTE to null, never blocks).
 */
export async function loadExtractionCoverageForCase(db: AppDb, caseId: string): Promise<ExtractionCoverage> {
  const docs = (await db.document.findMany({
    where: { caseId },
    select: { id: true, s3Key: true, filename: true, contentType: true, pageCount: true },
  })) as readonly CoverageDocInput[];
  const rows = await db.fileReadStatus.findMany({ where: { caseId } });
  const latestRun = await (db as unknown as {
    chartExtractionRun: { findFirst: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { status: true; resultJson: true } }) => Promise<{ status: string; resultJson: unknown } | null> };
  }).chartExtractionRun.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { status: true, resultJson: true } });
  const pageRows = (await db.documentPage.findMany({
    where: { document: { caseId } },
    select: { documentId: true, pageNumber: true, extractionCoverage: true, handwritingPresent: true },
  })) as unknown as readonly PageProvenanceInput[];
  // KeyDoc classification (Doctor-Pack tier) for the relevance-aware framing (Dr. Kasky #76). Keyed by
  // filePath (== Document.s3Key). When a case has no KeyDoc rows yet, this is [] → relevance is null
  // (fail-open) and the card shows the honest raw %. Existing data; no re-classification here.
  // keyDoc classification is ADVISORY (drives the relevance read only). Fail-open: a missing
  // keyDoc delegate (e.g. older callers / test harnesses) or a query error must NEVER 500 the
  // chart-readiness route — fall back to no relevance summary (the honest % still renders).
  let keyDocRows: readonly KeyDocClassInput[] = [];
  try {
    keyDocRows = (await db.keyDoc?.findMany?.({
      where: { caseId },
      select: { filePath: true, docType: true, classification: true, importance: true },
    })) as unknown as readonly KeyDocClassInput[] ?? [];
  } catch { keyDocRows = []; }
  return computeExtractionCoverage(docs, rows, latestRun, pageRows, keyDocRows);
}
