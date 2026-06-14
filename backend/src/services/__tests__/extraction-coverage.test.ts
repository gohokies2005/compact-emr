import { describe, it, expect } from 'vitest';
import {
  computeExtractionCoverage,
  isChartInputKey,
  isRenderedOutputKey,
  type CoverageDocInput,
} from '../extraction-coverage.js';
import type { FileReadAttempt, FileReadStatusRecord, FileTerminalStatus } from '../db-types.js';

// ---- builders ----------------------------------------------------------------

function doc(over: Partial<CoverageDocInput> & { id: string; s3Key: string }): CoverageDocInput {
  return { filename: null, contentType: null, pageCount: null, ...over };
}

let seq = 1;
function frs(over: Partial<FileReadStatusRecord> & { filePath: string; terminalStatus: FileTerminalStatus }): FileReadStatusRecord {
  const now = new Date('2026-06-14T00:00:00.000Z');
  const attempts: readonly FileReadAttempt[] = over.attemptsJson ?? [];
  return {
    id: `FRS-${seq++}`,
    caseId: 'CASE-1',
    fileSha256: 'a'.repeat(64),
    manualSummary: null,
    manualSummaryAt: null,
    manualSummaryBy: null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...over,
    attemptsJson: attempts,
  };
}

const KEY1 = 'cases/CASE-1/uuid1-dd214.pdf';
const KEY2 = 'cases/CASE-1/uuid2-sleep-study.pdf';
const IMG_KEY = 'cases/CASE-1/uuid3-scan.jpg';
const SCREENING = 'cases/CASE-1/00000000-screening-summary.txt';
const RENDERED = 'cases/CASE-1/_rendered/cover-index-v3.pdf';

// ---- exclusion helpers -------------------------------------------------------

describe('exclusion helpers', () => {
  it('isRenderedOutputKey matches _rendered/ outputs only', () => {
    expect(isRenderedOutputKey(RENDERED)).toBe(true);
    expect(isRenderedOutputKey(KEY1)).toBe(false);
  });
  it('isChartInputKey drops screening-summary AND rendered outputs', () => {
    expect(isChartInputKey(KEY1)).toBe(true);
    expect(isChartInputKey(SCREENING)).toBe(false);
    expect(isChartInputKey(RENDERED)).toBe(false);
  });
});

// ---- clean chart = 100% ------------------------------------------------------

describe('computeExtractionCoverage — clean chart', () => {
  it('all files read with known page counts → 100% complete, no gaps', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 }), doc({ id: 'D2', s3Key: KEY2, pageCount: 7 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' }), frs({ filePath: KEY2, terminalStatus: 'read' })];
    const run = { status: 'complete', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 0 } } };

    const cov = computeExtractionCoverage(docs, rows, run);
    expect(cov.totalPages).toBe(12);
    expect(cov.extractedPages).toBe(12);
    expect(cov.coveragePct).toBe(100);
    expect(cov.gaps).toHaveLength(0);
    expect(cov.status).toBe('complete');
    expect(cov.unknownPageFiles).toBe(0);
    expect(cov.totalFiles).toBe(2);
  });

  it('auto_skipped + manual_summary_provided count as extracted', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 3 }), doc({ id: 'D2', s3Key: KEY2, pageCount: 2 })];
    const rows = [
      frs({ filePath: KEY1, terminalStatus: 'auto_skipped' }),
      frs({ filePath: KEY2, terminalStatus: 'manual_summary_provided', manualSummary: 'x'.repeat(50) }),
    ];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' });
    expect(cov.extractedPages).toBe(5);
    expect(cov.coveragePct).toBe(100);
    expect(cov.gaps).toHaveLength(0);
  });
});

// ---- screening-summary + rendered excluded -----------------------------------

describe('computeExtractionCoverage — exclusions', () => {
  it('screening-summary and rendered outputs are NOT counted as chart pages', () => {
    const docs = [
      doc({ id: 'D1', s3Key: KEY1, pageCount: 4 }),
      doc({ id: 'DS', s3Key: SCREENING, pageCount: 1 }),
      doc({ id: 'DR', s3Key: RENDERED, pageCount: 9 }),
    ];
    // Only KEY1 has a readiness row; the excluded docs have none and must NOT make it in_progress.
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' });
    expect(cov.totalFiles).toBe(1);
    expect(cov.totalPages).toBe(4);
    expect(cov.extractedPages).toBe(4);
    expect(cov.status).toBe('complete');
  });
});

// ---- image-only gap with isImage ---------------------------------------------

describe('computeExtractionCoverage — image gap', () => {
  it('an unread image file becomes a gap with isImage=true and reason unreadable_image', () => {
    const docs = [
      doc({ id: 'D1', s3Key: KEY1, pageCount: 5 }),
      doc({ id: 'DI', s3Key: IMG_KEY, contentType: 'image/jpeg', pageCount: 1, filename: 'scan.jpg' }),
    ];
    const rows = [
      frs({ filePath: KEY1, terminalStatus: 'read' }),
      frs({ filePath: IMG_KEY, terminalStatus: 'manual_summary_required' }),
    ];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete_with_gaps' });
    expect(cov.gaps).toHaveLength(1);
    const g = cov.gaps[0]!;
    expect(g.isImage).toBe(true);
    expect(g.reason).toBe('unreadable_image');
    expect(g.documentId).toBe('DI');
    expect(g.fileName).toBe('scan.jpg');
    expect(g.pageLabel).toBe('whole file');
    expect(cov.extractedPages).toBe(5);
    expect(cov.totalPages).toBe(6);
    expect(cov.coveragePct).toBe(83); // round(5/6*100)=83
    expect(cov.status).toBe('complete_with_gaps');
  });

  it('content-type missing but .png extension still flags isImage', () => {
    const docs = [doc({ id: 'DI', s3Key: 'cases/CASE-1/uuid-photo.PNG', pageCount: 1 })];
    const rows = [frs({ filePath: 'cases/CASE-1/uuid-photo.PNG', terminalStatus: 'manual_summary_required' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete_with_gaps' });
    expect(cov.gaps[0]!.isImage).toBe(true);
    expect(cov.gaps[0]!.reason).toBe('unreadable_image');
  });

  it('a non-image unread file gets reason needs_manual_summary, isImage=false', () => {
    const docs = [doc({ id: 'D2', s3Key: KEY2, pageCount: 3 })];
    const rows = [frs({ filePath: KEY2, terminalStatus: 'manual_summary_required' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete_with_gaps' });
    expect(cov.gaps[0]!.isImage).toBe(false);
    expect(cov.gaps[0]!.reason).toBe('needs_manual_summary');
    expect(cov.gaps[0]!.pageLabel).toBe('3 pages');
  });
});

// ---- truncated run -----------------------------------------------------------

describe('computeExtractionCoverage — run-level gaps', () => {
  it('a truncated run surfaces a truncated_dense gap', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 10 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const run = { status: 'complete_with_gaps', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 2 } } };
    const cov = computeExtractionCoverage(docs, rows, run);
    expect(cov.gaps).toHaveLength(1);
    expect(cov.gaps[0]!.reason).toBe('truncated_dense');
    expect(cov.gaps[0]!.documentId).toBeNull();
    expect(cov.gaps[0]!.pageLabel).toBe('2 dense sections');
    expect(cov.status).toBe('complete_with_gaps');
  });

  it('uncoveredPages becomes an extraction_gap and is subtracted from extractedPages', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 100 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const run = { status: 'complete_with_gaps', resultJson: { gaps: { uncoveredPages: 3, truncatedWindows: 0 } } };
    const cov = computeExtractionCoverage(docs, rows, run);
    expect(cov.totalPages).toBe(100);
    expect(cov.extractedPages).toBe(97);
    expect(cov.coveragePct).toBe(97);
    expect(cov.gaps).toHaveLength(1);
    expect(cov.gaps[0]!.reason).toBe('extraction_gap');
    expect(cov.gaps[0]!.pageLabel).toBe('3 pages');
  });
});

// ---- in-progress + honesty about unknowns ------------------------------------

describe('computeExtractionCoverage — in_progress + unknown page counts', () => {
  it('a file with no readiness row yet is in_progress, not a gap', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 }), doc({ id: 'D2', s3Key: KEY2, pageCount: 3 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })]; // D2 has no row yet
    const cov = computeExtractionCoverage(docs, rows, null);
    expect(cov.status).toBe('in_progress');
    expect(cov.gaps).toHaveLength(0);
    expect(cov.extractedPages).toBe(5);
  });

  it('a failed run reports status failed', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'failed' });
    expect(cov.status).toBe('failed');
  });

  it('unknown page counts → counts as 1 unit each, never claims 100%, reports unknownPageFiles', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: null }), doc({ id: 'D2', s3Key: KEY2, pageCount: null })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' }), frs({ filePath: KEY2, terminalStatus: 'read' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' });
    expect(cov.totalPages).toBe(2); // 1 unit each
    expect(cov.extractedPages).toBe(2);
    expect(cov.unknownPageFiles).toBe(2);
    expect(cov.coveragePct).toBe(99); // capped — never fake 100% when counts are unknown
    expect(cov.status).toBe('complete_with_gaps');
  });

  it('empty chart (no inputs) is vacuously 100% complete', () => {
    const cov = computeExtractionCoverage([], [], null);
    expect(cov.totalPages).toBe(0);
    expect(cov.coveragePct).toBe(100);
    expect(cov.status).toBe('complete');
    expect(cov.totalFiles).toBe(0);
  });
});
