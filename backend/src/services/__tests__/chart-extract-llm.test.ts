import { describe, it, expect } from 'vitest';
import { coerceRawItems, coerceRawItemsCombined, groundAndDispose, type RawExtractedItem } from '../chart-extract-llm.js';
import type { BundleDocument, SectionWindow } from '../chart-extractor.js';

const win: SectionWindow = {
  documentId: 'doc-bb',
  filename: 'VA-Blue-Button.pdf',
  category: 'active_problem',
  pageNumbers: [2],
  text: '[p.2]\n1. Obstructive sleep apnea\n2. Tinnitus',
  headerMatched: 'problem list',
};

const docs: BundleDocument[] = [
  { id: 'doc-bb', filename: 'VA-Blue-Button.pdf', pages: [{ pageNumber: 2, text: '1. Obstructive sleep apnea\n2. Tinnitus' }] },
];

describe('coerceRawItems', () => {
  it('coerces valid items and injects the documentId + category from the window', () => {
    const items = coerceRawItems({ items: [
      { name: 'Obstructive sleep apnea', sourcePage: 2, sourceQuote: 'Obstructive sleep apnea', confidence: 0.95 },
    ] }, win);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'active_problem', sourceDocumentId: 'doc-bb', sourcePage: 2 });
  });
  it('drops malformed items (missing required fields) without throwing', () => {
    expect(coerceRawItems({ items: [{ name: 'x' }, { sourcePage: 2 }, 'nope', null] }, win)).toHaveLength(0);
  });
  it('clamps confidence to [0,1] and truncates page to int', () => {
    const items = coerceRawItems({ items: [{ name: 'Tinnitus', sourcePage: 2.9, sourceQuote: 'Tinnitus', confidence: 1.7 }] }, win);
    expect(items[0]!.confidence).toBe(1);
    expect(items[0]!.sourcePage).toBe(2);
  });
  it('returns [] on a non-array / missing items payload', () => {
    expect(coerceRawItems({}, win)).toHaveLength(0);
    expect(coerceRawItems(null, win)).toHaveLength(0);
  });
});

describe('coerceRawItemsCombined — full-read chunk (category comes from the item, not the window)', () => {
  it('reads category per item and injects the documentId', () => {
    const items = coerceRawItemsCombined({ items: [
      { category: 'sc_condition', name: 'PTSD', status: 'service_connected', ratingPct: 70, sourcePage: 19, sourceQuote: 'PTSD 70%', confidence: 0.95 },
      { category: 'active_medication', name: 'Sertraline', dose: '100 mg', sourcePage: 4, sourceQuote: 'Sertraline 100 mg', confidence: 0.9 },
    ] }, 'doc-blue-button');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ category: 'sc_condition', name: 'PTSD', ratingPct: 70, sourceDocumentId: 'doc-blue-button' });
    expect(items[1]).toMatchObject({ category: 'active_medication', dose: '100 mg', sourceDocumentId: 'doc-blue-button' });
  });
  it('rejects an item with a missing or invalid category (no silent miscategorize)', () => {
    expect(coerceRawItemsCombined({ items: [
      { name: 'NoCategory', sourcePage: 1, sourceQuote: 'x', confidence: 0.9 },
      { category: 'bogus', name: 'BadCat', sourcePage: 1, sourceQuote: 'x', confidence: 0.9 },
    ] }, 'd')).toHaveLength(0);
  });
  it('clamps confidence and truncates the page like the windowed coercer', () => {
    const items = coerceRawItemsCombined({ items: [
      { category: 'active_problem', name: 'Tinnitus', sourcePage: 2.9, sourceQuote: 'Tinnitus', confidence: 1.7 },
    ] }, 'd');
    expect(items[0]!.confidence).toBe(1);
    expect(items[0]!.sourcePage).toBe(2);
  });
});

describe('groundAndDispose', () => {
  const base: RawExtractedItem = {
    category: 'active_problem', name: 'X', sourceDocumentId: 'doc-bb', sourcePage: 2, sourceQuote: 'x', confidence: 0.9,
  };
  it('keeps a grounded high-confidence item', () => {
    const r = groundAndDispose(docs, [{ ...base, name: 'Obstructive sleep apnea', sourceQuote: 'Obstructive sleep apnea' }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.disposition).toBe('autofill');
    expect(r.items[0]!.needsReview).toBe(false);
  });
  it('drops an ungrounded (fabricated) item and counts it', () => {
    const r = groundAndDispose(docs, [{ ...base, name: 'Diabetes', sourceQuote: 'Diabetes mellitus type 2' }]);
    expect(r.items).toHaveLength(0);
    expect(r.droppedUngrounded).toBe(1);
  });
  it('flags a mid-confidence grounded item as needs_review (still written)', () => {
    const r = groundAndDispose(docs, [{ ...base, name: 'Tinnitus', sourceQuote: 'Tinnitus', confidence: 0.7 }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.disposition).toBe('needs_review');
    expect(r.items[0]!.needsReview).toBe(true);
  });
  it('drops a low-confidence item entirely', () => {
    const r = groundAndDispose(docs, [{ ...base, name: 'Tinnitus', sourceQuote: 'Tinnitus', confidence: 0.4 }]);
    expect(r.items).toHaveLength(0);
    expect(r.droppedLowConfidence).toBe(1);
  });
  it('dedups within the run on (category, normalized name) — OSA == Obstructive sleep apnea', () => {
    const r = groundAndDispose(docs, [
      { ...base, name: 'Obstructive sleep apnea', sourceQuote: 'Obstructive sleep apnea' },
      { ...base, name: 'OSA', sourceQuote: 'Obstructive sleep apnea' },
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.droppedDuplicate).toBe(1);
  });

  // Full-read overlap (architect SHOULD-FIX): the same SC grant arrives twice across a chunk
  // boundary and the copies disagree. Default first-wins (windowed) must be UNCHANGED; the
  // full-read preferMoreComplete pick keeps the copy carrying status + ratingPct.
  const scDocs: BundleDocument[] = [
    { id: 'doc-rd', filename: 'rating.pdf', pages: [{ pageNumber: 19, text: 'service connection for ptsd is granted 70 percent' }] },
  ];
  const bare: RawExtractedItem = { category: 'sc_condition', name: 'PTSD', sourceDocumentId: 'doc-rd', sourcePage: 19, sourceQuote: 'service connection for ptsd', confidence: 0.9 };
  const full: RawExtractedItem = { ...bare, status: 'service_connected', ratingPct: 70, sourceQuote: 'ptsd is granted 70 percent' };
  it('default (windowed) keeps FIRST duplicate — bare copy wins when it appears first', () => {
    const r = groundAndDispose(scDocs, [bare, full]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.ratingPct).toBeUndefined(); // first-wins, unchanged behavior
  });
  it('full-read (preferMoreComplete) keeps the copy WITH status+ratingPct regardless of order', () => {
    const a = groundAndDispose(scDocs, [bare, full], { preferMoreComplete: true });
    expect(a.items).toHaveLength(1);
    expect(a.items[0]!.ratingPct).toBe(70);
    expect(a.items[0]!.status).toBe('service_connected');
    const b = groundAndDispose(scDocs, [full, bare], { preferMoreComplete: true });
    expect(b.items[0]!.ratingPct).toBe(70); // order-independent survivor
  });
});
