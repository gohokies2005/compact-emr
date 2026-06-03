/**
 * Loads a case's documents + OCR'd pages in the shape the extractor consumes (BundleDocument[]).
 * Mirrors the document query in buildDrafterBundle — kept here so the chart-extract internal GET
 * endpoint can serve it to the worker WITHOUT the worker needing Prisma (the worker stays a
 * lightweight HTTP+LLM Lambda; the API, which already has Prisma, does the read).
 */

import type { AppDb } from './db-types.js';
import type { BundleDocument } from './chart-extractor.js';

interface RawDoc {
  id: string;
  filename: string;
  docTag: string | null;
  pages?: { pageNumber: number; text: string | null; confidence: number | null }[];
}

export async function loadBundleDocuments(db: AppDb, caseId: string): Promise<BundleDocument[]> {
  const rows = (await (db as unknown as {
    document: {
      findMany: (a: { where: { caseId: string }; include: { pages: { orderBy: { pageNumber: 'asc' } } } }) => Promise<RawDoc[]>;
    };
  }).document.findMany({
    where: { caseId },
    include: { pages: { orderBy: { pageNumber: 'asc' } } },
  }));

  return rows.map((d) => ({
    id: d.id,
    filename: d.filename,
    docTag: d.docTag ?? null,
    pages: (d.pages ?? []).map((p) => ({ pageNumber: p.pageNumber, text: p.text ?? '', confidence: p.confidence ?? null })),
  }));
}
