import type {
  DoctorPackManifestEntry,
  DoctorPackState,
  FileReadStatusRecord,
  KeyDocPageRange,
  KeyDocRecord,
} from './db-types.js';
import { classifyFile, CLASSIFIER_VERSION, type ClassificationResult } from './key-docs-classifier.js';
import { isEffectivelyRead } from './chart-readiness.js';

/**
 * Phase 7B: Doctor Pack manifest assembly.
 *
 * Per FRN's `app/services/doctorPack.js` (commit 2026-05-24 era), the Doctor Pack is the
 * single consolidated PDF the physician reviews before drafting. We assemble it from the
 * ORIGINAL PDF pages — not text re-rendered — because the physician wants to see what each
 * document actually looks like (Task #105 settled this).
 *
 * This module does two pure jobs:
 *   1. Decide which files belong in the pack (`selectKeyDocs`).
 *   2. Compute the page-range manifest for each selected file (`buildManifest`).
 *
 * The actual PDF concatenation (pdf-lib calls, S3 read/write) is the WORKER'S job, not this
 * service. Mirrors the same pattern as the OCR HARD-STOP layer: gate + manifest in-process,
 * heavy lifting in a Lambda worker that POSTs results back.
 */

export const DOCTOR_PACK_ENGINE_VERSION = 'doctor-pack-1.0.0';

// Inclusion threshold for `normal` classification — high_signal always in, bulk always
// excluded unless cited (cited-bulk inclusion is a future hook; not yet wired).
const NORMAL_INCLUSION_THRESHOLD = 50;

// Maximum page count a single file can contribute to the pack before being capped.
const MAX_PAGES_PER_FILE = 80;

// HARD compression threshold ONLY (Chunk D re-key 2026-06-11): past this the worker may
// compress / page-image-downsample. This is NOT the curation target - that's PACK_PAGE_BUDGET.
export const PACK_PAGE_TARGET = 250;

// Chunk D: Ryan's curation budget - the pack targets 10-15pp, hard-trims at 20. After per-doc
// page selection, applyPackPageBudget() deterministically rank-trims the manifest down to this.
export const PACK_PAGE_BUDGET = 20;

// Never trim the SC-decision documents first - they are the core of the pack (Ryan's rule 1).
const BUDGET_PROTECTED_DOC_TYPES: ReadonlySet<KeyDocRecord['docType']> = new Set([
  'rating_decision',
  'denial_letter',
  'supplemental_decision',
]);

export interface SelectKeyDocsInput {
  // `cls` (Chunk D): pre-computed content-aware classification from the route (docTag override >
  // content text > filename). Absent -> legacy filename-only classifyFile fallback.
  readonly classifiedFiles: readonly { filePath: string; fileSha256: string; pageCount: number | null; cls?: ClassificationResult }[];
  readonly readStatusByPath: ReadonlyMap<string, FileReadStatusRecord>;
}

export interface SelectedKeyDoc {
  readonly filePath: string;
  readonly fileSha256: string;
  readonly classification: KeyDocRecord['classification'];
  readonly docType: KeyDocRecord['docType'];
  readonly importance: number;
  readonly pageRanges: readonly KeyDocPageRange[];
}

/**
 * Decide which files to include in the Doctor Pack + compute the page ranges for each.
 *
 * Inclusion contract:
 *   - classification === 'high_signal' -> ALWAYS included, ALL pages (FRN HARD RULE: every
 *     inch of past denial letters / DBQs / C&P exams referenced in entirety).
 *   - classification === 'normal' AND importance >= 50 -> included, capped at 80 pages.
 *   - classification === 'bulk' -> excluded (future: include cited page ranges only).
 *
 * Read-status guard (Package 7 H-tail, 2026-06-11): inclusion goes through the SHARED
 * isEffectivelyRead predicate (chart-readiness.ts, Package 1) — the same evaluator every other
 * consumer (drafter gate, sign-off, viability, RN queue) derives readiness from. Consequences:
 *   - A retro-healed row (classified 'manual_summary_required' under the old 40-word threshold
 *     but whose stored last attempt passes CURRENT thresholds) is INCLUDED — the prior raw
 *     `terminalStatus === 'manual_summary_required'` check silently omitted it from packs.
 *   - A 'manual_summary_provided' row with a missing/short (< 40 char) summary is EXCLUDED
 *     (defense-in-depth, matching the gate) — the raw check used to let it through.
 * Files with NO read-status row are still included (unchanged: the guard only ever excluded
 * rows it could see). The chart-readiness gate refuses pack generation upstream; this is
 * defense-in-depth if an unread row leaks through.
 */
export function selectKeyDocs(input: SelectKeyDocsInput): readonly SelectedKeyDoc[] {
  const selected: SelectedKeyDoc[] = [];
  for (const file of input.classifiedFiles) {
    const cls = file.cls ?? classifyFile(file.filePath);

    if (cls.classification === 'bulk') continue;
    if (cls.classification === 'normal' && cls.importance < NORMAL_INCLUSION_THRESHOLD) continue;

    const readStatus = input.readStatusByPath.get(file.filePath);
    if (readStatus !== undefined && !isEffectivelyRead(readStatus)) {
      continue;
    }

    const pageCount = file.pageCount ?? 0;
    const includePages = cls.classification === 'high_signal'
      ? pageCount
      : Math.min(pageCount, MAX_PAGES_PER_FILE);

    const pageRanges: readonly KeyDocPageRange[] = includePages > 0
      ? [{ from: 1, to: includePages }]
      : [];

    selected.push({
      filePath: file.filePath,
      fileSha256: file.fileSha256,
      classification: cls.classification,
      docType: cls.docType,
      importance: cls.importance,
      pageRanges,
    });
  }

  return selected.sort((a, b) => {
    if (a.classification !== b.classification) {
      return a.classification === 'high_signal' ? -1 : 1;
    }
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.filePath.localeCompare(b.filePath);
  });
}

export interface DoctorPackManifest {
  readonly entries: readonly DoctorPackManifestEntry[];
  readonly totalPageCount: number;
  readonly keyDocCount: number;
  readonly engineVersion: string;
  readonly aboveTarget: boolean;
}

/**
 * Build the manifest the worker will use to assemble the PDF. Each entry names a source file,
 * its doc_type label, and the exact page ranges to extract.
 */
export function buildManifest(selected: readonly SelectedKeyDoc[]): DoctorPackManifest {
  const entries: DoctorPackManifestEntry[] = selected.map((doc) => ({
    filePath: doc.filePath,
    docType: doc.docType,
    classification: doc.classification,
    pageRanges: doc.pageRanges,
    pageCount: doc.pageRanges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0),
  }));
  const totalPageCount = entries.reduce((sum, e) => sum + e.pageCount, 0);
  return {
    entries,
    totalPageCount,
    keyDocCount: entries.length,
    engineVersion: DOCTOR_PACK_ENGINE_VERSION,
    aboveTarget: totalPageCount > PACK_PAGE_TARGET,
  };
}

/**
 * Composite helper: classify + select + build, used by the route to populate the DoctorPack
 * row on POST /generate. Returns null when there are no eligible files (RN attention needed).
 */
export interface AssembleDoctorPackInput {
  readonly classifiedFiles: readonly { filePath: string; fileSha256: string; pageCount: number | null; cls?: ClassificationResult }[];
  readonly readStatuses: readonly FileReadStatusRecord[];
}

export function assembleDoctorPackManifest(input: AssembleDoctorPackInput): DoctorPackManifest {
  const readStatusByPath = new Map<string, FileReadStatusRecord>();
  for (const r of input.readStatuses) readStatusByPath.set(r.filePath, r);
  const selected = selectKeyDocs({ classifiedFiles: input.classifiedFiles, readStatusByPath });
  return buildManifest(selected);
}

// ====================== Chunk D (2026-06-11): pack page budget ======================

export interface BudgetEntry extends DoctorPackManifestEntry {
  // Importance from the classification - the trim rank's second key. The manifest entry itself
  // doesn't persist it; the route supplies it from the per-file classification.
  readonly importance: number;
}

export interface PackBudgetResult {
  readonly entries: readonly BudgetEntry[];
  readonly trimmed: boolean;
  readonly preTrimPageCount: number;
  readonly postTrimPageCount: number;
  // Human-readable notes, one per affected file ("kept 4 of 12 pages" / "dropped (6 pages)").
  readonly trimNotes: readonly string[];
  // filePaths whose page set was reduced or dropped - the route flags these needsRnReview.
  readonly trimmedFilePaths: readonly string[];
}

// Prefix-take: the first `quota` pages of a doc's ranges, preserving page order within the doc.
function takeFirstPages(ranges: readonly KeyDocPageRange[], quota: number): readonly KeyDocPageRange[] {
  const out: KeyDocPageRange[] = [];
  let remaining = quota;
  for (const r of ranges) {
    if (remaining <= 0) break;
    const len = Math.max(0, r.to - r.from + 1);
    const take = Math.min(len, remaining);
    if (take > 0) {
      out.push({ from: r.from, to: r.from + take - 1 });
      remaining -= take;
    }
  }
  return out;
}

/**
 * Deterministic pack-level page-budget trim (Ryan: pack targets 10-15pp, max ~20).
 *
 * Trim PRIORITY (who keeps pages first) - strictly ordered, no randomness:
 *   1. SC-decision docs (rating_decision / denial_letter / supplemental_decision) - NEVER
 *      trimmed first; they're the core of the pack.
 *   2. classification tier: high_signal > normal > bulk.
 *   3. importance descending.
 *   4. filePath ascending (stable tie-break).
 * Within a doc, pages are kept in page order (prefix of the selected ranges - the selector
 * orders decision/impression pages first in practice because they ARE the early pages).
 *
 * Docs allocated ZERO pages are REMOVED from the manifest entirely: the assembler contract
 * (workers/doctor-pack-assembler/handler.py H2) treats empty pageRanges as "include the WHOLE
 * source PDF" - leaving an empty-ranged entry behind would un-trim it.
 *
 * EXCEPTION - whole-doc passthrough: an entry that ARRIVES with empty pageRanges is the legacy
 * whole-doc shape (no per-page OCR + null Document.pageCount -> selector couldn't refine). Its
 * pageCount is 0 here, so the budget math can't see its real size; letting the take===0 branch
 * drop it would silently lose an entire (possibly high-signal) document from an over-budget
 * pack. Those entries bypass the budget untrimmed (architect QA IMPORTANT-1, 2026-06-11).
 *
 * Output preserves the caller's original entry order for the kept docs (the pack's reading
 * order); only the allocation uses the rank.
 */
export function applyPackPageBudget(
  entries: readonly BudgetEntry[],
  budget: number = PACK_PAGE_BUDGET,
): PackBudgetResult {
  const preTrimPageCount = entries.reduce((sum, e) => sum + e.pageCount, 0);
  if (preTrimPageCount <= budget) {
    return { entries, trimmed: false, preTrimPageCount, postTrimPageCount: preTrimPageCount, trimNotes: [], trimmedFilePaths: [] };
  }

  const tierOrder: Record<BudgetEntry['classification'], number> = { high_signal: 0, normal: 1, bulk: 2 };
  // Whole-doc passthroughs (incoming empty ranges) never enter the allocation loop - see doc
  // comment above. They are re-emitted as-is in the kept loop below.
  const trimmable = entries.filter((e) => e.pageRanges.length > 0);
  const ranked = [...trimmable].sort((a, b) => {
    const aProtected = BUDGET_PROTECTED_DOC_TYPES.has(a.docType) ? 0 : 1;
    const bProtected = BUDGET_PROTECTED_DOC_TYPES.has(b.docType) ? 0 : 1;
    if (aProtected !== bProtected) return aProtected - bProtected;
    if (tierOrder[a.classification] !== tierOrder[b.classification]) return tierOrder[a.classification] - tierOrder[b.classification];
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.filePath.localeCompare(b.filePath);
  });

  const keptRangesByPath = new Map<string, readonly KeyDocPageRange[]>();
  const trimNotes: string[] = [];
  const trimmedFilePaths: string[] = [];
  let remaining = budget;
  for (const entry of ranked) {
    const take = Math.min(entry.pageCount, remaining);
    remaining -= take;
    if (take === entry.pageCount) {
      keptRangesByPath.set(entry.filePath, entry.pageRanges);
    } else if (take > 0) {
      keptRangesByPath.set(entry.filePath, takeFirstPages(entry.pageRanges, take));
      trimNotes.push(`${entry.filePath}: kept ${take} of ${entry.pageCount} selected pages (budget trim)`);
      trimmedFilePaths.push(entry.filePath);
    } else {
      trimNotes.push(`${entry.filePath}: dropped (${entry.pageCount} selected pages over budget)`);
      trimmedFilePaths.push(entry.filePath);
    }
  }

  const kept: BudgetEntry[] = [];
  for (const entry of entries) {
    if (entry.pageRanges.length === 0) {
      // Whole-doc passthrough: survives the budget untrimmed (assembler ships the whole PDF).
      kept.push(entry);
      trimNotes.push(`${entry.filePath}: whole-doc passthrough (no per-page selection) - not counted against the budget`);
      continue;
    }
    const ranges = keptRangesByPath.get(entry.filePath);
    if (ranges === undefined) continue; // dropped entirely
    const pageCount = ranges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0);
    kept.push({ ...entry, pageRanges: ranges, pageCount });
  }
  const postTrimPageCount = kept.reduce((sum, e) => sum + e.pageCount, 0);
  return { entries: kept, trimmed: true, preTrimPageCount, postTrimPageCount, trimNotes, trimmedFilePaths };
}

export type { DoctorPackState };
export { CLASSIFIER_VERSION };
