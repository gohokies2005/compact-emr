import { describe, it, expect } from 'vitest';
import { coerceRawItems, coerceRawItemsCombined, coerceScreenings, groundScreenings, groundAndDispose, type RawExtractedItem, type ScreeningResult } from '../chart-extract-llm.js';
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
  it('routes a screening to screenings, NOT to chart items (dx-rule guard)', () => {
    const input = { items: [
      { category: 'screening', name: 'PHQ-9', score: '18', screenDate: '2024-03-01', sourcePage: 7, sourceQuote: 'PHQ-9 score 18', confidence: 0.9 },
      { category: 'active_problem', name: 'Tinnitus', sourcePage: 2, sourceQuote: 'Tinnitus', confidence: 0.9 },
    ] };
    // The chart-item coercer drops the screening; only the real problem survives as a chart item.
    expect(coerceRawItemsCombined(input, 'd').map((i) => i.name)).toEqual(['Tinnitus']);
    // The screening coercer captures it as a labeled data point with its score + date.
    const screens = coerceScreenings(input, 'd');
    expect(screens).toHaveLength(1);
    expect(screens[0]).toMatchObject({ instrument: 'PHQ-9', score: '18', date: '2024-03-01', sourceDocumentId: 'd' });
  });
});

describe('medication temporality — dedup key + date scrub (Ryan 2026-06-13)', () => {
  const page = 'ACTIVE OUTPATIENT MEDICATIONS FLUOXETINE 20MG Start Date: 03/12/2015 Last Filled: 11/02/2025 | 06/14/2022 note: FLUOXETINE referenced | LEXAPRO 10MG Start Date: 01/05/2022';
  const mdocs: BundleDocument[] = [{ id: 'd', filename: 'bb.pdf', pages: [{ pageNumber: 5, text: page }] }];
  const med = (over: Partial<RawExtractedItem>): RawExtractedItem => ({
    category: 'active_medication', name: 'Fluoxetine', sourceDocumentId: 'd', sourcePage: 5, sourceQuote: 'FLUOXETINE 20MG', confidence: 0.9, ...over,
  });

  it('collapses chunk-overlap copies of the SAME drug+status+year to one', () => {
    const m = med({ medStatus: 'active', startDate: '03/12/2015', sourceQuote: 'FLUOXETINE 20MG Start Date: 03/12/2015' });
    const r = groundAndDispose(mdocs, [m, { ...m }], { preferMoreComplete: true });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startDate).toBe('03/12/2015');
  });

  it('keeps active vs historical of the same drug as DISTINCT timeline rows', () => {
    const active = med({ medStatus: 'active', startDate: '03/12/2015', sourceQuote: 'FLUOXETINE 20MG Start Date: 03/12/2015' });
    const hist = med({ medStatus: 'historical', lastSeenDate: '06/14/2022', sourceQuote: '06/14/2022 note: FLUOXETINE referenced' });
    const r = groundAndDispose(mdocs, [active, hist], { preferMoreComplete: true });
    expect(r.items).toHaveLength(2);
  });

  it('keeps the same drug+status in DIFFERENT years as distinct (treatment timeline)', () => {
    const y2015 = med({ medStatus: 'historical', lastSeenDate: '03/12/2015', sourceQuote: 'FLUOXETINE 20MG Start Date: 03/12/2015' });
    const y2022 = med({ medStatus: 'historical', lastSeenDate: '06/14/2022', sourceQuote: '06/14/2022 note: FLUOXETINE referenced' });
    expect(groundAndDispose(mdocs, [y2015, y2022], { preferMoreComplete: true }).items).toHaveLength(2);
  });

  it('SCRUBS a med date that is NOT in the grounded quote (anti-fabrication)', () => {
    const fabricated = med({ medStatus: 'active', startDate: '01/01/2099', sourceQuote: 'FLUOXETINE 20MG' }); // 2099 not on page/quote
    const r = groundAndDispose(mdocs, [fabricated], { preferMoreComplete: true });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startDate).toBeUndefined(); // nulled — date wasn't in the quote
  });

  it('does NOT change the dedup key for conditions/problems (regression)', () => {
    const cdocs: BundleDocument[] = [{ id: 'c', filename: 'x.pdf', pages: [{ pageNumber: 1, text: 'PTSD and tinnitus' }] }];
    const c = (name: string): RawExtractedItem => ({ category: 'sc_condition', name, sourceDocumentId: 'c', sourcePage: 1, sourceQuote: name, confidence: 0.9 });
    // Two PTSD rows still collapse to one (name-only key for conditions, unchanged).
    expect(groundAndDispose(cdocs, [c('PTSD'), c('PTSD')], { preferMoreComplete: true }).items).toHaveLength(1);
  });
});

describe('coerceRawItemsCombined — medication temporality fields', () => {
  it('coerces medStatus/startDate/lastSeenDate; drops an invalid medStatus to undefined', () => {
    const [ok] = coerceRawItemsCombined({ items: [
      { category: 'active_medication', name: 'Lexapro', medStatus: 'historical', startDate: '01/05/2022', lastSeenDate: '06/2024', sourcePage: 5, sourceQuote: 'Lexapro', confidence: 0.9 },
    ] }, 'd');
    expect(ok).toMatchObject({ medStatus: 'historical', startDate: '01/05/2022', lastSeenDate: '06/2024' });
    const [bad] = coerceRawItemsCombined({ items: [
      { category: 'active_medication', name: 'Lexapro', medStatus: 'bogus', sourcePage: 5, sourceQuote: 'Lexapro', confidence: 0.9 },
    ] }, 'd');
    expect(bad!.medStatus).toBeUndefined();
  });
});

describe('groundScreenings — grounded + deduped screening data points', () => {
  const sdocs: BundleDocument[] = [{ id: 'd', filename: 'bb.pdf', pages: [{ pageNumber: 7, text: 'mental health: PHQ-9 score 18 administered 2024-03-01' }] }];
  const base: ScreeningResult = { instrument: 'PHQ-9', score: '18', date: '2024-03-01', sourceDocumentId: 'd', sourcePage: 7, sourceQuote: 'PHQ-9 score 18', confidence: 0.9 };
  it('keeps a grounded screening and drops an ungrounded (fabricated-quote) one', () => {
    const r = groundScreenings(sdocs, [base, { ...base, sourceQuote: 'GAD-7 score 21 (not on this page)' }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.instrument).toBe('PHQ-9');
  });
  it('dedups identical (instrument, date, score) repeats from chunk overlap', () => {
    expect(groundScreenings(sdocs, [base, { ...base }])).toHaveLength(1);
  });
  it('keeps a screening date only when it is in the quote; nulls an unquoted date (anti-fabrication)', () => {
    const dated = { ...base, score: '18', sourceQuote: 'PHQ-9 score 18 administered 2024-03-01' }; // date IS in quote
    expect(groundScreenings(sdocs, [dated])[0]!.date).toBe('2024-03-01');
    const unquoted = { ...base, score: '9', date: '01/01/2099', sourceQuote: 'PHQ-9 score 18' }; // 2099 not in quote
    expect(groundScreenings(sdocs, [unquoted])[0]!.date).toBeNull();
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
