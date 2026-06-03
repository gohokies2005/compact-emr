import { describe, it, expect } from 'vitest';
import { coerceRawItems, groundAndDispose, type RawExtractedItem } from '../chart-extract-llm.js';
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
});
