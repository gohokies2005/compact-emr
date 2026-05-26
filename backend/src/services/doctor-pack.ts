import type {
  DoctorPackManifestEntry,
  DoctorPackState,
  FileReadStatusRecord,
  KeyDocPageRange,
  KeyDocRecord,
} from './db-types.js';
import { classifyFile, CLASSIFIER_VERSION } from './key-docs-classifier.js';

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

// Soft pack-wide page-count target. Going slightly over is fine; this is just a flag the
// worker can use to decide whether to compress / page-image-downsample.
export const PACK_PAGE_TARGET = 250;

export interface SelectKeyDocsInput {
  readonly classifiedFiles: readonly { filePath: string; fileSha256: string; pageCount: number | null }[];
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
 * Read-status guard: only files in `read` or `manual_summary_provided` state can be included.
 * Files in `manual_summary_required` are blockers — the chart-readiness gate will refuse pack
 * generation upstream, but this is defense-in-depth: if a manual_summary_required row leaks
 * through, we still exclude it from the pack rather than silently fall back.
 */
export function selectKeyDocs(input: SelectKeyDocsInput): readonly SelectedKeyDoc[] {
  const selected: SelectedKeyDoc[] = [];
  for (const file of input.classifiedFiles) {
    const cls = classifyFile(file.filePath);

    if (cls.classification === 'bulk') continue;
    if (cls.classification === 'normal' && cls.importance < NORMAL_INCLUSION_THRESHOLD) continue;

    const readStatus = input.readStatusByPath.get(file.filePath);
    if (readStatus && readStatus.terminalStatus === 'manual_summary_required') {
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
  readonly classifiedFiles: readonly { filePath: string; fileSha256: string; pageCount: number | null }[];
  readonly readStatuses: readonly FileReadStatusRecord[];
}

export function assembleDoctorPackManifest(input: AssembleDoctorPackInput): DoctorPackManifest {
  const readStatusByPath = new Map<string, FileReadStatusRecord>();
  for (const r of input.readStatuses) readStatusByPath.set(r.filePath, r);
  const selected = selectKeyDocs({ classifiedFiles: input.classifiedFiles, readStatusByPath });
  return buildManifest(selected);
}

export type { DoctorPackState };
export { CLASSIFIER_VERSION };
