import { describe, expect, it } from 'vitest';
import {
  assembleDoctorPackManifest,
  buildManifest,
  DOCTOR_PACK_ENGINE_VERSION,
  PACK_PAGE_TARGET,
  selectKeyDocs,
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
    manualSummary: terminalStatus === 'manual_summary_provided' ? 'RN reviewed and summarized this file' : null,
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
