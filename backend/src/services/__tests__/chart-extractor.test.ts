import { describe, it, expect } from 'vitest';
import {
  locateExtractionInputs,
  groundExtractedItem,
  normalizeName,
  normalizeForQuoteMatch,
  dispositionForConfidence,
  dedupeIdenticalDocuments,
  chunkDocuments,
  splitOversizedPage,
  CHUNK_CHARS,
  type BundleDocument,
} from '../chart-extractor.js';

// Synthetic stand-ins for the real shapes (no PHI). A "Blue Button" large doc carries the two
// structured list headers on distinct pages; a small benefit-summary doc carries the grants.
const FILLER = 'lorem ipsum clinical narrative '.repeat(1000); // ~30k chars → forces "large doc"

function bluebutton(): BundleDocument {
  return {
    id: 'doc-bb',
    filename: 'VA-Blue-Button-report.pdf',
    docTag: 'Other',
    pages: [
      { pageNumber: 1, text: FILLER },
      { pageNumber: 2, text: 'Active problems - Computerized Problem List is the source:\n1. Obstructive sleep apnea\n2. Tinnitus\n3. Low Back Pain' },
      { pageNumber: 3, text: 'Active Outpatient Medications (including Supplies):\nZyrtec 10 mg p.o. daily as needed' },
      { pageNumber: 4, text: 'unrelated trailing narrative page ' + 'x'.repeat(500) },
    ],
  };
}

function benefitSummary(): BundleDocument {
  return {
    id: 'doc-bs',
    filename: 'Veteran Benefit Summary.pdf',
    pages: [{ pageNumber: 1, text: 'Your combined service-connected evaluation is: 70%. You have one or more service-connected disabilities.' }],
  };
}

function dd214(): BundleDocument {
  return {
    id: 'doc-dd',
    filename: 'DD-214.pdf',
    pages: [{ pageNumber: 1, text: 'Certificate of Release or Discharge from Active Duty. Character of service: Honorable. Branch: Navy. Primary specialty: Hospital Corpsman. Net active service: 2 years 1 month.' }],
  };
}

describe('locateExtractionInputs (deterministic section-targeting)', () => {
  it('windows the problem list to just the page with the header', () => {
    const w = locateExtractionInputs([bluebutton()]).find((x) => x.category === 'active_problem');
    expect(w).toBeDefined();
    expect(w!.pageNumbers).toContain(2);
    expect(w!.text).toContain('Obstructive sleep apnea');
    // Must STOP before the medications page (different header) — page 3 excluded.
    expect(w!.pageNumbers).not.toContain(3);
  });

  it('windows the medications section and stops at the cap, not the whole 1k-page doc', () => {
    const w = locateExtractionInputs([bluebutton()]).find((x) => x.category === 'active_medication');
    expect(w).toBeDefined();
    expect(w!.pageNumbers).toContain(3);
    expect(w!.text).toContain('Zyrtec');
  });

  it('draws SC grants from the small benefit-summary doc whole, not from Blue Button prose', () => {
    const windows = locateExtractionInputs([bluebutton(), benefitSummary()]);
    const sc = windows.filter((x) => x.category === 'sc_condition');
    expect(sc).toHaveLength(1);
    expect(sc[0]!.documentId).toBe('doc-bs');
    expect(sc[0]!.headerMatched).toBe('whole_document');
    expect(sc[0]!.text).toContain('70%');
  });

  it('reviews EVERY small doc by content regardless of filename — a DD-214 is still read, never skipped by name', () => {
    // New principle (Ryan 2026-06-03): filenames have zero bearing. Every small doc is sent to all
    // three category extractors; the LLM + grounding decide emptiness, not a filename/content gate.
    const windows = locateExtractionInputs([dd214()]);
    expect(windows.map((w) => w.category).sort()).toEqual(['active_medication', 'active_problem', 'sc_condition']);
  });

  it('reads SC ratings from a screenshot named image0.png — filename has ZERO bearing (Armand regression)', () => {
    const screenshot: BundleDocument = {
      id: 'doc-img', filename: 'image0.png', docTag: 'Other',
      pages: [{ pageNumber: 1, text: 'Service-connected ratings\n10% rating for tinnitus\n50% rating for other specified depressive disorder' }],
    };
    const sc = locateExtractionInputs([screenshot]).filter((w) => w.category === 'sc_condition');
    expect(sc).toHaveLength(1);
    expect(sc[0]!.text).toContain('depressive disorder');
  });

  it('windows SC ratings out of a LARGE doc by content (not filename) too', () => {
    const big: BundleDocument = {
      id: 'doc-big', filename: 'records.pdf', docTag: 'Other',
      pages: [
        { pageNumber: 1, text: 'x'.repeat(26000) },
        { pageNumber: 2, text: 'Service-connected ratings: 50% rating for PTSD; 10% rating for tinnitus' },
      ],
    };
    const sc = locateExtractionInputs([big]).filter((w) => w.category === 'sc_condition');
    expect(sc).toHaveLength(1);
    expect(sc[0]!.pageNumbers).toContain(2);
  });

  it('tags every window with page markers so the model can return the source page', () => {
    const w = locateExtractionInputs([bluebutton()])[0]!;
    expect(w.text).toMatch(/\[p\.\d+\]/);
  });
});

describe('dedupeIdenticalDocuments (cost-safety: never extract the same content twice)', () => {
  const doc = (id: string, texts: string[]): BundleDocument => ({
    id, filename: `${id}.pdf`, pages: texts.map((t, i) => ({ pageNumber: i + 1, text: t })),
  });

  it('drops a byte-identical-content duplicate, keeping the FIRST occurrence (Woodley Misc_2==Misc_3)', () => {
    const a = doc('A', ['VA Rating Decision', 'Service connection for GERD is denied.']);
    const b = doc('B', ['VA Rating Decision', 'Service connection for GERD is denied.']); // identical content
    const c = doc('C', ['A genuinely different document.']);
    const { kept, dropped } = dedupeIdenticalDocuments([a, b, c]);
    expect(kept.map((d) => d.id)).toEqual(['A', 'C']);
    expect(dropped).toEqual([{ id: 'B', filename: 'B.pdf', duplicateOfId: 'A' }]);
  });

  it('keeps documents with the SAME filename but DIFFERENT content (not a dup)', () => {
    const a = doc('A', ['page one alpha']);
    const b = doc('B', ['page one BETA — different']);
    const { kept, dropped } = dedupeIdenticalDocuments([a, b]);
    expect(kept.map((d) => d.id)).toEqual(['A', 'B']);
    expect(dropped).toHaveLength(0);
  });

  it('NEVER collapses empty / no-readable-content docs (two unread files stay separate)', () => {
    const a = doc('A', ['']);
    const b: BundleDocument = { id: 'B', filename: 'B.pdf', pages: [] };
    const { kept, dropped } = dedupeIdenticalDocuments([a, b]);
    expect(kept.map((d) => d.id)).toEqual(['A', 'B']);
    expect(dropped).toHaveLength(0);
  });
});

describe('groundExtractedItem (anti-fabrication gate)', () => {
  const docs = [bluebutton()];
  it('accepts an item whose quote is verbatim on the cited page', () => {
    expect(groundExtractedItem(docs, { sourceDocumentId: 'doc-bb', sourcePage: 2, sourceQuote: 'Obstructive sleep apnea' })).toBe(true);
  });
  it('rejects an invented quote not on the page', () => {
    expect(groundExtractedItem(docs, { sourceDocumentId: 'doc-bb', sourcePage: 2, sourceQuote: 'Diabetes mellitus type 2' })).toBe(false);
  });
  it('rejects a quote attributed to the wrong page', () => {
    expect(groundExtractedItem(docs, { sourceDocumentId: 'doc-bb', sourcePage: 3, sourceQuote: 'Obstructive sleep apnea' })).toBe(false);
  });
  it('rejects an unknown document', () => {
    expect(groundExtractedItem(docs, { sourceDocumentId: 'nope', sourcePage: 1, sourceQuote: 'Zyrtec' })).toBe(false);
  });
  it('tolerates OCR whitespace/case noise in the match', () => {
    expect(normalizeForQuoteMatch('  OBSTRUCTIVE   sleep\nApnea ')).toBe('obstructive sleep apnea');
  });
});

describe('normalizeName (dedup key + synonym folding)', () => {
  it('folds OSA to its full name so the merge dedups them', () => {
    expect(normalizeName('OSA')).toBe(normalizeName('Obstructive Sleep Apnea'));
  });
  it('folds PTSD variants together', () => {
    expect(normalizeName('Chronic Post-Traumatic Stress Disorder')).toBe(normalizeName('PTSD'));
  });
  it('strips trailing punctuation and collapses whitespace', () => {
    expect(normalizeName('Low Back Pain.')).toBe('low back pain');
  });

  // Keystone pkg 6 — the CLM-A355D7A822 explosion: the same condition under 3 spellings must
  // collapse to ONE key (the named acceptance), while the compound stays its own honest row.
  it('collapses the CLM-A355D7A822 PTSD variants to ONE canonical key', () => {
    const canonical = normalizeName('PTSD');
    expect(normalizeName('PTSD, chronic')).toBe(canonical);
    expect(normalizeName('Posttraumatic stress disorder (PTSD)')).toBe(canonical);
    expect(normalizeName('Post traumatic stress disorder')).toBe(canonical);
    expect(normalizeName('Post-traumatic stress disorder')).toBe(canonical);
    expect(canonical).toBe('post-traumatic stress disorder');
  });
  it('"PTSD and anxiety" stays DISTINCT — a compound is two conditions, never silently folded (decision (a))', () => {
    expect(normalizeName('PTSD and anxiety')).toBe('ptsd and anxiety');
    expect(normalizeName('PTSD and anxiety')).not.toBe(normalizeName('PTSD'));
  });
  it('strips identity-neutral qualifier suffixes, repeatedly', () => {
    expect(normalizeName('Tinnitus, unspecified')).toBe('tinnitus');
    expect(normalizeName('PTSD, chronic, unspecified')).toBe('post-traumatic stress disorder');
    expect(normalizeName('Anxiety NOS')).toBe(normalizeName('anxiety disorder'));
  });
  it('strips only a trailing SINGLE-TOKEN parenthetical — a spaced parenthetical is identity-bearing', () => {
    expect(normalizeName('Gastroesophageal reflux disease (GERD)')).toBe('gastroesophageal reflux disease');
    expect(normalizeName('Diabetes mellitus (type 2)')).toBe('diabetes mellitus (type 2)'); // NOT stripped
  });
  it('paren strip still applies after a qualifier strip (fixed-point reduction)', () => {
    expect(normalizeName('Posttraumatic stress disorder (PTSD), chronic')).toBe('post-traumatic stress disorder');
  });
  it('mental-health umbrella folds: depression/MDD variants together; anxiety variants together; GAD separate', () => {
    expect(normalizeName('MDD')).toBe('major depressive disorder');
    expect(normalizeName('Depression')).toBe('major depressive disorder');
    expect(normalizeName('Major depression')).toBe('major depressive disorder');
    expect(normalizeName('Anxiety')).toBe('anxiety disorder');
    // bare anxiety must NOT fold into GAD (an anxiety-NOS row is not necessarily GAD)
    expect(normalizeName('GAD')).toBe('generalized anxiety disorder');
    expect(normalizeName('Anxiety')).not.toBe(normalizeName('GAD'));
  });
  it('NEVER over-collapses diabetes types: type 1 stays distinct from the dm2 fold', () => {
    expect(normalizeName('DM2')).toBe('diabetes mellitus type 2');
    expect(normalizeName('Diabetes mellitus, type 2')).toBe('diabetes mellitus type 2');
    expect(normalizeName('Diabetes mellitus type 1')).toBe('diabetes mellitus type 1');
    expect(normalizeName('Diabetes mellitus type 1')).not.toBe(normalizeName('DM2'));
  });
  it('regression: all six original synonyms still fold', () => {
    expect(normalizeName('OSA')).toBe('obstructive sleep apnea');
    expect(normalizeName('PTSD')).toBe('post-traumatic stress disorder');
    expect(normalizeName('Chronic post-traumatic stress disorder')).toBe('post-traumatic stress disorder');
    expect(normalizeName('HTN')).toBe('hypertension');
    expect(normalizeName('DM2')).toBe('diabetes mellitus type 2');
    expect(normalizeName('HLD')).toBe('hyperlipidemia');
  });
});

describe('dispositionForConfidence (auto-fill gate)', () => {
  it('auto-fills high confidence', () => expect(dispositionForConfidence(0.9)).toBe('autofill'));
  it('flags the middle band for review', () => expect(dispositionForConfidence(0.7)).toBe('needs_review'));
  it('drops low confidence entirely', () => expect(dispositionForConfidence(0.4)).toBe('drop'));
});

// ── Oversized-page cap (2026-06-23): a Blue Button .txt PAGE that alone exceeds the chunk budget must
// be SLICED by char offset (no chunk forces the 32k-output escalation that crashed the run), and every
// slice must keep the [p.N] marker so provenance/grounding still resolve. Normal pages are unchanged. ──
describe('splitOversizedPage (oversized single page → char-offset slices)', () => {
  it('returns the single piece unchanged for a normal-sized page (no behavior change)', () => {
    const marked = `[p.7]\n${'a'.repeat(1000)}`;
    expect(splitOversizedPage(7, marked)).toEqual([marked]);
  });

  it('slices a >budget page into multiple pieces, each re-marked with the same [p.N]', () => {
    const body = 'WORDA '.repeat(20_000); // ~120k chars >> CHUNK_CHARS (48k)
    const marked = `[p.42]\n${body}`;
    const slices = splitOversizedPage(42, marked);
    expect(slices.length).toBeGreaterThan(1);
    for (const s of slices) {
      expect(s.startsWith('[p.42]\n')).toBe(true);
      expect(s.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });
});

describe('chunkDocuments — oversized page does NOT become one giant chunk', () => {
  it('a single page far larger than the budget yields multiple per-page chunks (no escalation-forcing chunk)', () => {
    const doc: BundleDocument = {
      id: 'doc-huge',
      filename: 'BlueButton.txt',
      pages: [{ pageNumber: 1, text: 'X'.repeat(80_000) }], // a real 80k-char Blue Button page
    };
    const chunks = chunkDocuments([doc]);
    // BEFORE the fix this was ONE chunk of ~80k chars (forcing the 32k-output ceiling). Now it's >1.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.pageNumbers).toEqual([1]); // every slice still cites page 1 (grounding intact)
    }
  });

  it('normal multi-page docs chunk exactly as before (no regression)', () => {
    const doc: BundleDocument = {
      id: 'doc-norm',
      filename: 'normal.txt',
      pages: [
        { pageNumber: 1, text: 'p1 '.repeat(100) },
        { pageNumber: 2, text: 'p2 '.repeat(100) },
        { pageNumber: 3, text: 'p3 '.repeat(100) },
      ],
    };
    const chunks = chunkDocuments([doc]);
    // All three small pages fit in one chunk (well under budget) — unchanged behavior.
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.pageNumbers).toEqual([1, 2, 3]);
  });
});
