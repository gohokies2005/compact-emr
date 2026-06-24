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

// ---- card-honesty: extraction did not finish (2026-06-23) --------------------
// The false "100% Complete" bug: OCR ("pages read") finishing 100% does NOT mean the SEMANTIC
// extraction run finished. If the LATEST run failed / is queued / is running, the structured chart is
// incomplete and the card must NOT say "Complete". (Herman CLM-E9FEC31D99 root cause.)

describe('computeExtractionCoverage — extraction did not finish (card honesty)', () => {
  const docs = () => [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 }), doc({ id: 'D2', s3Key: KEY2, pageCount: 7 })];
  const allRead = () => [frs({ filePath: KEY1, terminalStatus: 'read' }), frs({ filePath: KEY2, terminalStatus: 'read' })];

  it('latest run FAILED → status failed, NOT complete (even with all pages read)', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'failed' });
    expect(cov.status).toBe('failed');
    expect(cov.status).not.toBe('complete');
  });

  it('latest run QUEUED (re-enqueued/stuck) → complete_with_gaps + extraction_incomplete gap, NOT complete', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'queued' });
    expect(cov.status).toBe('complete_with_gaps');
    expect(cov.status).not.toBe('complete');
    expect(cov.gaps.some((g) => g.reason === 'extraction_incomplete')).toBe(true);
  });

  it('latest run RUNNING → in_progress, NOT complete', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'running' });
    expect(cov.status).toBe('in_progress');
    expect(cov.gaps.some((g) => g.reason === 'extraction_incomplete')).toBe(true);
  });

  it('latest run COMPLETE with all pages read → still 100% complete (no false-positive gap)', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'complete' });
    expect(cov.status).toBe('complete');
    expect(cov.gaps.some((g) => g.reason === 'extraction_incomplete')).toBe(false);
  });
});

// ---- TWO-STAGE honesty model (Ryan 2026-06-23) -------------------------------
// The card + SOAP banner read pagesRead (OCR) and chartAnalysis (semantic extract) as two distinct, plainly-
// labeled stages from ONE coverage object, so a failed analysis can never hide behind a 100% pages-read number.
describe('computeExtractionCoverage — two-stage (Pages read + Chart analysis)', () => {
  const docs = () => [doc({ id: 'D1', s3Key: KEY1, pageCount: 5, filename: 'DD-214.pdf' }), doc({ id: 'D2', s3Key: KEY2, pageCount: 1200, filename: 'VA Blue Button Records.pdf' })];
  const allRead = () => [frs({ filePath: KEY1, terminalStatus: 'read' }), frs({ filePath: KEY2, terminalStatus: 'read' })];

  it('all read + analysis complete → pagesRead 100%, chartAnalysis complete with findings count', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'complete', resultJson: { items: new Array(253), gaps: { uncoveredPages: 0, truncatedWindows: 0 } } });
    expect(cov.pagesRead.pct).toBe(100);
    expect(cov.pagesRead.label).toBe('100% (1205 of 1205)');
    expect(cov.chartAnalysis.state).toBe('complete');
    expect(cov.chartAnalysis.label).toBe('✓ Complete (253 findings)');
    expect(cov.chartAnalysis.findings).toBe(253);
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull(); // nothing to blame when complete
  });

  it('OCR 100% but analysis QUEUED (in flight) → chartAnalysis in_progress "Analyzing…", NOT a "didn\'t finish — retry" (Ryan 2026-06-24)', () => {
    // A queued run is waiting for / running on the worker — NOT a failure. Labeling it "didn't finish — retry"
    // cried wolf on every first chart load and trained RNs to reprocess needlessly. It reads as "Analyzing…" so
    // the card self-heals when the run lands; only a genuinely-FAILED run (swept by the 45-min watcher) says re-run.
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'queued' });
    expect(cov.pagesRead.pct).toBe(100); // the OCR stage genuinely finished
    expect(cov.chartAnalysis.state).toBe('in_progress');
    expect(cov.chartAnalysis.label).toMatch(/analyzing/i);
    expect(cov.chartAnalysis.reason).toMatch(/still running/i);
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull(); // never blame a file on an in-flight run
  });

  it('analysis FAILED → chartAnalysis failed with a re-run label', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'failed' });
    expect(cov.chartAnalysis.state).toBe('failed');
    expect(cov.chartAnalysis.label).toMatch(/failed/i);
    expect(cov.chartAnalysis.likelyCauseFile).toBe('VA Blue Button Records.pdf');
  });

  it('analysis RUNNING → chartAnalysis in_progress (no cause file blamed mid-run)', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'running' });
    expect(cov.chartAnalysis.state).toBe('in_progress');
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull();
  });

  // NEAR-COMPLETE TOLERANCE (Ryan 2026-06-24, Fitton CLM-4EC87FD0C4): a COMPLETED run that left only a SMALL
  // shortfall on a large chart (≥90% analyzed) is 'complete' WITH a caution (minorGap) — NOT 'incomplete'. 16 of
  // 3029 pages must not force the case provisional or block the SOAP. The 1205-page fixture with 12 uncovered = 99%.
  it('completed run, SMALL shortfall on a large chart (≥90%) → chartAnalysis complete WITH minorGap (caution, not provisional)', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'complete', resultJson: { items: new Array(10), gaps: { uncoveredPages: 12, truncatedWindows: 0 } } });
    expect(cov.coveragePct).toBe(99);
    expect(cov.chartAnalysis.state).toBe('complete'); // proceeds — verdict not provisional, no red banner
    expect(cov.chartAnalysis.minorGap).toBe(true);
    expect(cov.chartAnalysis.label).toMatch(/mostly complete/i);
    expect(cov.chartAnalysis.label).toMatch(/99% analyzed/i);
    expect(cov.chartAnalysis.reason).toMatch(/12 pages were not folded/i);
    expect(cov.chartAnalysis.reason).toMatch(/nearly complete/i);
  });

  it('completed run, LARGE shortfall (<90% analyzed) → chartAnalysis incomplete (provisional), minorGap false', () => {
    // 200 of 1205 pages uncovered → 83% analyzed, below the 90% floor → stays the prior provisional behavior.
    const cov = computeExtractionCoverage(docs(), allRead(), { status: 'complete', resultJson: { items: new Array(10), gaps: { uncoveredPages: 200, truncatedWindows: 0 } } });
    expect(cov.coveragePct).toBeLessThan(90);
    expect(cov.chartAnalysis.state).toBe('incomplete');
    expect(cov.chartAnalysis.minorGap).toBe(false);
    expect(cov.chartAnalysis.label).toMatch(/some pages weren’t fully analyzed/i);
    expect(cov.chartAnalysis.reason).toMatch(/200 pages were not folded/i);
  });

  // SIZE-AWARE floor (clinical-safety QA 2026-06-24): on a SMALL chart (≤50 pages) a few missing pages is more
  // likely to be the load-bearing document, so we require near-complete (95%) before softening — 90% is NOT
  // enough on a tiny chart. A 30-page chart with 3 uncovered (90%) stays provisional; 1 uncovered (97%) cautions.
  const smallDocs = () => [doc({ id: 'S1', s3Key: KEY1, pageCount: 30, filename: 'C&P exam.pdf' })];
  const smallRead = () => [frs({ filePath: KEY1, terminalStatus: 'read' })];

  it('SMALL chart (30pp), 3 uncovered = 90% → stays incomplete (below the 95% small-chart floor), NOT softened', () => {
    const cov = computeExtractionCoverage(smallDocs(), smallRead(), { status: 'complete', resultJson: { items: new Array(5), gaps: { uncoveredPages: 3, truncatedWindows: 0 } } });
    expect(cov.coveragePct).toBe(90);
    expect(cov.chartAnalysis.state).toBe('incomplete');
    expect(cov.chartAnalysis.minorGap).toBe(false);
  });

  it('SMALL chart (30pp), 1 uncovered = 97% → softened to complete WITH minorGap (above the 95% small-chart floor)', () => {
    const cov = computeExtractionCoverage(smallDocs(), smallRead(), { status: 'complete', resultJson: { items: new Array(5), gaps: { uncoveredPages: 1, truncatedWindows: 0 } } });
    expect(cov.coveragePct).toBe(97);
    expect(cov.chartAnalysis.state).toBe('complete');
    expect(cov.chartAnalysis.minorGap).toBe(true);
  });
});

// ---- cry-wolf fix: not_analyzed for new/empty cases (2026-06-23) -------------
// A brand-new case (no analysis run on record yet → runStatus null) or an empty case (no chart inputs) must read
// as 'not_analyzed' — NOT 'incomplete'. not_analyzed must NOT fire the SOAP banner, mark provisional, or name a
// likelyCauseFile. Only a REAL unfinished run (queued/running), a failed run, or a completed-with-gaps run warns.
describe('computeExtractionCoverage — not_analyzed (cry-wolf fix)', () => {
  const docs = () => [doc({ id: 'D1', s3Key: KEY1, pageCount: 5, filename: 'DD-214.pdf' }), doc({ id: 'D2', s3Key: KEY2, pageCount: 1200, filename: 'VA Blue Button Records.pdf' })];
  const allRead = () => [frs({ filePath: KEY1, terminalStatus: 'read' }), frs({ filePath: KEY2, terminalStatus: 'read' })];

  it('no analysis run yet (latestRun null) with OCR settled → chartAnalysis not_analyzed, NOT incomplete, no cause file', () => {
    const cov = computeExtractionCoverage(docs(), allRead(), null);
    expect(cov.chartAnalysis.state).toBe('not_analyzed');
    expect(cov.chartAnalysis.state).not.toBe('incomplete');
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull(); // never blame a file on a never-ran case
    expect(cov.chartAnalysis.reason).toBeNull();
    // must NOT have raised an extraction_incomplete gap (that would fire the banner)
    expect(cov.gaps.some((g) => g.reason === 'extraction_incomplete')).toBe(false);
    expect(cov.status).toBe('complete'); // pages all read, nothing pending → vacuously complete
  });

  it('empty case (no chart inputs) → not_analyzed, vacuously complete, no banner, no cause file', () => {
    const cov = computeExtractionCoverage([], [], null);
    expect(cov.chartAnalysis.state).toBe('not_analyzed');
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull();
    expect(cov.status).toBe('complete');
  });

  it('null run but OCR still in progress → in_progress (genuinely working), not not_analyzed', () => {
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })]; // D2 has no row yet → OCR in progress
    const cov = computeExtractionCoverage(docs(), rows, null);
    expect(cov.chartAnalysis.state).toBe('in_progress');
    expect(cov.chartAnalysis.likelyCauseFile).toBeNull();
  });

  it('SSOT invariant: a complete status never carries a non-complete/non-not_analyzed analysis state', () => {
    // Cover every status the function can emit and assert the invariant holds (the function also throws if violated).
    for (const run of [null, { status: 'complete' }, { status: 'failed' }, { status: 'queued' }, { status: 'running' }] as const) {
      const cov = computeExtractionCoverage(docs(), allRead(), run);
      if (cov.status === 'complete') {
        expect(['complete', 'not_analyzed']).toContain(cov.chartAnalysis.state);
      }
    }
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
