import { describe, expect, it } from 'vitest';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  buildManifest,
  DOCTOR_PACK_ENGINE_VERSION,
  PACK_PAGE_BUDGET,
  PACK_PAGE_TARGET,
  selectKeyDocs,
  type BudgetEntry,
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
  // attempt under the word floor) stays excluded.
  it('still excludes a manual_summary_required file whose last attempt fails current thresholds', () => {
    const unreadable: FileReadStatusRecord = {
      ...readStatusRow('fax_cover.pdf', 'manual_summary_required'),
      attemptsJson: [
        { method: 'tesseract_ocr', wordCount: 4, corruptedTokenRatio: 0.0, note: null },
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
    // rating (protected) + dbq + audio = 18 pages keep everything; notes gets the 2 leftover.
    expect(r.entries.find((e) => e.filePath === 'rating.pdf')?.pageCount).toBe(8);
    expect(r.entries.find((e) => e.filePath === 'dbq.pdf')?.pageCount).toBe(6);
    expect(r.entries.find((e) => e.filePath === 'audio.pdf')?.pageCount).toBe(4);
    expect(r.entries.find((e) => e.filePath === 'notes.pdf')?.pageCount).toBe(2);
    expect(r.trimmedFilePaths).toEqual(['notes.pdf']);
    expect(r.trimNotes.join(' ')).toContain('notes.pdf: kept 2 of 10');
  });

  // Architect QA IMPORTANT-1 (2026-06-11): a legacy whole-doc entry (no per-page OCR + null
  // Document.pageCount -> pageRanges []) has pageCount 0, so the take===0 branch used to DROP it
  // from any over-budget pack - silently losing an entire document the assembler would otherwise
  // ship whole. It must pass through untrimmed instead.
  it('over budget: an incoming empty-ranges whole-doc entry survives untrimmed (passthrough)', () => {
    const entries = [
      be('legacy_va_letter.pdf', 'denial_letter', 'high_signal', 100, 0), // pageRanges [] via be()
      be('dbq.pdf', 'dbq', 'high_signal', 90, 15),
      be('notes.pdf', 'progress_notes', 'bulk', 35, 10),
    ];
    const r = applyPackPageBudget(entries);
    expect(r.trimmed).toBe(true);
    const survivor = r.entries.find((e) => e.filePath === 'legacy_va_letter.pdf');
    expect(survivor).toBeDefined();
    expect(survivor?.pageRanges).toEqual([]); // still the whole-doc shape for the assembler
    expect(r.trimmedFilePaths).not.toContain('legacy_va_letter.pdf');
    expect(r.trimNotes.join(' ')).toContain('legacy_va_letter.pdf: whole-doc passthrough');
  });

  it('NEVER trims the SC-decision docs first, even against higher-importance non-protected docs', () => {
    const entries = [
      be('rated_view.pdf', 'rated_disabilities_view', 'high_signal', 95, 12),
      be('denial.pdf', 'denial_letter', 'high_signal', 100, 14),
    ];
    const r = applyPackPageBudget(entries);
    // denial (protected) keeps all 14; rated_view (95, unprotected) gets the remaining 6.
    expect(r.entries.find((e) => e.filePath === 'denial.pdf')?.pageCount).toBe(14);
    expect(r.entries.find((e) => e.filePath === 'rated_view.pdf')?.pageCount).toBe(6);
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
