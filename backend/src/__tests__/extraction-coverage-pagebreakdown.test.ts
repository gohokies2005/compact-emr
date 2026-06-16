import { describe, it, expect } from 'vitest';
import {
  computeExtractionCoverage,
  computePageCoverageBreakdown,
  type CoverageDocInput,
  type PageProvenanceInput,
} from '../services/extraction-coverage.js';

// Per-page vision breakdown (vision rebuild 2026-06-16). Locks the honest-coverage contract:
// partial/illegible pages surface for review, 'full' pages are clean, 'blank' is silent, and pages
// with NO signal (Textract/native/legacy) never enter the breakdown (→ null for non-vision charts).

const doc = (id: string, name: string): CoverageDocInput => ({ id, s3Key: `cases/c1/${id}-${name}.pdf`, filename: `${name}.pdf`, pageCount: null });
const page = (documentId: string, pageNumber: number, extractionCoverage: string | null, handwritingPresent: boolean | null = null): PageProvenanceInput =>
  ({ documentId, pageNumber, extractionCoverage, handwritingPresent });

describe('computePageCoverageBreakdown', () => {
  it('returns null when NO page carries a vision signal (Textract/native/legacy chart)', () => {
    const docs = [doc('d1', 'note')];
    const pages = [page('d1', 1, null), page('d1', 2, null)];
    expect(computePageCoverageBreakdown(docs, pages)).toBeNull();
  });

  it('buckets full/partial/illegible/blank and lists ONLY partial+illegible for review (blanks silent)', () => {
    const docs = [doc('d1', 'enc7'), doc('d2', 'enc3')];
    const pages = [
      page('d1', 1, 'full', false),
      page('d1', 2, 'full', false),
      page('d1', 3, 'full', false),
      page('d2', 1, 'partial', true), // the confabulation page → handwriting_uncertain, listed
      page('d2', 2, 'blank', false), // verified blank → silent, NOT in reviewPages
      page('d2', 3, 'illegible', true), // unreadable → listed
    ];
    const b = computePageCoverageBreakdown(docs, pages)!;
    expect(b.pagesWithSignal).toBe(6);
    expect(b.clean).toBe(3);
    expect(b.handwritingUncertain).toBe(1);
    expect(b.blank).toBe(1);
    expect(b.unreadable).toBe(1);
    expect(b.reviewPages).toHaveLength(2); // partial + illegible only; blank excluded
    expect(b.reviewPages.map((r) => r.reason).sort()).toEqual(['handwriting_uncertain', 'unreadable']);
    expect(b.reviewPages.find((r) => r.reason === 'handwriting_uncertain')).toMatchObject({ documentId: 'd2', pageNumber: 1, fileName: 'enc3.pdf' });
  });

  it('a full page WITH handwriting is clean (captured), not flagged for review', () => {
    const docs = [doc('d1', 'form')];
    const b = computePageCoverageBreakdown(docs, [page('d1', 1, 'full', true)])!;
    expect(b.clean).toBe(1);
    expect(b.handwritingUncertain).toBe(0);
    expect(b.reviewPages).toHaveLength(0);
  });

  it('excludes pages of non-chart-input docs (screening-summary / _rendered)', () => {
    const docs: CoverageDocInput[] = [
      { id: 'd1', s3Key: 'cases/c1/00000000-screening-summary.txt', pageCount: null },
      { id: 'd2', s3Key: 'cases/c1/_rendered/letter-v1.pdf', pageCount: null },
      { id: 'd3', s3Key: 'cases/c1/d3-real.pdf', pageCount: null },
    ];
    const pages = [page('d1', 1, 'partial'), page('d2', 1, 'illegible'), page('d3', 1, 'full')];
    const b = computePageCoverageBreakdown(docs, pages)!;
    expect(b.pagesWithSignal).toBe(1); // only d3
    expect(b.clean).toBe(1);
    expect(b.reviewPages).toHaveLength(0);
  });
});

describe('computeExtractionCoverage — pageBreakdown wiring', () => {
  it('attaches the breakdown; pages omitted → null (backward compatible)', () => {
    const docs = [doc('d1', 'note')];
    expect(computeExtractionCoverage(docs, [], null).pageBreakdown).toBeNull();
    const withPages = computeExtractionCoverage(docs, [], null, [page('d1', 1, 'partial', true)]);
    expect(withPages.pageBreakdown).not.toBeNull();
    expect(withPages.pageBreakdown!.handwritingUncertain).toBe(1);
  });
});
