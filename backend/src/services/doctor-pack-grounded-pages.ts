import { EXTRACTED_SOURCE } from './chart-build-state.js';

/**
 * Doctor Pack "grounded source pages" back-map (doctor-pack grounded pages, 2026-06-13).
 *
 * THE PROBLEM this solves: full-read chart extraction now stamps every extracted fact with its
 * PROVENANCE — `sourceDocumentId` + `sourcePage` + `sourceQuote` (chart-merge-apply.ts is the
 * single writer, source = 'extracted'). So we KNOW which page of which document grounded the 70%
 * PTSD grant, the AHI on the sleep study, the active-med list. But the Doctor Pack page-selector
 * never reads those rows: a 1,000-page Blue Button dump is hard-excluded as `bulk` and contributes
 * nothing — even though it physically contains the page that grounded a granted condition.
 *
 * This module is the PURE, $0, facts→pages back-map (clinical + AI panels both said: pull those
 * EXACT pages, do not build a new AI ranker). It returns, per source Document, the distinct pages
 * that grounded an extracted fact, tagged with the fact kind + one representative "why" quote.
 *
 * SCOPE NOTE — three tables, not four. The four fact kinds the extractor captures are
 * sc_condition / active_problem / active_medication / screening, but ONLY the first three persist
 * as DB rows carrying sourceDocumentId/sourcePage provenance (sc_conditions / active_problems /
 * active_medications). Screenings are rendered to a single S3 text summary
 * (screening-summary-write.ts), NOT to a provenance-bearing table — so there is nothing to join
 * for them today. `'screening'` is kept in the FactKind union so a future screening-provenance
 * table slots in WITHOUT a signature change; this query simply returns zero screening rows until
 * that table exists.
 *
 * PURITY: no S3, no LLM, no mutation — one read per provenance table. The db param is a minimal
 * structural type (the three findMany delegates) so the unit test passes a tiny mock and
 * production passes the real AppDb. Mirrors chart-merge-apply.ts's structural-db pattern.
 */

// The four extractor fact kinds. Only the first three are queryable today (see module doc).
export type GroundedFactKind = 'sc_condition' | 'active_problem' | 'active_medication' | 'screening';

export interface GroundedPage {
  readonly page: number;
  readonly factKind: GroundedFactKind;
  // The representative "why" line for this page — one quote even when several facts cite the page,
  // chosen by FACT_KIND_QUOTE_PRIORITY (sc_condition > screening > active_problem >
  // active_medication). Feeds a later cover "why" line (PR-3); threaded now so PR-2 can tag pages.
  readonly sourceQuote: string;
}

/**
 * Which fact kind's quote wins as the page's representative "why" line when multiple facts ground
 * the SAME page. Lower number = higher priority. sc_condition first (the grant page is the
 * money page), then screening, then problem, then medication — per the prompt's stated preference.
 */
const FACT_KIND_QUOTE_PRIORITY: Readonly<Record<GroundedFactKind, number>> = {
  sc_condition: 0,
  screening: 1,
  active_problem: 2,
  active_medication: 3,
};

// One extracted, page-grounded chart row as the back-map sees it. The three source tables share
// this projected shape (condition/problem/drug name collapses to nothing we need — only the
// provenance + quote matter here).
interface GroundedRow {
  readonly source: string;
  readonly sourceDocumentId: string | null;
  readonly sourcePage: number | null;
  readonly sourceQuote: string | null;
  readonly confidence: number | null;
}

interface GroundedFindManyArgs {
  readonly where: {
    readonly veteranId: string;
    readonly source: string;
    readonly sourceDocumentId: { readonly not: null };
    readonly sourcePage: { readonly not: null };
  };
  readonly select: {
    readonly source: true;
    readonly sourceDocumentId: true;
    readonly sourcePage: true;
    readonly sourceQuote: true;
    readonly confidence: true;
  };
}

// Minimal structural db: just the three provenance tables' findMany + the case lookup that maps
// caseId → veteranId + the case's own document ids (the chart rows are veteran-scoped, but a pack
// is case-scoped — we only pull pages from documents that belong to THIS case).
export interface GroundedPagesDb {
  readonly case: {
    findFirst(args: {
      readonly where: { readonly id: string };
      readonly select: { readonly veteranId: true; readonly documents: { readonly select: { readonly id: true } } };
    }): Promise<{ readonly veteranId: string; readonly documents: readonly { readonly id: string }[] } | null>;
  };
  readonly scCondition: { findMany(args: GroundedFindManyArgs): Promise<readonly GroundedRow[]> };
  readonly activeProblem: { findMany(args: GroundedFindManyArgs): Promise<readonly GroundedRow[]> };
  readonly activeMedication: { findMany(args: GroundedFindManyArgs): Promise<readonly GroundedRow[]> };
}

export interface GroundedSourcePagesOptions {
  // Optional confidence floor. DEFAULT: none. Extracted rows can carry a null confidence (the
  // extractor doesn't always score), and the whole point is to pull the page that grounded a fact
  // — silently dropping null/low-confidence rows would re-hide the exact pages we want. A caller
  // that wants to gate may pass e.g. 0.5; null-confidence rows are KEPT regardless (a missing
  // score is not a low score).
  readonly minConfidence?: number;
}

function whereFor(veteranId: string): GroundedFindManyArgs['where'] {
  return {
    veteranId,
    source: EXTRACTED_SOURCE,
    sourceDocumentId: { not: null },
    sourcePage: { not: null },
  };
}

const SELECT: GroundedFindManyArgs['select'] = {
  source: true,
  sourceDocumentId: true,
  sourcePage: true,
  sourceQuote: true,
  confidence: true,
};

/**
 * Map a case's EXTRACTED, page-grounded chart facts back to the source-document pages that
 * grounded them.
 *
 * Returns Map<documentId, GroundedPage[]>:
 *   - only documents that BELONG to the case (veteran-scoped chart rows ∩ case's document set);
 *   - DISTINCT by (documentId, page) — one entry per page even when several facts cite it;
 *   - one representative sourceQuote per page (FACT_KIND_QUOTE_PRIORITY survivor);
 *   - pages sorted ascending within each document; documents iterate in first-seen order.
 *
 * Pure read. No wiring side effects — the generator unions these into its selection separately.
 */
export async function groundedSourcePagesForCase(
  db: GroundedPagesDb,
  caseId: string,
  options?: GroundedSourcePagesOptions,
): Promise<Map<string, GroundedPage[]>> {
  const caseRow = await db.case.findFirst({
    where: { id: caseId },
    select: { veteranId: true, documents: { select: { id: true } } },
  });
  if (caseRow === null) return new Map();
  const caseDocumentIds = new Set(caseRow.documents.map((d) => d.id));
  if (caseDocumentIds.size === 0) return new Map();

  const where = whereFor(caseRow.veteranId);
  const [scRows, problemRows, medRows] = await Promise.all([
    db.scCondition.findMany({ where, select: SELECT }),
    db.activeProblem.findMany({ where, select: SELECT }),
    db.activeMedication.findMany({ where, select: SELECT }),
  ]);

  const minConfidence = options?.minConfidence;
  // Tag each table's rows with their fact kind, then fold into the per-(doc,page) winner map.
  const tagged: { kind: GroundedFactKind; rows: readonly GroundedRow[] }[] = [
    { kind: 'sc_condition', rows: scRows },
    { kind: 'active_problem', rows: problemRows },
    { kind: 'active_medication', rows: medRows },
  ];

  // Winner per (documentId, page): the row whose factKind has the highest quote priority.
  interface PageWinner { readonly documentId: string; readonly page: number; factKind: GroundedFactKind; sourceQuote: string }
  const winners = new Map<string, PageWinner>();
  // Preserve first-seen document order for stable, deterministic output.
  const docOrder: string[] = [];
  const seenDoc = new Set<string>();

  for (const { kind, rows } of tagged) {
    for (const row of rows) {
      // Belt-and-suspenders: the WHERE already filters source + non-null provenance, but a mock
      // (or a future loosened query) might not — re-check here so the contract holds regardless.
      if (row.source !== EXTRACTED_SOURCE) continue;
      const documentId = row.sourceDocumentId;
      const page = row.sourcePage;
      if (documentId === null || page === null) continue;
      if (!caseDocumentIds.has(documentId)) continue; // not this case's document
      if (minConfidence !== undefined && row.confidence !== null && row.confidence < minConfidence) continue;

      if (!seenDoc.has(documentId)) {
        seenDoc.add(documentId);
        docOrder.push(documentId);
      }
      const key = `${documentId} ${page}`;
      const quote = (row.sourceQuote ?? '').trim();
      const existing = winners.get(key);
      if (existing === undefined) {
        winners.set(key, { documentId, page, factKind: kind, sourceQuote: quote });
      } else if (FACT_KIND_QUOTE_PRIORITY[kind] < FACT_KIND_QUOTE_PRIORITY[existing.factKind]) {
        existing.factKind = kind;
        existing.sourceQuote = quote;
      } else if (existing.sourceQuote.length === 0 && quote.length > 0) {
        // Same-or-lower priority but the incumbent had no usable quote — fill it in so the "why"
        // line isn't blank when a quote exists somewhere on the page.
        existing.sourceQuote = quote;
      }
    }
  }

  const out = new Map<string, GroundedPage[]>();
  for (const documentId of docOrder) {
    const pages: GroundedPage[] = [];
    for (const winner of winners.values()) {
      if (winner.documentId !== documentId) continue;
      pages.push({ page: winner.page, factKind: winner.factKind, sourceQuote: winner.sourceQuote });
    }
    pages.sort((a, b) => a.page - b.page);
    if (pages.length > 0) out.set(documentId, pages);
  }
  return out;
}
