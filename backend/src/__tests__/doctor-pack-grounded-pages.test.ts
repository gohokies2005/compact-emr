import { describe, expect, it } from 'vitest';
import {
  chartFactCategoryByDocument,
  groundedSourcePagesForCase,
  type ChartFactCategoryDb,
  type GroundedPagesDb,
} from '../services/doctor-pack-grounded-pages.js';

// doctor-pack grounded pages, 2026-06-13: unit tests for the pure facts→pages back-map. The db is
// a hand-built structural mock (same style as doctor-pack-generate.test.ts) — no real Prisma. We
// pin the query SHAPE (extracted-only, non-null provenance, case-scoped documents) plus the
// dedup / ordering / representative-quote contract.

interface MockRow {
  source?: string;
  sourceDocumentId: string | null;
  sourcePage: number | null;
  sourceQuote: string | null;
  confidence?: number | null;
}

function mockDb(opts: {
  veteranId?: string | null;
  caseDocumentIds?: string[];
  sc?: MockRow[];
  problems?: MockRow[];
  meds?: MockRow[];
  capture?: { lastWhere?: unknown };
}): GroundedPagesDb {
  const norm = (rows: MockRow[] | undefined) =>
    (rows ?? []).map((r) => ({
      source: r.source ?? 'extracted',
      sourceDocumentId: r.sourceDocumentId,
      sourcePage: r.sourcePage,
      sourceQuote: r.sourceQuote,
      confidence: r.confidence ?? null,
    }));
  // The real query filters in the WHERE; the mock applies the same predicate so a query-shape
  // regression (e.g. dropping the source filter) would surface as a behavioral test failure.
  const applyWhere = (rows: ReturnType<typeof norm>, where: { veteranId: string; source: string }) =>
    rows.filter(
      (r) =>
        r.source === where.source &&
        r.sourceDocumentId !== null &&
        r.sourcePage !== null,
    );
  const findMany = (rows: MockRow[] | undefined) => async (args: { where: { veteranId: string; source: string } }) => {
    if (opts.capture) opts.capture.lastWhere = args.where;
    return applyWhere(norm(rows), args.where);
  };
  return {
    case: {
      findFirst: async (_args: unknown) =>
        opts.veteranId === null
          ? null
          : {
              veteranId: opts.veteranId ?? 'VET-1',
              documents: (opts.caseDocumentIds ?? ['DOC-A', 'DOC-B']).map((id) => ({ id })),
            },
    },
    scCondition: { findMany: findMany(opts.sc) },
    activeProblem: { findMany: findMany(opts.problems) },
    activeMedication: { findMany: findMany(opts.meds) },
  };
}

describe('groundedSourcePagesForCase', () => {
  it('returns empty when the case is not found', async () => {
    const out = await groundedSourcePagesForCase(mockDb({ veteranId: null }), 'CASE-MISSING');
    expect(out.size).toBe(0);
  });

  it('returns empty when the case has no documents', async () => {
    const out = await groundedSourcePagesForCase(mockDb({ caseDocumentIds: [] }), 'CASE-1');
    expect(out.size).toBe(0);
  });

  it('maps grounded SC + med pages back to their documents', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A', 'DOC-B'],
        sc: [{ sourceDocumentId: 'DOC-A', sourcePage: 412, sourceQuote: 'PTSD granted 70%' }],
        meds: [{ sourceDocumentId: 'DOC-B', sourcePage: 8, sourceQuote: 'sertraline 100mg daily' }],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-A')).toEqual([{ page: 412, factKind: 'sc_condition', sourceQuote: 'PTSD granted 70%' }]);
    expect(out.get('DOC-B')).toEqual([{ page: 8, factKind: 'active_medication', sourceQuote: 'sertraline 100mg daily' }]);
  });

  it('EXCLUDES rows whose source is not "extracted" (manual rows never pull pages)', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { source: 'manual', sourceDocumentId: 'DOC-A', sourcePage: 5, sourceQuote: 'manual entry' },
          { source: 'extracted', sourceDocumentId: 'DOC-A', sourcePage: 9, sourceQuote: 'extracted entry' },
        ],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-A')).toEqual([{ page: 9, factKind: 'sc_condition', sourceQuote: 'extracted entry' }]);
  });

  it('EXCLUDES rows whose source document is not on THIS case', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { sourceDocumentId: 'DOC-A', sourcePage: 1, sourceQuote: 'on case' },
          { sourceDocumentId: 'DOC-OTHER', sourcePage: 2, sourceQuote: 'different case' },
        ],
      }),
      'CASE-1',
    );
    expect([...out.keys()]).toEqual(['DOC-A']);
    expect(out.get('DOC-A')).toEqual([{ page: 1, factKind: 'sc_condition', sourceQuote: 'on case' }]);
  });

  it('DISTINCT by (documentId, page): one entry per page even when several facts cite it', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [{ sourceDocumentId: 'DOC-A', sourcePage: 100, sourceQuote: 'PTSD service-connected' }],
        problems: [{ sourceDocumentId: 'DOC-A', sourcePage: 100, sourceQuote: 'insomnia' }],
        meds: [{ sourceDocumentId: 'DOC-A', sourcePage: 100, sourceQuote: 'prazosin' }],
      }),
      'CASE-1',
    );
    const pages = out.get('DOC-A');
    expect(pages).toHaveLength(1);
    // sc_condition wins the representative quote (highest priority).
    expect(pages?.[0]).toEqual({ page: 100, factKind: 'sc_condition', sourceQuote: 'PTSD service-connected' });
  });

  it('prefers the sc_condition quote over problem/medication for the page "why" line', async () => {
    // Order the inputs so a NON-priority kind is seen first — the survivor must still be sc_condition.
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        meds: [{ sourceDocumentId: 'DOC-A', sourcePage: 50, sourceQuote: 'med quote' }],
        problems: [{ sourceDocumentId: 'DOC-A', sourcePage: 50, sourceQuote: 'problem quote' }],
        sc: [{ sourceDocumentId: 'DOC-A', sourcePage: 50, sourceQuote: 'sc quote' }],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-A')?.[0]?.sourceQuote).toBe('sc quote');
    expect(out.get('DOC-A')?.[0]?.factKind).toBe('sc_condition');
  });

  it('fills a blank higher-priority quote from a lower-priority row that has one', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [{ sourceDocumentId: 'DOC-A', sourcePage: 7, sourceQuote: '   ' }], // blank winner
        meds: [{ sourceDocumentId: 'DOC-A', sourcePage: 7, sourceQuote: 'gabapentin 300mg' }],
      }),
      'CASE-1',
    );
    // factKind stays sc_condition (priority), but the quote is borrowed from the med row.
    expect(out.get('DOC-A')?.[0]).toEqual({ page: 7, factKind: 'sc_condition', sourceQuote: 'gabapentin 300mg' });
  });

  it('sorts pages ascending within a document', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { sourceDocumentId: 'DOC-A', sourcePage: 870, sourceQuote: 'late page' },
          { sourceDocumentId: 'DOC-A', sourcePage: 12, sourceQuote: 'early page' },
          { sourceDocumentId: 'DOC-A', sourcePage: 412, sourceQuote: 'mid page' },
        ],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-A')?.map((p) => p.page)).toEqual([12, 412, 870]);
  });

  it('confidence gate: drops low-confidence rows but KEEPS null-confidence rows', async () => {
    const out = await groundedSourcePagesForCase(
      mockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { sourceDocumentId: 'DOC-A', sourcePage: 1, sourceQuote: 'high', confidence: 0.9 },
          { sourceDocumentId: 'DOC-A', sourcePage: 2, sourceQuote: 'low', confidence: 0.2 },
          { sourceDocumentId: 'DOC-A', sourcePage: 3, sourceQuote: 'unscored', confidence: null },
        ],
      }),
      'CASE-1',
      { minConfidence: 0.5 },
    );
    expect(out.get('DOC-A')?.map((p) => p.page)).toEqual([1, 3]);
  });

  it('queries each table with the extracted-source, non-null-provenance WHERE', async () => {
    const capture: { lastWhere?: unknown } = {};
    await groundedSourcePagesForCase(
      mockDb({ caseDocumentIds: ['DOC-A'], sc: [], problems: [], meds: [], capture }),
      'CASE-1',
    );
    expect(capture.lastWhere).toMatchObject({
      veteranId: 'VET-1',
      source: 'extracted',
      sourceDocumentId: { not: null },
      sourcePage: { not: null },
    });
  });
});

// ============ DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26): chartFactCategoryByDocument ============
interface CatScRow { source?: string; sourceDocumentId: string | null; status: string | null; condition?: string | null }
interface CatProblemRow { source?: string; sourceDocumentId: string | null }

function catMockDb(opts: {
  veteranId?: string | null;
  caseDocumentIds?: string[];
  sc?: CatScRow[];
  problems?: CatProblemRow[];
}): ChartFactCategoryDb {
  const sc = (opts.sc ?? []).map((r) => ({ source: r.source ?? 'extracted', sourceDocumentId: r.sourceDocumentId, status: r.status, condition: r.condition ?? null }));
  const problems = (opts.problems ?? []).map((r) => ({ source: r.source ?? 'extracted', sourceDocumentId: r.sourceDocumentId }));
  const applyWhere = <T extends { source: string; sourceDocumentId: string | null }>(rows: readonly T[], where: { source: string }) =>
    rows.filter((r) => r.source === where.source && r.sourceDocumentId !== null);
  return {
    case: {
      findFirst: async () =>
        opts.veteranId === null
          ? null
          : { veteranId: opts.veteranId ?? 'VET-1', documents: (opts.caseDocumentIds ?? ['DOC-A', 'DOC-B']).map((id) => ({ id })) },
    },
    scCondition: { findMany: async (args: { where: { source: string } }) => applyWhere(sc, args.where) },
    activeProblem: { findMany: async (args: { where: { source: string } }) => applyWhere(problems, args.where) },
  };
}

describe('chartFactCategoryByDocument', () => {
  it('returns empty when the case is missing or has no documents', async () => {
    expect((await chartFactCategoryByDocument(catMockDb({ veteranId: null }), 'X')).size).toBe(0);
    expect((await chartFactCategoryByDocument(catMockDb({ caseDocumentIds: [] }), 'X')).size).toBe(0);
  });

  it('maps service_connected → sc_proof, denied → denial, an active problem → clinical', async () => {
    const out = await chartFactCategoryByDocument(
      catMockDb({
        caseDocumentIds: ['DOC-SC', 'DOC-DN', 'DOC-CL'],
        sc: [
          { sourceDocumentId: 'DOC-SC', status: 'service_connected', condition: 'PTSD' },
          { sourceDocumentId: 'DOC-DN', status: 'denied', condition: 'knee' },
        ],
        problems: [{ sourceDocumentId: 'DOC-CL' }],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-SC')).toBe('sc_proof');
    expect(out.get('DOC-DN')).toBe('denial');
    expect(out.get('DOC-CL')).toBe('clinical');
  });

  it('a PENDING sc_condition contributes NO category', async () => {
    const out = await chartFactCategoryByDocument(
      catMockDb({ caseDocumentIds: ['DOC-A'], sc: [{ sourceDocumentId: 'DOC-A', status: 'pending', condition: 'OSA' }] }),
      'CASE-1',
    );
    expect(out.has('DOC-A')).toBe(false);
  });

  it('precedence denial > sc_proof > clinical when one doc grounds several facts', async () => {
    const out = await chartFactCategoryByDocument(
      catMockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { sourceDocumentId: 'DOC-A', status: 'service_connected', condition: 'PTSD' },
          { sourceDocumentId: 'DOC-A', status: 'denied', condition: 'sinusitis' },
        ],
        problems: [{ sourceDocumentId: 'DOC-A' }],
      }),
      'CASE-1',
    );
    expect(out.get('DOC-A')).toBe('denial'); // strongest wins
  });

  it('EXCLUDES rows for documents not on THIS case + non-extracted rows', async () => {
    const out = await chartFactCategoryByDocument(
      catMockDb({
        caseDocumentIds: ['DOC-A'],
        sc: [
          { sourceDocumentId: 'DOC-OTHER', status: 'service_connected', condition: 'PTSD' },
          { source: 'manual', sourceDocumentId: 'DOC-A', status: 'service_connected', condition: 'PTSD' },
        ],
      }),
      'CASE-1',
    );
    expect(out.size).toBe(0);
  });
});
