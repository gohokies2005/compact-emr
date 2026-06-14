import type {
  DoctorPackManifestEntry,
  DoctorPackState,
  FileReadStatusRecord,
  KeyDocPageRange,
  KeyDocRecord,
} from './db-types.js';
import { classifyFile, CLASSIFIER_VERSION, type ClassificationResult } from './key-docs-classifier.js';
import { isEffectivelyRead } from './chart-readiness.js';
// doctor-pack grounded pages PR-3, 2026-06-13: the back-map's fact-kind union is the SOURCE OF
// TRUTH for the pinned-page yield ranking. Type-only import — erased at runtime, no import cycle
// (doctor-pack-grounded-pages.ts has no runtime dependency on this module).
import type { GroundedFactKind } from './doctor-pack-grounded-pages.js';

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

// Chunk D: Ryan's curation budget - the pack targets ~15pp. After per-doc page selection,
// applyPackPageBudget() deterministically rank-trims the manifest down to this.
// doctor-pack grounded pages, 2026-06-13 (E2): tightened 20 -> 15. The budget now runs LAST over
// the COMPLETE entry set (rendered non-PDF pages, the veteran statement, grounded pages) — only
// the cover index is exempt and added on top — so the delivered pack lands ~15-17pp (15 budgeted
// content + 1 cover, with the whole-doc-passthrough exemption retired so null-pageCount docs are
// trimmable, not whole-shipped). Caps below re-sum to 15 to match.
export const PACK_PAGE_BUDGET = 15;

// Assessment 2026-06-12 §1c (category budget): docType -> pack category. Soft caps + floors
// replace the old flat "protected docTypes fill first" rule, which let a rating decision eat
// all 20 pages before any clinical note was reached (the live failure).
// Exported (Round 2 item E, 2026-06-12): doctor-pack-generate's medicine-first manifest
// ordering keys off the SAME category map the budget allocator uses — one source of truth.
export type PackCategory = 'sc_proof' | 'denial' | 'clinical' | 'tests' | 'service' | 'lay' | 'other';

const CATEGORY_BY_DOC_TYPE: Partial<Record<KeyDocRecord['docType'], PackCategory>> = {
  rating_decision: 'sc_proof',
  supplemental_decision: 'sc_proof',
  rated_disabilities_view: 'sc_proof',
  denial_letter: 'denial',
  progress_notes: 'clinical',
  c_and_p_exam: 'clinical',
  dbq: 'clinical',
  // Small blue-button exports only contribute pages when the selector's condition-keyed branch
  // matched them (large dumps select zero pages) — those matched pages ARE clinical evidence
  // (the Perez PCMHI dx note, 2026-06-12) and must count toward / be protected by the clinical
  // floor, not ride the unprotected 'other' bucket.
  blue_button: 'clinical',
  imaging: 'tests',
  sleep_study: 'tests',
  pulmonary_function_test: 'tests',
  audiogram: 'tests',
  dd_214: 'service',
  lay_statement: 'lay',
  buddy_statement: 'lay',
  statement_in_support: 'lay',
};

export function packCategoryOf(docType: KeyDocRecord['docType']): PackCategory {
  return CATEGORY_BY_DOC_TYPE[docType] ?? 'other';
}

// Soft caps for the priority allocation phase. clinical's "cap" equals its floor — its
// guaranteed pages come from the floor phase; anything more comes from leftover global rank.
// doctor-pack grounded pages, 2026-06-13 (E2): re-summed to the tightened PACK_PAGE_BUDGET=15.
// 4 + 3 + 4 + 2 + 1 + 1 = 15: under full contention every category gets exactly its allowance.
// The clinical floor (4) is unchanged — the dx note the PCP refuses to sign without is sacred;
// the squeeze came out of sc_proof (6->4), denial (4->3), tests (3->2), lay (2->1).
const CATEGORY_SOFT_CAPS: Record<Exclude<PackCategory, 'other'>, number> = {
  clinical: 4,
  denial: 3,
  sc_proof: 4,
  tests: 2,
  service: 1,
  lay: 1,
};

// Clinical dx pages have a guaranteed FLOOR that fills FIRST (PCP: "a pack without the
// diagnosing note is never acceptable. Not ever.").
const CLINICAL_PAGE_FLOOR = 4;

// Cap-phase priority order. denial sits ahead of sc_proof: it is PROTECTED — never evicted
// below its actual selected pages up to its cap (Ryan: "not just SC conditions but denials
// with explanations").
const CATEGORY_CAP_PRIORITY: readonly Exclude<PackCategory, 'other'>[] = [
  'clinical',
  'denial',
  'sc_proof',
  'tests',
  'service',
  'lay',
];

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
  // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B — capped-but-protected): the pages in
  // THIS entry that grounded an extracted chart fact (from the facts→pages back-map). These are
  // PINNED — protected ahead of regex/LLM-selected pages, allocated FIRST (Phase 0), and trimmed
  // LAST. They still respect the page budget: if the pinned set ITSELF overflows the budget, the
  // LOWEST-yield pinned pages (by pinnedFactKindByPage) drop last. The cover index annotates each
  // pinned page with a "why" line. ABSENT/empty ⇒ the entry has no pinned pages ⇒ byte-identical
  // to the pre-PR-3 budget (Phase 0 allocates nothing, the per-doc take is the legacy prefix-take).
  // Only ever populated when DOCTOR_PACK_GROUNDED_PAGES === 'on'.
  readonly pinnedPages?: readonly number[];
  // Per-pinned-page fact kind — the yield-ranking key for the forced-over-budget pinned trim
  // (sc_condition > screening > active_problem > active_medication). A page absent from this map
  // ranks last (lowest yield). Only meaningful alongside pinnedPages.
  readonly pinnedFactKindByPage?: Readonly<Record<number, GroundedFactKind>>;
}

// doctor-pack grounded pages PR-3, 2026-06-13: pinned-page YIELD ranking for the forced-
// over-budget trim — lower number = higher yield = trimmed LAST. Mirrors the back-map's
// FACT_KIND_QUOTE_PRIORITY (sc_condition grant > screening/objective-test > active_problem dx >
// active_medication) so the page that grounded a 70% PTSD grant is the very last pinned page to go.
const PINNED_FACT_KIND_YIELD: Readonly<Record<GroundedFactKind, number>> = {
  sc_condition: 0,
  screening: 1,
  active_problem: 2,
  active_medication: 3,
};
// A pinned page with no recorded fact kind ranks below every known kind (lowest yield, drops first).
const PINNED_YIELD_UNKNOWN = 99;
function pinnedPageYield(entry: BudgetEntry, page: number): number {
  const kind = entry.pinnedFactKindByPage?.[page];
  return kind !== undefined ? PINNED_FACT_KIND_YIELD[kind] : PINNED_YIELD_UNKNOWN;
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

// doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): expand a doc's ranges to a flat,
// ascending, de-duped page list (the budget reasons over individual pages when an entry carries
// pinned pages, so a pinned page that is NOT the prefix still survives a partial trim).
function flattenRanges(ranges: readonly KeyDocPageRange[]): number[] {
  const pages: number[] = [];
  for (const r of ranges) for (let p = r.from; p <= r.to; p++) pages.push(p);
  return [...new Set(pages)].sort((a, b) => a - b);
}

// doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): pinned-aware per-doc page take. Given a
// doc's full selected pages + which of them are pinned + a quota, keep `quota` pages, PROTECTING
// pinned pages: pinned pages are kept first (highest-yield pinned page first, then page order),
// then the remaining quota is filled from non-pinned pages in page order. The result is re-folded
// into ascending ranges for the assembler (page order is the pack's reading order; the yield order
// governs only WHICH pinned page drops if even the pinned set overflows). When the entry has no
// pinned pages this reduces EXACTLY to the legacy prefix-take (the `byEntry` fast-path in the
// caller skips it entirely, so flag-off is byte-identical).
function takePinnedAware(
  entry: BudgetEntry,
  quota: number,
): readonly KeyDocPageRange[] {
  if (quota <= 0) return [];
  const allPages = flattenRanges(entry.pageRanges);
  const pinnedSet = new Set((entry.pinnedPages ?? []).filter((p) => allPages.includes(p)));
  // Pinned pages, highest yield FIRST (so a forced over-budget pinned trim drops the lowest-yield
  // pinned page last), then page order as the deterministic tiebreak.
  const pinnedOrdered = [...pinnedSet].sort((a, b) => {
    const ya = pinnedPageYield(entry, a);
    const yb = pinnedPageYield(entry, b);
    if (ya !== yb) return ya - yb;
    return a - b;
  });
  const kept = new Set<number>();
  for (const p of pinnedOrdered) {
    if (kept.size >= quota) break;
    kept.add(p);
  }
  // Fill the rest from non-pinned pages in page order (the legacy prefix behavior for the tail).
  for (const p of allPages) {
    if (kept.size >= quota) break;
    if (!pinnedSet.has(p)) kept.add(p);
  }
  return rangesFromSortedPages([...kept].sort((a, b) => a - b));
}

// Fold an ascending, de-duped page list back into contiguous ranges.
function rangesFromSortedPages(sorted: readonly number[]): readonly KeyDocPageRange[] {
  if (sorted.length === 0) return [];
  const ranges: KeyDocPageRange[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur === prev + 1) { prev = cur; continue; }
    ranges.push({ from: start, to: prev });
    start = cur;
    prev = cur;
  }
  ranges.push({ from: start, to: prev });
  return ranges;
}

/**
 * Deterministic pack-level page-budget trim (Ryan: pack targets 10-15pp, max ~20).
 *
 * Assessment 2026-06-12 §1c — CATEGORY BUDGET. The old flat prefix-fill let the "protected"
 * rating decision fill all 20 pages before any clinical note was reached. Allocation is now
 * a Phase-0 pinned reservation followed by three deterministic category phases:
 *   0. (doctor-pack grounded pages PR-3, POLICY B) PINNED pages reserve budget FIRST — the pages
 *      the back-map proved grounded a granted SC condition / objective test / problem / med. They
 *      are protected ahead of the clinical floor and every regex/LLM page, but still CAPPED by the
 *      budget: if the pinned set itself overflows, the LOWEST-yield pinned pages (sc_condition >
 *      screening > active_problem > active_medication) drop last. No pinned entries ⇒ no-op ⇒
 *      byte-identical to the pre-PR-3 budget.
 *   1. FLOORS fill first: clinical (progress_notes / c_and_p_exam / dbq) is guaranteed
 *      CLINICAL_PAGE_FLOOR (4) pages — the dx note is the page the PCP refuses to sign without.
 *   2. CATEGORY SOFT CAPS in priority order (clinical, denial, sc_proof, tests, service, lay):
 *      each category takes up to its cap. denial is PROTECTED — it is never evicted below its
 *      actual selected pages up to its cap, because it allocates before sc_proof and the
 *      floor+denial allowance always fits the budget.
 *   3. Remaining budget by GLOBAL RANK (classification tier > importance desc > filePath asc)
 *      across all docs including 'other' — the caps are soft: spare pages flow back.
 * Within a category, docs allocate in global-rank order; within a doc, pages are kept in page
 * order (prefix of the selected ranges - the selector orders decision/impression pages first
 * in practice because they ARE the early pages).
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
  // Global rank: classification tier > importance desc > filePath asc. (The old
  // protected-docTypes-first key is superseded by the category phases.)
  const ranked = [...trimmable].sort((a, b) => {
    if (tierOrder[a.classification] !== tierOrder[b.classification]) return tierOrder[a.classification] - tierOrder[b.classification];
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.filePath.localeCompare(b.filePath);
  });

  // ---- Three-phase allocation (deterministic; per-doc page counts, prefix-take later) ----
  const takenByPath = new Map<string, number>();
  let remaining = budget;
  const takeFor = (entry: BudgetEntry, want: number): number => {
    const already = takenByPath.get(entry.filePath) ?? 0;
    const take = Math.max(0, Math.min(want, entry.pageCount - already, remaining));
    if (take > 0) {
      takenByPath.set(entry.filePath, already + take);
      remaining -= take;
    }
    return take;
  };
  const categoryTaken = (cat: PackCategory): number =>
    ranked.reduce((sum, e) => sum + (packCategoryOf(e.docType) === cat ? (takenByPath.get(e.filePath) ?? 0) : 0), 0);

  // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B — Phase 0): PINNED pages reserve budget
  // FIRST, ahead of the clinical floor and every regex/LLM-selected page. A pinned page grounded a
  // granted SC condition / objective test / active problem / med — the back-map's high-yield set —
  // so it is sorted to the TOP tier and a forced over-budget trim never drops it before an ordinary
  // page. CAPPED, not uncapped: pinned reservation stops at `remaining` (the budget). If the pinned
  // SET ITSELF overflows the budget, pinned pages are reserved in global YIELD order (sc_condition >
  // screening > active_problem > active_medication, then doc rank, then page order) so the LOWEST-
  // yield pinned page is the one left out. Each reserved pinned page bumps takenByPath, so the
  // count-based phases below see pinned docs as already partly filled and never double-count them.
  // When NO entry carries pinned pages this loop reserves nothing ⇒ the three phases + the legacy
  // prefix-take run byte-identically to the pre-PR-3 budget.
  const hasPinned = ranked.some((e) => (e.pinnedPages ?? []).length > 0);
  // Per-doc pinned pages actually RESERVED (so emission keeps exactly these, highest-yield first).
  const reservedPinnedByPath = new Map<string, Set<number>>();
  if (hasPinned) {
    // Flatten every (entry, pinnedPage) into one globally-ranked list: yield kind asc, then doc
    // global-rank (the `ranked` index), then page number asc — fully deterministic.
    const rankIndex = new Map(ranked.map((e, i) => [e.filePath, i]));
    interface PinnedSlot { entry: BudgetEntry; page: number }
    const slots: PinnedSlot[] = [];
    for (const entry of ranked) {
      const valid = flattenRanges(entry.pageRanges);
      const seen = new Set<number>();
      for (const p of entry.pinnedPages ?? []) {
        if (!valid.includes(p) || seen.has(p)) continue; // only pin real, de-duped selected pages
        seen.add(p);
        slots.push({ entry, page: p });
      }
    }
    slots.sort((a, b) => {
      const ya = pinnedPageYield(a.entry, a.page);
      const yb = pinnedPageYield(b.entry, b.page);
      if (ya !== yb) return ya - yb;
      const ra = rankIndex.get(a.entry.filePath) ?? 0;
      const rb = rankIndex.get(b.entry.filePath) ?? 0;
      if (ra !== rb) return ra - rb;
      return a.page - b.page;
    });
    for (const slot of slots) {
      if (remaining <= 0) break;
      const got = takeFor(slot.entry, 1); // reserve one page of budget for this pinned page
      if (got > 0) {
        const set = reservedPinnedByPath.get(slot.entry.filePath) ?? new Set<number>();
        set.add(slot.page);
        reservedPinnedByPath.set(slot.entry.filePath, set);
      }
    }
  }

  // Phase 1 — clinical floor fills first.
  let clinicalTaken = 0;
  for (const entry of ranked) {
    if (clinicalTaken >= CLINICAL_PAGE_FLOOR || remaining <= 0) break;
    if (packCategoryOf(entry.docType) !== 'clinical') continue;
    clinicalTaken += takeFor(entry, CLINICAL_PAGE_FLOOR - clinicalTaken);
  }

  // Phase 2 — category soft caps in priority order.
  for (const cat of CATEGORY_CAP_PRIORITY) {
    const cap = CATEGORY_SOFT_CAPS[cat];
    let catTaken = categoryTaken(cat);
    for (const entry of ranked) {
      if (catTaken >= cap || remaining <= 0) break;
      if (packCategoryOf(entry.docType) !== cat) continue;
      catTaken += takeFor(entry, cap - catTaken);
    }
  }

  // Phase 3 — leftover budget by global rank, caps are soft ('other' docs allocate here).
  for (const entry of ranked) {
    if (remaining <= 0) break;
    takeFor(entry, entry.pageCount);
  }

  const keptRangesByPath = new Map<string, readonly KeyDocPageRange[]>();
  const trimNotes: string[] = [];
  const trimmedFilePaths: string[] = [];
  for (const entry of ranked) {
    const take = takenByPath.get(entry.filePath) ?? 0;
    // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): an entry with pinned pages uses the
    // pinned-aware take so the RESERVED pinned pages survive even when they are not the page-order
    // prefix (e.g. BB page 412 grounded a grant — it is kept though it is far from page 1). The
    // non-pinned tail still fills in page order. Entries with no pinned pages take the legacy
    // prefix-take → byte-identical to the pre-PR-3 budget.
    const entryHasPinned = (reservedPinnedByPath.get(entry.filePath)?.size ?? 0) > 0;
    if (take === entry.pageCount) {
      keptRangesByPath.set(entry.filePath, entry.pageRanges);
    } else if (take > 0) {
      keptRangesByPath.set(
        entry.filePath,
        entryHasPinned ? takePinnedAware(entry, take) : takeFirstPages(entry.pageRanges, take),
      );
      trimNotes.push(`${entry.filePath}: kept ${take} of ${entry.pageCount} selected pages (budget trim)`);
      trimmedFilePaths.push(entry.filePath);
    } else {
      trimNotes.push(`${entry.filePath}: dropped (${entry.pageCount} selected pages over budget)`);
      trimmedFilePaths.push(entry.filePath);
    }
  }

  // Category-eviction notes (assessment §1 fix 5: the cover sheet lists what the doctor is
  // NOT seeing and why).
  const noted = new Set<PackCategory>();
  for (const entry of ranked) {
    const cat = packCategoryOf(entry.docType);
    if (noted.has(cat)) continue;
    noted.add(cat);
    const selected = ranked.reduce((sum, e) => sum + (packCategoryOf(e.docType) === cat ? e.pageCount : 0), 0);
    const kept = categoryTaken(cat);
    if (kept < selected) {
      const capNote = cat === 'other' ? 'global rank only' : `soft cap ${CATEGORY_SOFT_CAPS[cat]}${cat === 'clinical' ? `, floor ${CLINICAL_PAGE_FLOOR}` : ''}`;
      trimNotes.push(`category ${cat}: kept ${kept} of ${selected} selected pages (${capNote})`);
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
