import { describe, it, expect } from 'vitest';
import { chunkDocuments, uncoveredPages, splitChunkText, CHUNK_CHARS, type BundleDocument } from '../chart-extractor.js';

// PR-1 full-read chunker (Ryan 2026-06-13). The windower MISSED items past WINDOW_CAP_CHARS / outside
// a matched header; the chunker must read EVERY page. These lock the pure chunking invariants:
// complete coverage, page-boundary splits, overlap, oversized-page handling, deterministic ordering.

function page(n: number, chars: number): { pageNumber: number; text: string } {
  return { pageNumber: n, text: `p${n} ` + 'x'.repeat(Math.max(0, chars - 4)) };
}
function doc(id: string, pages: { pageNumber: number; text: string }[]): BundleDocument {
  return { id, filename: `${id}.pdf`, pages };
}

describe('chunkDocuments — complete read', () => {
  it('covers EVERY page (no silent gaps) across multiple documents', () => {
    const docs = [
      doc('A', [page(1, 5000), page(2, 5000), page(3, 5000)]),
      doc('B', [page(1, 100), page(2, 100)]),
    ];
    const chunks = chunkDocuments(docs);
    expect(uncoveredPages(docs, chunks)).toEqual([]); // the invariant that matters most
  });

  it('splits a large document into multiple chunks at the char budget, whole pages only', () => {
    // 6 pages of ~20k chars = ~120k chars; with a 48k budget that is ~3 chunks.
    const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, 20_000));
    const chunks = chunkDocuments([doc('BIG', pages)]);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the budget unless it is a single page (oversized-page rule).
    for (const c of chunks) {
      expect(c.text.length <= CHUNK_CHARS || c.pageNumbers.length === 1).toBe(true);
    }
    expect(uncoveredPages([doc('BIG', pages)], chunks)).toEqual([]);
  });

  it('puts a single page LARGER than the budget in its own chunk (never drops it)', () => {
    const pages = [page(1, 200), page(2, CHUNK_CHARS + 50_000), page(3, 200)];
    const chunks = chunkDocuments([doc('HUGE', pages)]);
    const p2 = chunks.find((c) => c.pageNumbers.includes(2));
    expect(p2).toBeDefined();
    expect(uncoveredPages([doc('HUGE', pages)], chunks)).toEqual([]);
  });

  it('overlaps adjacent chunks by one page so a boundary-straddling item is not lost', () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, 20_000));
    const chunks = chunkDocuments([doc('OV', pages)]);
    // The last page of chunk N should reappear as the first page of chunk N+1.
    for (let n = 0; n < chunks.length - 1; n++) {
      const lastOfN = chunks[n]!.pageNumbers.at(-1)!;
      expect(chunks[n + 1]!.pageNumbers[0]).toBe(lastOfN);
    }
  });

  it('assigns a global, ascending chunkIndex (deterministic dedup ordering)', () => {
    const chunks = chunkDocuments([doc('A', [page(1, 100)]), doc('B', [page(1, 100), page(2, 100)])]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('skips empty documents without throwing', () => {
    expect(chunkDocuments([{ id: 'E', filename: 'e.pdf', pages: [] }])).toEqual([]);
  });
});

describe('uncoveredPages', () => {
  it('flags a page that no chunk covers', () => {
    const d = doc('A', [page(1, 100), page(2, 100)]);
    const partial = chunkDocuments([d]).map((c) => ({ ...c, pageNumbers: c.pageNumbers.filter((p) => p !== 2) }));
    expect(uncoveredPages([d], partial)).toEqual([{ documentId: 'A', pageNumber: 2 }]);
  });
});

describe('splitChunkText — truncation split-retry', () => {
  it('splits page-marked text at a [p.N] boundary near the midpoint', () => {
    const text = '[p.1]\n' + 'a'.repeat(100) + '\n[p.2]\n' + 'b'.repeat(100) + '\n[p.3]\n' + 'c'.repeat(100);
    const halves = splitChunkText(text);
    expect(halves).not.toBeNull();
    // Both halves keep a page marker so grounding can still cite a page.
    expect(halves![0]).toContain('[p.1]');
    expect(halves![1]).toMatch(/\[p\.[23]\]/);
    // No content lost across the split.
    expect((halves![0] + halves![1]).replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('returns null for a single-page chunk (cannot split without orphaning the marker)', () => {
    expect(splitChunkText('[p.5]\n' + 'x'.repeat(500))).toBeNull();
  });
});
