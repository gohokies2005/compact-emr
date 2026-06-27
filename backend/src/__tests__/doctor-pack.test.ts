import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  buildCategoryAssertionLines,
  buildManifest,
  computeDroppedCategoryWarnings,
  DOCTOR_PACK_ENGINE_VERSION,
  expectedStudyForCondition,
  PACK_PAGE_BUDGET,
  PACK_PAGE_BUDGET_CATEGORY_FLOORS,
  PACK_PAGE_HARD_CAP,
  PACK_PAGE_TARGET,
  PASSTHROUGH_BOUNDED_PAGES,
  selectKeyDocs,
  type BudgetEntry,
  type PackCategory,
  type SelectedKeyDoc,
} from '../services/doctor-pack.js';
import type { FileReadStatusRecord } from '../services/db-types.js';

const now = new Date('2026-05-26T00:00:00.000Z');

function readStatusRow(filePath: string, terminalStatus: FileReadStatusRecord['terminalStatus'] = 'read'): FileReadStatusRecord {
  return {
    id: `FRS-${filePath}`,
    caseId: 'CASE-1',
    filePath,
    fileSha256: 'a'.repeat(64),
    terminalStatus,
    attemptsJson: [],
    // >= 40 chars: MANUAL_SUMMARY_MIN_LENGTH — selectKeyDocs now applies the shared
    // isEffectivelyRead predicate, which (correctly) rejects an under-length "summary".
    manualSummary: terminalStatus === 'manual_summary_provided' ? 'RN reviewed and summarized this file in full detail.' : null,
    manualSummaryAt: terminalStatus === 'manual_summary_provided' ? now : null,
    manualSummaryBy: terminalStatus === 'manual_summary_provided' ? 'RN-SUB' : null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

describe('selectKeyDocs', () => {
  it('always includes high_signal files in full', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'DD-214.pdf', fileSha256: 'a'.repeat(64), pageCount: 3 }],
      readStatusByPath: new Map([['DD-214.pdf', readStatusRow('DD-214.pdf')]]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.classification).toBe('high_signal');
    expect(selected[0]?.pageRanges).toEqual([{ from: 1, to: 3 }]);
  });

  it('caps high_signal at all available pages (no truncation for the HARD RULE)', () => {
    // Even a 200-page denial letter is included in full — the FRN HARD RULE is "every inch".
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'DenialLetter-2024.pdf', fileSha256: 'a'.repeat(64), pageCount: 200 }],
      readStatusByPath: new Map([['DenialLetter-2024.pdf', readStatusRow('DenialLetter-2024.pdf')]]),
    });
    expect(selected[0]?.pageRanges).toEqual([{ from: 1, to: 200 }]);
  });

  it('excludes bulk files (e.g. Blue Button) by default', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'Blue_Button_2024.pdf', fileSha256: 'a'.repeat(64), pageCount: 800 }],
      readStatusByPath: new Map([['Blue_Button_2024.pdf', readStatusRow('Blue_Button_2024.pdf')]]),
    });
    expect(selected).toHaveLength(0);
  });

  it('includes normal-tier files (importance>=50) capped at 80 pages', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'random_clinical_note.pdf', fileSha256: 'a'.repeat(64), pageCount: 120 }],
      readStatusByPath: new Map([['random_clinical_note.pdf', readStatusRow('random_clinical_note.pdf')]]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.classification).toBe('normal');
    expect(selected[0]?.pageRanges).toEqual([{ from: 1, to: 80 }]);
  });

  it('excludes files in manual_summary_required state (defense-in-depth)', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'DD-214.pdf', fileSha256: 'a'.repeat(64), pageCount: 3 }],
      readStatusByPath: new Map([['DD-214.pdf', readStatusRow('DD-214.pdf', 'manual_summary_required')]]),
    });
    expect(selected).toHaveLength(0);
  });

  // Package 7 (H-tail, 2026-06-11): pack inclusion goes through the SHARED isEffectivelyRead
  // predicate (chart-readiness.ts, Package 1), not a raw terminalStatus read. A row classified
  // 'manual_summary_required' under the OLD 40-word threshold whose stored last attempt passes
  // the CURRENT thresholds (>= 20 words, clean) is retro-HEALED — the raw check silently
  // omitted it from packs even though every other consumer treats it as read.
  it('INCLUDES a retro-healed file: manual_summary_required but last attempt passes current thresholds', () => {
    const healed: FileReadStatusRecord = {
      ...readStatusRow('Thomas_OSA_Misc_3.png.pdf', 'manual_summary_required'),
      attemptsJson: [
        { method: 'tesseract_ocr', wordCount: 37, corruptedTokenRatio: 0.0, note: null },
      ] as unknown as FileReadStatusRecord['attemptsJson'],
    };
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'Thomas_OSA_Misc_3.png.pdf', fileSha256: 'a'.repeat(64), pageCount: 1 }],
      readStatusByPath: new Map([['Thomas_OSA_Misc_3.png.pdf', healed]]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.pageRanges).toEqual([{ from: 1, to: 1 }]);
  });

  // The heal requires the stored attempt to actually PASS: a genuinely unreadable file (last
  // attempt below the char floor, unknown size) stays excluded. (CHAR floor, Ryan 2026-06-14.)
  it('still excludes a manual_summary_required file whose last attempt fails current thresholds', () => {
    const unreadable: FileReadStatusRecord = {
      ...readStatusRow('fax_cover.pdf', 'manual_summary_required'),
      attemptsJson: [
        // 4 non-whitespace chars, unknown page size → below the char floor → not healed.
        { method: 'tesseract_ocr', wordCount: 1, charCount: 4, corruptedTokenRatio: 0.0, note: null },
      ] as unknown as FileReadStatusRecord['attemptsJson'],
    };
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'fax_cover.pdf', fileSha256: 'a'.repeat(64), pageCount: 1 }],
      readStatusByPath: new Map([['fax_cover.pdf', unreadable]]),
    });
    expect(selected).toHaveLength(0);
  });

  it('includes files with valid manual summaries (manual_summary_provided)', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'old_scanned_file.pdf', fileSha256: 'a'.repeat(64), pageCount: 5 }],
      readStatusByPath: new Map([['old_scanned_file.pdf', readStatusRow('old_scanned_file.pdf', 'manual_summary_provided')]]),
    });
    expect(selected).toHaveLength(1);
  });

  it('sorts: high_signal first, then by importance desc, then by file path', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [
        { filePath: 'random.pdf',         fileSha256: 'a'.repeat(64), pageCount: 5 },
        { filePath: 'DenialLetter.pdf',   fileSha256: 'a'.repeat(64), pageCount: 5 },
        { filePath: 'Audiogram.pdf',      fileSha256: 'a'.repeat(64), pageCount: 5 },
        { filePath: 'Lay_Statement.pdf',  fileSha256: 'a'.repeat(64), pageCount: 5 },
      ],
      readStatusByPath: new Map(),
    });
    expect(selected.map((s) => s.filePath)).toEqual([
      'DenialLetter.pdf',   // importance 100
      'Audiogram.pdf',      // importance 80
      'Lay_Statement.pdf',  // importance 70
      'random.pdf',         // importance 50 (normal)
    ]);
  });

  it('handles null pageCount by producing an empty pageRanges array', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{ filePath: 'DD-214.pdf', fileSha256: 'a'.repeat(64), pageCount: null }],
      readStatusByPath: new Map([['DD-214.pdf', readStatusRow('DD-214.pdf')]]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.pageRanges).toEqual([]);
  });
});

describe('buildManifest', () => {
  it('produces a manifest with engineVersion + counts', () => {
    const docs: SelectedKeyDoc[] = [
      { filePath: 'DD-214.pdf',     fileSha256: 'a'.repeat(64), classification: 'high_signal', docType: 'dd_214',         importance: 95, pageRanges: [{ from: 1, to: 3 }] },
      { filePath: 'DBQ-OSA.pdf',    fileSha256: 'a'.repeat(64), classification: 'high_signal', docType: 'dbq',            importance: 90, pageRanges: [{ from: 1, to: 12 }] },
    ];
    const m = buildManifest(docs);
    expect(m.engineVersion).toBe(DOCTOR_PACK_ENGINE_VERSION);
    expect(m.keyDocCount).toBe(2);
    expect(m.totalPageCount).toBe(15);
    expect(m.entries).toHaveLength(2);
    expect(m.aboveTarget).toBe(false);
  });

  it('flags aboveTarget when total page count exceeds the soft target', () => {
    const docs: SelectedKeyDoc[] = [
      { filePath: 'Huge_DenialLetter.pdf', fileSha256: 'a'.repeat(64), classification: 'high_signal', docType: 'denial_letter', importance: 100, pageRanges: [{ from: 1, to: PACK_PAGE_TARGET + 50 }] },
    ];
    const m = buildManifest(docs);
    expect(m.aboveTarget).toBe(true);
    expect(m.totalPageCount).toBe(PACK_PAGE_TARGET + 50);
  });
});

// ===================== Chunk D (2026-06-11): content-aware cls passthrough =====================

describe('selectKeyDocs — pre-computed classification passthrough (Chunk D)', () => {
  it('a Misc_N.pdf with a content-derived rating_decision cls is included high_signal in full', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{
        filePath: 'cases/C1/abc-Misc_2.pdf',
        fileSha256: 'a'.repeat(64),
        pageCount: 9,
        cls: { classification: 'high_signal', docType: 'rating_decision', importance: 100, matchedPattern: 'content_classification' },
      }],
      readStatusByPath: new Map(),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.docType).toBe('rating_decision');
    expect(selected[0]?.pageRanges).toEqual([{ from: 1, to: 9 }]);
  });

  it('a Misc_N.pdf with a content-derived blue_button cls is excluded (bulk)', () => {
    const selected = selectKeyDocs({
      classifiedFiles: [{
        filePath: 'cases/C1/abc-Misc_9.pdf',
        fileSha256: 'a'.repeat(64),
        pageCount: 500,
        cls: { classification: 'bulk', docType: 'blue_button', importance: 30, matchedPattern: 'content_classification' },
      }],
      readStatusByPath: new Map(),
    });
    expect(selected).toHaveLength(0);
  });
});

// ===================== Chunk D (2026-06-11): pack page budget =====================

function be(filePath: string, docType: BudgetEntry['docType'], classification: BudgetEntry['classification'], importance: number, pageCount: number): BudgetEntry {
  return {
    filePath,
    docType,
    classification,
    importance,
    pageRanges: pageCount > 0 ? [{ from: 1, to: pageCount }] : [],
    pageCount,
  };
}

describe('applyPackPageBudget', () => {
  it('under budget: returns entries unchanged, trimmed=false', () => {
    const entries = [be('a.pdf', 'rating_decision', 'high_signal', 100, 6), be('b.pdf', 'dd_214', 'high_signal', 95, 2)];
    const r = applyPackPageBudget(entries);
    expect(r.trimmed).toBe(false);
    expect(r.entries).toEqual(entries);
    expect(r.preTrimPageCount).toBe(8);
    expect(r.postTrimPageCount).toBe(8);
    expect(r.trimNotes).toEqual([]);
  });

  it('over budget: trims to <= PACK_PAGE_BUDGET, lowest tier/importance loses first', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 8),
      be('dbq.pdf', 'dbq', 'high_signal', 90, 6),
      be('audio.pdf', 'audiogram', 'high_signal', 80, 4),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 10),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.trimmed).toBe(true);
    expect(r.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
    // doctor-pack grounded pages, 2026-06-13 (E2): re-derived for budget 15 + caps (clinical 4
    // floor, sc_proof 4, tests 2). dbq + notes are BOTH clinical (dbq high_signal wins the floor).
    // Floor: dbq 4. Caps: sc_proof -> rating 4, tests -> audio 2. Leftover 5 by rank: rating +4=8,
    // dbq +1=5. notes (bulk clinical) drops. Total 8+5+2 = 15.
    expect(r.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(8);
    expect(r.entries.find((e) => e.filePath === 'dbq.pdf')?.pageCount).toBe(5);
    expect(r.entries.find((e) => e.filePath === 'audio.pdf')?.pageCount).toBe(2);
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')).toBeUndefined();
    expect(r.trimmedFilePaths).toEqual(['dbq.pdf', 'audio.pdf', 'notes.pdf']);
    expect(r.trimNotes.join(' ')).toContain('notes.pdf: dropped (10');
  });

  // HUNDREDS-OF-PAGES KILL (Dr. Kasky 2026-06-25): a legacy whole-doc entry (no per-page OCR + null
  // Document.pageCount -> pageRanges []) has pageCount 0, so the budget couldn't see its size and
  // used to re-emit it untrimmed — the assembler then shipped the WHOLE (possibly 300-page) PDF,
  // escaping the budget. It now SURVIVES (never silently dropped) but is BOUNDED to its first
  // PASSTHROUGH_BOUNDED_PAGES, with a loud trim note. (We still don't drop it — its size is unknown
  // and it may carry a decisive document.)
  it('over budget: an incoming empty-ranges whole-doc entry survives but is BOUNDED (not shipped whole)', () => {
    const entries = [
      be('legacy_va_letter.pdf', 'denial_letter', 'high_signal', 100, 0), // pageRanges [] via be()
      be('dbq.pdf', 'dbq', 'high_signal', 90, 15),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 10),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.trimmed).toBe(true);
    const survivor = r.entries.find((e) => e.filePath === 'legacy_va_letter.pdf');
    expect(survivor).toBeDefined();
    // BOUNDED, not the open-ended whole-doc [] shape that made the assembler ship every page.
    expect(survivor?.pageRanges).toEqual([{ from: 1, to: PASSTHROUGH_BOUNDED_PAGES }]);
    expect(survivor?.pageCount).toBe(PASSTHROUGH_BOUNDED_PAGES);
    expect(r.trimmedFilePaths).toContain('legacy_va_letter.pdf');
    expect(r.trimNotes.join(' ')).toContain('legacy_va_letter.pdf: whole-doc passthrough');
    expect(r.trimNotes.join(' ')).toContain(`first ${PASSTHROUGH_BOUNDED_PAGES} pages`);
  });

  // The early no-trim return must NOT fire while a passthrough is present: a passthrough's pageCount
  // is 0, so a pack of small sized content + an unsized bundle sums under the budget and (pre-fix)
  // returned early, shipping the bundle in FULL. This is the precise hundreds-of-pages path when
  // there is little other content. The passthrough must still be bounded.
  it('passthrough present but sized content is under budget: still bounds the passthrough (no early-return escape)', () => {
    const entries = [
      be('dd214.pdf', 'dd_214', 'high_signal', 95, 2), // 2 sized pages, well under budget
      be('huge_blue_button.pdf', 'denial_letter', 'high_signal', 100, 0), // unsized passthrough
    ];
    const r = applyPackPageBudget(entries);
    expect(r.trimmed).toBe(true); // a passthrough was bounded
    // The sized doc is untouched.
    expect(r.entries.find((e) => e.filePath === 'dd214.pdf')?.pageRanges).toEqual([{ from: 1, to: 2 }]);
    // The passthrough is bounded, NOT shipped whole.
    const bb = r.entries.find((e) => e.filePath === 'huge_blue_button.pdf');
    expect(bb?.pageRanges).toEqual([{ from: 1, to: PASSTHROUGH_BOUNDED_PAGES }]);
    expect(r.entries.some((e) => e.pageRanges.length === 0)).toBe(false);
  });

  // ABSOLUTE backstop: even if the per-doc/passthrough math somehow sums above the hard cap, the
  // returned pack never exceeds PACK_PAGE_HARD_CAP content pages — hundreds of pages can never ship.
  it('hard cap: a contrived oversized set is trimmed to PACK_PAGE_HARD_CAP, dropping trailing entries', () => {
    // Many bounded passthroughs would sum well over the cap if all kept (8 each * 12 = 96).
    const entries = Array.from({ length: 12 }, (_v, i) =>
      be(`bundle_${String(i).padStart(2, '0')}.pdf`, 'denial_letter', 'high_signal', 100, 0),
    );
    const r = applyPackPageBudget(entries);
    expect(r.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_HARD_CAP);
    const total = r.entries.reduce((sum, e) => sum + e.pageCount, 0);
    expect(total).toBeLessThanOrEqual(PACK_PAGE_HARD_CAP);
    expect(r.trimNotes.join(' ')).toContain(`${PACK_PAGE_HARD_CAP}-page pack hard cap`);
  });

  it('NEVER trims the SC-decision docs first, even against higher-importance non-protected docs', () => {
    const entries = [
      be('rated_view.pdf', 'rated_disabilities_view', 'high_signal', 95, 12),
      be('denial.pdf', 'denial_letter', 'high_signal', 100, 14),
    ];
    const r = applyPackPageBudget(entries);
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15. denial cap 3 -> takes 3 first
    // (protected/priority), sc_proof cap 4 -> rated_view 4. Leftover 8 by rank: denial (importance
    // 100) +8 = 11, rated_view stays 4. denial still keeps MORE than the unprotected rated_view.
    expect(r.entries.find((e) => e.filePath === 'denial.pdf')?.pageCount).toBe(11);
    expect(r.entries.find((e) => e.filePath === 'rated_view.pdf')?.pageCount).toBe(4);
  });

  it('drops zero-allocation docs ENTIRELY (empty ranges would make the assembler ship the whole doc)', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 20),
      be('extra.pdf', 'personnel_record', 'high_signal', 75, 5),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.entries.map((e) => e.filePath)).toEqual(['rating.pdf']);
    expect(r.entries.some((e) => e.pageRanges.length === 0)).toBe(false);
    expect(r.trimNotes.join(' ')).toContain('extra.pdf: dropped (5');
    expect(r.trimmedFilePaths).toContain('extra.pdf');
  });

  it('trims a partially-kept doc from the END of its selected ranges (prefix keep, page order preserved)', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 16),
      {
        ...be('cp.pdf', 'c_and_p_exam', 'high_signal', 90, 0),
        pageRanges: [{ from: 2, to: 4 }, { from: 7, to: 9 }] as const,
        pageCount: 6,
      },
    ];
    const r = applyPackPageBudget(entries);
    const cp = r.entries.find((e) => e.filePath === 'cp.pdf');
    // 16 protected + 4 remaining: prefix of [2-4, 7-9] = [2-4, 7-7].
    expect(cp?.pageRanges).toEqual([{ from: 2, to: 4 }, { from: 7, to: 7 }]);
    expect(cp?.pageCount).toBe(4);
  });

  it('is deterministic: same input -> identical output (assembler idempotency contract)', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 9),
      be('dbq.pdf', 'dbq', 'high_signal', 90, 9),
      be('audio.pdf', 'audiogram', 'high_signal', 80, 9),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 9),
    ];
    const a = applyPackPageBudget(entries);
    const b = applyPackPageBudget(entries.map((e) => ({ ...e })));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('preserves the caller-supplied entry order for kept docs', () => {
    const entries = [
      be('z_rating.pdf', 'rating_decision', 'high_signal', 100, 5),
      be('a_dbq.pdf', 'dbq', 'high_signal', 90, 5),
      be('m_notes.pdf', 'progress_notes', 'bulk', 35, 30),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.entries.map((e) => e.filePath)).toEqual(['z_rating.pdf', 'a_dbq.pdf', 'm_notes.pdf']);
  });
});

// ============ doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B — capped-but-protected) ===========
// Pinned pages (the back-mapped pages that grounded a granted SC condition / test / problem / med)
// are protected AHEAD of regex/LLM-selected pages and trimmed LAST. But the pack still respects
// PACK_PAGE_BUDGET: if the pinned set itself overflows, the LOWEST-yield pinned page drops last
// (sc_condition > screening > active_problem > active_medication). No pinned fields ⇒ byte-identical.
describe('applyPackPageBudget — PINNED pages (PR-3, policy B)', () => {
  // A budget entry carrying pinned grounded pages (the back-map's high-yield page set for this doc)
  // plus their per-page fact kind (the yield-ranking key for a forced over-budget pinned trim).
  function bePinned(
    filePath: string,
    docType: BudgetEntry['docType'],
    classification: BudgetEntry['classification'],
    importance: number,
    pageCount: number,
    pinnedPages: readonly number[],
    pinnedFactKindByPage: Readonly<Record<number, 'sc_condition' | 'screening' | 'active_problem' | 'active_medication'>>,
  ): BudgetEntry {
    return { ...be(filePath, docType, classification, importance, pageCount), pinnedPages, pinnedFactKindByPage };
  }

  it('(a) flag-on: a pinned grounded page survives a forced over-budget trim while an ordinary regex page is dropped', () => {
    // A bulk personnel_record (category 'other' — NO floor, NO cap; it only ever gets pages from
    // leftover global rank) of 900 pages whose page 412 grounded the PTSD grant (pinned). Plus a
    // rating decision big enough to devour the ENTIRE budget by rank. Without pinning, the 'other'
    // bulk doc gets ZERO pages (the rating eats the budget) → its grounded page 412 would be lost.
    // Policy B: Phase 0 reserves page 412 BEFORE the rating decision allocates, so it survives.
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 30),
      bePinned('bulk.pdf', 'personnel_record', 'bulk', 30, 900, [412], { 412: 'sc_condition' }),
    ];
    const r = applyPackPageBudget(entries, PACK_PAGE_BUDGET);
    expect(r.trimmed).toBe(true);
    expect(r.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
    // The pinned page 412 is PROTECTED (Phase 0) even though its doc is the lowest-rank bulk 'other'
    // doc that would otherwise get nothing — and ONLY page 412 (no floor/cap pulls extra pages).
    const bulk = r.entries.find((e) => e.filePath === 'bulk.pdf');
    expect(bulk).toBeDefined();
    expect(bulk?.pageRanges).toEqual([{ from: 412, to: 412 }]);
    // The rating decision absorbs the rest of the budget but did NOT push the pinned page out: it
    // keeps 14 (budget 15 minus the 1 reserved pinned page), i.e. an ORDINARY rating page was the
    // thing dropped to make room for the pin.
    const rating = r.entries.find((e) => e.filePath === 'rating.pdf');
    expect(rating?.pageCount).toBe(PACK_PAGE_BUDGET - 1); // 14
  });

  it('(a2) a pinned page that is NOT the page-order prefix still survives a partial trim of its own doc', () => {
    // One doc, 20 selected pages, budget forces a trim. Page 18 is pinned (a grant page deep in the
    // doc). The legacy prefix-take would drop p18 (keeps p1..p15); pinned-aware MUST keep p18.
    const entries = [
      bePinned('rating.pdf', 'rating_decision', 'high_signal', 100, 20, [18], { 18: 'sc_condition' }),
    ];
    const r = applyPackPageBudget(entries, PACK_PAGE_BUDGET);
    const rating = r.entries.find((e) => e.filePath === 'rating.pdf');
    // 15 pages kept: the pinned p18 + the first 14 by page order.
    const kept = (rating?.pageRanges ?? []).flatMap((rg) => {
      const out: number[] = [];
      for (let p = rg.from; p <= rg.to; p++) out.push(p);
      return out;
    });
    expect(kept).toContain(18);
    expect(kept.length).toBe(PACK_PAGE_BUDGET);
  });

  it('(b) when the PINNED set itself overflows the budget, the LOWEST-yield kind (active_medication) drops before sc_condition', () => {
    // A single bulk doc with 20 pinned pages — more than the budget. 1 sc_condition (highest yield),
    // 1 active_medication (lowest yield), and 18 active_problem fillers. Budget 15 can hold only 15
    // of the 20 pinned pages. The forced pinned trim must keep sc_condition and drop the lowest-yield
    // pages first (active_medication before any sc_condition).
    const pinnedPages = Array.from({ length: 20 }, (_, i) => i + 1); // pages 1..20
    const kinds: Record<number, 'sc_condition' | 'screening' | 'active_problem' | 'active_medication'> = {
      1: 'sc_condition',
      2: 'active_medication',
    };
    for (let p = 3; p <= 20; p++) kinds[p] = 'active_problem';
    const entries = [bePinned('bb.pdf', 'blue_button', 'bulk', 30, 20, pinnedPages, kinds)];
    const r = applyPackPageBudget(entries, PACK_PAGE_BUDGET);
    const bb = r.entries.find((e) => e.filePath === 'bb.pdf');
    const kept = new Set((bb?.pageRanges ?? []).flatMap((rg) => {
      const out: number[] = [];
      for (let p = rg.from; p <= rg.to; p++) out.push(p);
      return out;
    }));
    expect(kept.size).toBe(PACK_PAGE_BUDGET); // exactly 15 of the 20 pinned pages
    expect(kept.has(1)).toBe(true);  // sc_condition (highest yield) ALWAYS kept
    expect(kept.has(2)).toBe(false); // active_medication (lowest yield) dropped before any sc_condition
  });

  it('(d) NO pinned fields ⇒ byte-identical to the pre-PR-3 budget (Phase 0 is a no-op)', () => {
    // The exact over-budget fixture from the legacy test above, run with no pinned fields, must
    // produce identical output (same kept pages, same trim notes) — proving Phase 0 + pinned-aware
    // take collapse to the legacy prefix-take when nothing is pinned.
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 8),
      be('dbq.pdf', 'dbq', 'high_signal', 90, 6),
      be('audio.pdf', 'audiogram', 'high_signal', 80, 4),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 10),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(8);
    expect(r.entries.find((e) => e.filePath === 'dbq.pdf')?.pageCount).toBe(5);
    expect(r.entries.find((e) => e.filePath === 'audio.pdf')?.pageCount).toBe(2);
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')).toBeUndefined();
    expect(r.trimmedFilePaths).toEqual(['dbq.pdf', 'audio.pdf', 'notes.pdf']);
  });
});

// ============ Assessment 2026-06-12 §1c: CATEGORY budget (caps + clinical floor) ============
// The flat prefix-fill let "protected" rating decisions fill all 20 pages before any clinical
// note was reached. Categories now have soft caps + a clinical floor that fills FIRST.

describe('applyPackPageBudget — category budget (assessment §1c)', () => {
  it('clinical floor: progress notes keep >= 4 pages even when a giant rating decision wants the whole budget', () => {
    const entries = [
      be('rating_18pp.pdf', 'rating_decision', 'high_signal', 100, 18),
      be('notes.pdf', 'progress_notes', 'normal', 60, 6),
    ];
    const r = applyPackPageBudget(entries);
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15. Floor 4 -> notes 4; sc_proof cap 4
    // -> rating 4; leftover 7 by rank -> rating +7 = 11. notes still keeps its guaranteed 4.
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')?.pageCount).toBe(4);
    expect(r.entries.find((e) => e.filePath === 'rating_18pp.pdf')?.pageCount).toBe(11);
    expect(r.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
  });

  it('denial is PROTECTED: never evicted below its actual selected pages up to 4', () => {
    const entries = [
      be('cp_exam_30pp.pdf', 'c_and_p_exam', 'high_signal', 90, 30),
      be('denial.pdf', 'denial_letter', 'high_signal', 100, 4),
    ];
    const r = applyPackPageBudget(entries);
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15, denial cap 3. clinical floor 4 ->
    // C&P 4; denial cap 3 -> all 4 selected? cap is 3 so denial gets its 4 selected pages capped
    // to... the cap is SOFT and denial is protected up to its cap (3) + it has exactly 4 pages.
    // Floor: C&P 4. denial cap 3 -> denial 3. Wait denial has 4 selected pages; cap 3 takes 3,
    // then leftover phase tops denial up by rank (importance 100, highest) +1 = 4 full. Remaining
    // 15-4-4 = 7 to C&P by rank -> C&P 11. denial keeps all 4 selected (protected).
    expect(r.entries.find((e) => e.filePath === 'denial.pdf')?.pageCount).toBe(4);
    expect(r.entries.find((e) => e.filePath === 'cp_exam_30pp.pdf')?.pageCount).toBe(11);
  });

  it('soft caps under full contention: every category gets its allowance (4+3+4+2+1+1 = 15)', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 10),  // sc_proof cap 4
      be('denial.pdf', 'denial_letter', 'high_signal', 100, 10),    // denial cap 3
      be('dbq.pdf', 'dbq', 'high_signal', 90, 10),                  // clinical floor/cap 4
      be('sleep.pdf', 'sleep_study', 'high_signal', 85, 10),        // tests cap 2
      be('dd214.pdf', 'dd_214', 'high_signal', 95, 2),              // service cap 1
      be('lay.pdf', 'lay_statement', 'high_signal', 70, 5),         // lay cap 1
    ];
    const r = applyPackPageBudget(entries);
    const count = (p: string) => r.entries.find((e) => e.filePath === p)?.pageCount ?? 0;
    // doctor-pack grounded pages, 2026-06-13 (E2): every category capped, budget fully consumed,
    // no leftover (4+3+4+2+1+1 = 15 exactly).
    expect(count('dbq.pdf')).toBe(4);
    expect(count('denial.pdf')).toBe(3);
    expect(count('rating.pdf')).toBe(4);
    expect(count('sleep.pdf')).toBe(2);
    expect(count('dd214.pdf')).toBe(1);
    expect(count('lay.pdf')).toBe(1);
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET);
  });

  it('caps are SOFT: leftover budget flows back by global rank past the category cap', () => {
    const entries = [
      be('sleep_10pp.pdf', 'sleep_study', 'high_signal', 85, 10), // tests cap 3, but no contention
      be('notes.pdf', 'progress_notes', 'normal', 60, 14),
    ];
    const r = applyPackPageBudget(entries);
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15. floor: notes 4; caps: tests 2;
    // leftover 9 by rank: sleep (high_signal) +8 = 10 full, then notes +1 = 5. Total 10+5 = 15.
    expect(r.entries.find((e) => e.filePath === 'sleep_10pp.pdf')?.pageCount).toBe(10);
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')?.pageCount).toBe(5);
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET);
  });

  it('records category evictions in trimNotes', () => {
    const entries = [
      be('rating_18pp.pdf', 'rating_decision', 'high_signal', 100, 18),
      be('notes.pdf', 'progress_notes', 'normal', 60, 6),
    ];
    const r = applyPackPageBudget(entries);
    const joined = r.trimNotes.join(' | ');
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15 -> rating keeps 11 (was 16).
    expect(joined).toContain('rating_18pp.pdf: kept 11 of 18');
    expect(joined).toContain('notes.pdf: kept 4 of 6');
    expect(joined).toContain('category sc_proof: kept 11 of 18');
    expect(joined).toContain('category clinical: kept 4 of 6');
  });

  it('"other" docTypes only allocate from leftover global rank', () => {
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 10), // sc_proof
      be('notes.pdf', 'progress_notes', 'normal', 60, 4),          // clinical
      be('personnel.pdf', 'personnel_record', 'high_signal', 75, 20), // other
    ];
    const r = applyPackPageBudget(entries);
    // doctor-pack grounded pages, 2026-06-13 (E2): budget 15. floor: notes 4; caps: sc_proof ->
    // rating 4; leftover 7 by rank: rating (importance 100) +6 = 10 full, personnel ('other',
    // global rank only) +1 = 1. Total 4+10+1 = 15.
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')?.pageCount).toBe(4);
    expect(r.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(10);
    expect(r.entries.find((e) => e.filePath === 'personnel.pdf')?.pageCount).toBe(1);
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET);
  });
});

// ============ DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26, dark): per-category floors + 30pp budget ============
// Flag ON ⇒ 30-page budget, every REPRESENTED category gets a presence-gated, NOT-back-fillable
// floor, BudgetEntry.packCategory overrides the docType map. Flag OFF ⇒ byte-identical (15-page
// budget, clinical-only floor, packCategory IGNORED).
describe('applyPackPageBudget — DOCTOR_PACK_CATEGORY_FLOORS (flag ON)', () => {
  const ORIGINAL = process.env['DOCTOR_PACK_CATEGORY_FLOORS'];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['DOCTOR_PACK_CATEGORY_FLOORS'];
    else process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = ORIGINAL;
  });

  it('per-category floors survive contention: every represented category keeps at least its floor', () => {
    process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = 'on';
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 40), // sc_proof — wants the whole budget
      be('notes.pdf', 'progress_notes', 'normal', 60, 10),          // clinical floor 3
      be('denial.pdf', 'denial_letter', 'high_signal', 100, 10),    // denial floor 2
      be('sleep.pdf', 'sleep_study', 'high_signal', 85, 10),        // tests floor 2
      be('lay.pdf', 'lay_statement', 'high_signal', 70, 10),        // lay floor 1
    ];
    const r = applyPackPageBudget(entries); // default budget = 30 (flag on)
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET_CATEGORY_FLOORS); // 30
    const count = (p: string) => r.entries.find((e) => e.filePath === p)?.pageCount ?? 0;
    // No category starved: each keeps >= its floor even though the rating decision would take all 30.
    expect(count('notes.pdf')).toBeGreaterThanOrEqual(3);
    expect(count('denial.pdf')).toBeGreaterThanOrEqual(2);
    expect(count('rating.pdf')).toBeGreaterThanOrEqual(2);
    expect(count('sleep.pdf')).toBeGreaterThanOrEqual(2);
    expect(count('lay.pdf')).toBeGreaterThanOrEqual(1);
    // All five categories present (none dropped to zero).
    expect(r.entries).toHaveLength(5);
  });

  it('presence-gating: an ABSENT denial category reserves NO budget — the full 30 goes to present categories', () => {
    process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = 'on';
    const entries = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 40), // sc_proof
      be('notes.pdf', 'progress_notes', 'normal', 60, 5),          // clinical
    ];
    const r = applyPackPageBudget(entries);
    // If the denial/tests/lay floors were (wrongly) reserved despite absence, the budget would be
    // under-allocated. Presence-gated ⇒ the full budget lands on the two present categories.
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET_CATEGORY_FLOORS);
    expect(r.entries.some((e) => e.filePath === 'notes.pdf')).toBe(true);
    expect(r.entries.some((e) => e.filePath === 'rating.pdf')).toBe(true);
  });

  it('NOT back-fillable: a clinical floor of 3 with only 1 clinical page keeps 1 (never steals sc_proof pages)', () => {
    process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = 'on';
    const entries = [
      be('notes.pdf', 'progress_notes', 'normal', 60, 1),          // clinical — only 1 page available
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 40), // sc_proof
    ];
    const r = applyPackPageBudget(entries);
    // The clinical floor (3) is NOT satisfied by borrowing sc_proof pages — clinical keeps its 1.
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')?.pageCount).toBe(1);
    expect(r.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(PACK_PAGE_BUDGET_CATEGORY_FLOORS - 1); // 29
    expect(r.postTrimPageCount).toBe(PACK_PAGE_BUDGET_CATEGORY_FLOORS);
  });

  it('an explicit packCategory OVERRIDES the docType map (a mislabeled doc routes to its real category)', () => {
    process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = 'on';
    // personnel_record normally maps to 'other' (no floor) — under heavy contention it would get
    // nothing. Stamped packCategory 'sc_proof' it earns the sc_proof floor and survives, even as a
    // giant clinical doc tries to consume the whole budget.
    const entries = [
      be('big_clinical.pdf', 'progress_notes', 'high_signal', 100, 40),
      { ...be('mislabeled.pdf', 'personnel_record', 'high_signal', 75, 10), packCategory: 'sc_proof' as PackCategory },
    ];
    const r = applyPackPageBudget(entries);
    // The override gives the personnel doc the sc_proof floor (2) — it is the only sc_proof doc, so
    // the floor protects it from the budget-eating clinical doc. Without the override it would be
    // 'other' (no floor) and get nothing.
    expect(r.entries.find((e) => e.filePath === 'mislabeled.pdf')?.pageCount).toBeGreaterThanOrEqual(2);
  });
});

describe('applyPackPageBudget — flag OFF is byte-identical (packCategory ignored, 15-page budget)', () => {
  const ORIGINAL = process.env['DOCTOR_PACK_CATEGORY_FLOORS'];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['DOCTOR_PACK_CATEGORY_FLOORS'];
    else process.env['DOCTOR_PACK_CATEGORY_FLOORS'] = ORIGINAL;
  });

  it('flag OFF: packCategory is IGNORED and the budget is the legacy 15', () => {
    delete process.env['DOCTOR_PACK_CATEGORY_FLOORS'];
    const base = [
      be('rating.pdf', 'rating_decision', 'high_signal', 100, 8),
      be('dbq.pdf', 'dbq', 'high_signal', 90, 6),
      be('audio.pdf', 'audiogram', 'high_signal', 80, 4),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 10),
    ];
    // The SAME entries with a bogus packCategory stamped on every one.
    const withBogusCat = base.map((e) => ({ ...e, packCategory: 'lay' as PackCategory }));
    const a = applyPackPageBudget(base);
    const b = applyPackPageBudget(withBogusCat);
    // packCategory must make ZERO difference when the flag is off.
    expect(b.entries.map((e) => [e.filePath, e.pageCount])).toEqual(a.entries.map((e) => [e.filePath, e.pageCount]));
    // ...and the legacy 15-page budget is what governs (not 30).
    expect(a.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
    expect(a.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(8);
    expect(a.entries.find((e) => e.filePath === 'dbq.pdf')?.pageCount).toBe(5);
    expect(a.entries.find((e) => e.filePath === 'notes.pdf')).toBeUndefined();
  });
});

describe('buildCategoryAssertionLines — cover coverage checklist', () => {
  it('renders surviving pages per category and an explicit NOT-FOUND / NONE-ON-FILE marker when absent', () => {
    const lines = buildCategoryAssertionLines(
      [{ category: 'clinical' as PackCategory, displayLabel: 'Clinical notes', pageRanges: [{ from: 2, to: 3 }] }],
      { docType: 'sleep_study', label: 'Sleep study (polysomnography / AHI)' },
    );
    expect(lines[0]).toBe('Clinical diagnosis: Clinical notes (p2-3)');
    // sc_proof + the defining study are absent ⇒ NOT FOUND IN CHART; denial + lay ⇒ NONE ON FILE.
    expect(lines[1]).toBe('VA service-connected proof: NOT FOUND IN CHART');
    expect(lines[2]).toBe('Prior denial: NONE ON FILE');
    expect(lines[3]).toBe('Defining study (Sleep study (polysomnography / AHI)): NOT FOUND IN CHART');
    expect(lines[4]).toBe('Lay statement: NONE ON FILE');
  });

  it('no expected study ⇒ the defining-study line reads "not applicable"', () => {
    const lines = buildCategoryAssertionLines([], null);
    expect(lines[3]).toBe('Defining study: not applicable for this claimed condition');
  });
});

describe('computeDroppedCategoryWarnings', () => {
  it('fires for a category present pre-budget but with zero survivors', () => {
    const warnings = computeDroppedCategoryWarnings(
      new Map<PackCategory, number>([['sc_proof', 2], ['clinical', 1]]),
      new Set<PackCategory>(['clinical']),
    );
    expect(warnings).toEqual(['category sc_proof: all 2 document(s) dropped by the page budget']);
  });

  it('emits nothing when every present category survived', () => {
    const warnings = computeDroppedCategoryWarnings(
      new Map<PackCategory, number>([['clinical', 1]]),
      new Set<PackCategory>(['clinical']),
    );
    expect(warnings).toEqual([]);
  });
});

describe('expectedStudyForCondition', () => {
  it('maps OSA → sleep_study, tinnitus → audiogram, asthma → PFT; unknown → null', () => {
    expect(expectedStudyForCondition('obstructive sleep apnea')?.docType).toBe('sleep_study');
    expect(expectedStudyForCondition('tinnitus')?.docType).toBe('audiogram');
    expect(expectedStudyForCondition('asthma')?.docType).toBe('pulmonary_function_test');
    expect(expectedStudyForCondition('lumbar strain')).toBeNull();
    expect(expectedStudyForCondition('')).toBeNull();
    expect(expectedStudyForCondition(null)).toBeNull();
  });
});

describe('assembleDoctorPackManifest (composite)', () => {
  it('produces a complete manifest from a realistic OSA-secondary case', () => {
    // Simulated PTSD -> OSA secondary case with realistic record set.
    const m = assembleDoctorPackManifest({
      classifiedFiles: [
        { filePath: 'records/DD-214.pdf',                fileSha256: 'a'.repeat(64), pageCount: 2 },
        { filePath: 'records/ClaimLetter-2024-3-12.pdf', fileSha256: 'b'.repeat(64), pageCount: 18 },
        { filePath: 'records/DBQ-PTSD-2023.pdf',         fileSha256: 'c'.repeat(64), pageCount: 8 },
        { filePath: 'records/PSG-Sleep-Study-2024.pdf',  fileSha256: 'd'.repeat(64), pageCount: 4 },
        { filePath: 'records/Audiogram-2024.pdf',        fileSha256: 'e'.repeat(64), pageCount: 2 },
        { filePath: 'records/Lay_Statement_Spouse.pdf',  fileSha256: 'f'.repeat(64), pageCount: 1 },
        { filePath: 'records/Blue_Button_VA_Records.pdf', fileSha256: 'g'.repeat(64), pageCount: 412 },
        { filePath: 'records/random_old_report.pdf',     fileSha256: 'h'.repeat(64), pageCount: 6 },
      ],
      readStatuses: [],
    });

    // Blue Button (bulk) excluded; all 7 others included.
    expect(m.keyDocCount).toBe(7);
    // Total = 2 + 18 + 8 + 4 + 2 + 1 + 6 = 41 pages.
    expect(m.totalPageCount).toBe(41);
    // Rating decision sorts first (importance 100), DD-214 + sleep study near the top.
    expect(m.entries[0]?.docType).toBe('rating_decision');
    // Blue Button is NOT in the manifest at all.
    expect(m.entries.some((e) => e.filePath.includes('Blue_Button'))).toBe(false);
  });
});
