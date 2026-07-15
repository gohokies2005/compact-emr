import { describe, it, expect } from 'vitest';
import {
  computeExtractionCoverage,
  computeRelevanceSummary,
  isChartInputKey,
  isRenderedOutputKey,
  selectAuthoritativeExtractionRun,
  type CoverageDocInput,
  type CoverageGap,
  type ExtractionRunLite,
  type KeyDocClassInput,
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

// ---- RELEVANCE-AWARE framing (Dr. Kasky #76) ---------------------------------
// A bare "38% extracted" scares an RN off a fine case. We reframe by RELEVANCE using the EXISTING Doctor-Pack
// KeyDoc classification (high_signal = claim-relevant). HONEST: a missed KEY doc is surfaced as a gap that
// MATTERS (never softened); only bulk/normal/unclassified unread is "safely skippable". Fail-open (null) when
// no classification exists. No new relevance model is invented.

const RATING = 'cases/CASE-1/uuid-rating-decision.pdf';
const STR = 'cases/CASE-1/uuid-str.pdf';
const BLUE = 'cases/CASE-1/uuid-blue-button.pdf';
const DUP = 'cases/CASE-1/uuid-duplicate-scan.pdf';

function keyDoc(over: Partial<KeyDocClassInput> & { filePath: string }): KeyDocClassInput {
  return { docType: 'rating_decision', classification: 'high_signal', importance: 100, ...over };
}

describe('computeRelevanceSummary (pure)', () => {
  it('relevant docs READ + irrelevant pages skipped → reassuring, gap NOT flagged as a key gap', () => {
    const inputs = [
      doc({ id: 'DR', s3Key: RATING, pageCount: 12, filename: 'Rating Decision.pdf' }),
      doc({ id: 'DS', s3Key: STR, pageCount: 40, filename: 'STR.pdf' }),
      doc({ id: 'DB', s3Key: BLUE, pageCount: 80, filename: 'Blue Button.pdf' }),
    ];
    // Only the Blue Button bulk dump is gapped (unread); both KEY docs were read.
    const gaps: CoverageGap[] = [
      { documentId: 'DB', fileName: 'Blue Button.pdf', reason: 'needs_manual_summary', pageLabel: '80 pages', isImage: false, terminalStatus: 'manual_summary_required' },
    ];
    const classes = new Map<string, KeyDocClassInput>([
      [RATING, keyDoc({ filePath: RATING, docType: 'rating_decision' })],
      [STR, keyDoc({ filePath: STR, docType: 'service_treatment_record_summary', importance: 80 })],
      [BLUE, keyDoc({ filePath: BLUE, docType: 'blue_button', classification: 'bulk', importance: 30 })],
    ]);
    const rel = computeRelevanceSummary(inputs, gaps, classes)!;
    expect(rel).not.toBeNull();
    expect(rel.allKeyDocsRead).toBe(true); // earns the reassurance
    expect(rel.keyDocGaps).toHaveLength(0); // NO key gap — the unread doc is bulk, not key
    expect(rel.keyDocsRead.map((d) => d.docType)).toEqual(['rating_decision', 'service_treatment_record_summary']);
    expect(rel.keyPagesRead).toBe(52); // 12 + 40
    expect(rel.keyPagesApproximate).toBe(false);
    expect(rel.skippableGaps).toHaveLength(1);
    expect(rel.skippableGaps[0]!.fileName).toBe('Blue Button.pdf');
  });

  it('a RELEVANT/key doc UNREAD → flagged as a key gap, allKeyDocsRead FALSE (gap NOT hidden)', () => {
    const inputs = [
      doc({ id: 'DR', s3Key: RATING, pageCount: 12, filename: 'Rating Decision.pdf' }),
      doc({ id: 'DS', s3Key: STR, pageCount: 40, filename: 'STR.pdf' }),
    ];
    // The rating decision (a KEY doc) is gapped — this MUST surface prominently.
    const gaps: CoverageGap[] = [
      { documentId: 'DR', fileName: 'Rating Decision.pdf', reason: 'unread', pageLabel: '12 pages', isImage: false, terminalStatus: 'manual_summary_required' },
    ];
    const classes = new Map<string, KeyDocClassInput>([
      [RATING, keyDoc({ filePath: RATING, docType: 'rating_decision' })],
      [STR, keyDoc({ filePath: STR, docType: 'service_treatment_record_summary', importance: 80 })],
    ]);
    const rel = computeRelevanceSummary(inputs, gaps, classes)!;
    expect(rel.allKeyDocsRead).toBe(false); // reassurance WITHHELD
    expect(rel.keyDocGaps).toHaveLength(1);
    expect(rel.keyDocGaps[0]!.docType).toBe('rating_decision');
    expect(rel.keyDocGaps[0]!.fileName).toBe('Rating Decision.pdf');
    expect(rel.keyDocGaps[0]!.key).toBe(true);
    expect(rel.keyDocsRead.map((d) => d.docType)).toEqual(['service_treatment_record_summary']);
  });

  it('NO classification for any input → null (fail-open to the honest %)', () => {
    const inputs = [doc({ id: 'DX', s3Key: DUP, pageCount: 80, filename: 'scan.pdf' })];
    const rel = computeRelevanceSummary(inputs, [], new Map());
    expect(rel).toBeNull();
  });

  it('a read KEY doc with an UNKNOWN page count → keyPagesApproximate true, never inflates the count', () => {
    const inputs = [doc({ id: 'DR', s3Key: RATING, pageCount: null, filename: 'Rating Decision.pdf' })];
    const classes = new Map<string, KeyDocClassInput>([[RATING, keyDoc({ filePath: RATING })]]);
    const rel = computeRelevanceSummary(inputs, [], classes)!;
    expect(rel.allKeyDocsRead).toBe(true);
    expect(rel.keyPagesRead).toBe(0); // unknown count contributes 0, not a fabricated total
    expect(rel.keyPagesApproximate).toBe(true);
  });

  it('only skippable docs (no key doc present at all) → allKeyDocsRead FALSE (reassurance not earned)', () => {
    const inputs = [doc({ id: 'DB', s3Key: BLUE, pageCount: 80, filename: 'Blue Button.pdf' })];
    const classes = new Map<string, KeyDocClassInput>([[BLUE, keyDoc({ filePath: BLUE, docType: 'blue_button', classification: 'bulk', importance: 30 })]]);
    const rel = computeRelevanceSummary(inputs, [], classes)!;
    expect(rel.allKeyDocsRead).toBe(false); // no key doc was read → can't claim "we read what matters"
    expect(rel.keyDocsRead).toHaveLength(0);
    expect(rel.keyDocGaps).toHaveLength(0);
  });
});

describe('computeExtractionCoverage — relevance wiring + fail-open', () => {
  it('passes KeyDoc classes through to a relevance summary on the coverage object', () => {
    const docs = [
      doc({ id: 'DR', s3Key: RATING, pageCount: 12, filename: 'Rating Decision.pdf' }),
      doc({ id: 'DB', s3Key: BLUE, pageCount: 80, filename: 'Blue Button.pdf' }),
    ];
    const rows = [
      frs({ filePath: RATING, terminalStatus: 'read' }),
      frs({ filePath: BLUE, terminalStatus: 'manual_summary_required' }), // bulk unread → skippable
    ];
    const classes: KeyDocClassInput[] = [
      keyDoc({ filePath: RATING, docType: 'rating_decision' }),
      keyDoc({ filePath: BLUE, docType: 'blue_button', classification: 'bulk', importance: 30 }),
    ];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' }, [], classes);
    expect(cov.relevance).not.toBeNull();
    expect(cov.relevance!.allKeyDocsRead).toBe(true);
    expect(cov.relevance!.keyDocGaps).toHaveLength(0);
    expect(cov.relevance!.skippableGaps.map((d) => d.fileName)).toEqual(['Blue Button.pdf']);
  });

  it('no KeyDoc classes (default arg) → relevance is null, existing behavior unchanged', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' });
    expect(cov.relevance).toBeNull();
  });

  // #76 QA FIX (in-progress wasRead hole): a key doc still mid-OCR (NO readiness row yet) was being
  // counted as READ (wasRead = !gapped), so allKeyDocsRead could falsely report an all-clear on a
  // partially-processed chart. It must be counted as NEITHER read NOR a gap until it has a read row.
  it('a key doc still in OCR (no readiness row) is NOT counted as read → allKeyDocsRead FALSE mid-pipeline', () => {
    const docs = [
      doc({ id: 'DR', s3Key: RATING, pageCount: 12, filename: 'Rating Decision.pdf' }),
      doc({ id: 'DS', s3Key: STR, pageCount: 40, filename: 'STR.pdf' }),
    ];
    // STR is read; the RATING decision has NO readiness row yet (still being OCR'd) — in-progress.
    const rows = [frs({ filePath: STR, terminalStatus: 'read' })];
    const classes: KeyDocClassInput[] = [
      keyDoc({ filePath: RATING, docType: 'rating_decision' }),
      keyDoc({ filePath: STR, docType: 'service_treatment_record_summary', importance: 80 }),
    ];
    // run still running so the no-row doc is honestly in-progress (not a failed all-clear)
    const cov = computeExtractionCoverage(docs, rows, { status: 'running' }, [], classes);
    expect(cov.relevance).not.toBeNull();
    expect(cov.relevance!.allKeyDocsRead).toBe(false); // the in-progress key doc suppresses the all-clear
    // the in-progress doc is in NEITHER list (not read, not a gap)
    expect(cov.relevance!.keyDocsRead.map((d) => d.fileName)).toEqual(['STR.pdf']);
    expect(cov.relevance!.keyDocGaps).toHaveLength(0);
    expect(cov.relevance!.skippableGaps).toHaveLength(0);
  });

  it('a truly-read key doc still counts; allKeyDocsRead TRUE once every key doc has a read row', () => {
    const docs = [
      doc({ id: 'DR', s3Key: RATING, pageCount: 12, filename: 'Rating Decision.pdf' }),
      doc({ id: 'DS', s3Key: STR, pageCount: 40, filename: 'STR.pdf' }),
    ];
    const rows = [
      frs({ filePath: RATING, terminalStatus: 'read' }),
      frs({ filePath: STR, terminalStatus: 'read' }),
    ];
    const classes: KeyDocClassInput[] = [
      keyDoc({ filePath: RATING, docType: 'rating_decision' }),
      keyDoc({ filePath: STR, docType: 'service_treatment_record_summary', importance: 80 }),
    ];
    const cov = computeExtractionCoverage(docs, rows, { status: 'complete' }, [], classes);
    expect(cov.relevance!.allKeyDocsRead).toBe(true);
    expect(cov.relevance!.keyDocsRead.map((d) => d.fileName)).toEqual(['Rating Decision.pdf', 'STR.pdf']);
    expect(cov.relevance!.keyDocGaps).toHaveLength(0);
  });
});

// ---- authoritative-run selection (Kimbrough CLM-41E9900FB8, 2026-07-14) -------
// The UI's chart-analysis state must key on the AUTHORITATIVE run, not merely the latest-CREATED row.
// During the 7/14 duplicate flood, watcher-failed duplicate rows were created AFTER the successful runs,
// so a fully-complete chart showed "✗ analysis failed".

describe('selectAuthoritativeExtractionRun — stale watcher-failure vs honest failure', () => {
  const SHA = 'f'.repeat(64);
  const OTHER_SHA = 'e'.repeat(64);
  const run = (status: string, triggerHash: string | null, resultJson: unknown = null): ExtractionRunLite =>
    ({ status, resultJson, triggerHash });

  it('FLOOD SHAPE: completed at T, watcher-failed duplicate rows created later over the SAME doc set → shows COMPLETE', () => {
    // The failed row is a forced-reprocess duplicate (`<sha>:manual:<requestId>`) of work the completed run covered.
    const failedDup = run('failed', `${SHA}:manual:req-123`);
    const completed = run('complete', SHA, { gaps: { uncoveredPages: 0, truncatedWindows: 0 } });
    const chosen = selectAuthoritativeExtractionRun(failedDup, completed);
    expect(chosen).toEqual({ status: 'complete', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 0 } } });
  });

  it('FLOOD SHAPE end-to-end: the chosen completed run drives chartAnalysis.state = complete, never failed', () => {
    const docs = [doc({ id: 'D1', s3Key: KEY1, pageCount: 5 })];
    const rows = [frs({ filePath: KEY1, terminalStatus: 'read' })];
    const chosen = selectAuthoritativeExtractionRun(
      run('failed', `${SHA}:manual:req-9`),
      run('complete', SHA, { gaps: { uncoveredPages: 0, truncatedWindows: 0 } }),
    );
    const cov = computeExtractionCoverage(docs, rows, chosen);
    expect(cov.chartAnalysis.state).toBe('complete');
  });

  it('plain (unsuffixed) duplicate base hashes also match — completed wins', () => {
    expect(selectAuthoritativeExtractionRun(run('failed', SHA), run('complete', `${SHA}:manual:req-1`))?.status).toBe('complete');
  });

  it('HONEST SHAPE: only failed runs (no completed run at all) → still FAILED', () => {
    expect(selectAuthoritativeExtractionRun(run('failed', SHA), null)).toEqual({ status: 'failed', resultJson: null });
  });

  it('HONEST SHAPE: the failed run covers a STRICTLY NEWER doc set (base hash differs) → still FAILED', () => {
    // Docs changed after the last success; the current doc set's analysis really failed — do not mask it.
    expect(selectAuthoritativeExtractionRun(run('failed', OTHER_SHA), run('complete', SHA))?.status).toBe('failed');
  });

  it('a non-failed newest run passes straight through (running/queued/complete unchanged behavior)', () => {
    expect(selectAuthoritativeExtractionRun(run('running', SHA), null)?.status).toBe('running');
    expect(selectAuthoritativeExtractionRun(run('complete', SHA, { ok: 1 }), null)).toEqual({ status: 'complete', resultJson: { ok: 1 } });
  });

  it('no runs at all → null (not_analyzed resting state preserved)', () => {
    expect(selectAuthoritativeExtractionRun(null, null)).toBeNull();
  });

  it('a defensive non-complete "completed" candidate never wins (where-clause belt-and-suspenders)', () => {
    expect(selectAuthoritativeExtractionRun(run('failed', SHA), run('failed', SHA))?.status).toBe('failed');
  });

  it('missing/empty trigger hashes never match (conservative: honest failed)', () => {
    expect(selectAuthoritativeExtractionRun(run('failed', null), run('complete', null))?.status).toBe('failed');
    expect(selectAuthoritativeExtractionRun(run('failed', ''), run('complete', ''))?.status).toBe('failed');
  });
});
