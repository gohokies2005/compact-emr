import { describe, it, expect } from 'vitest';
import {
  locateExtractionInputs,
  groundExtractedItem,
  normalizeName,
  normalizeForQuoteMatch,
  dispositionForConfidence,
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
});

describe('dispositionForConfidence (auto-fill gate)', () => {
  it('auto-fills high confidence', () => expect(dispositionForConfidence(0.9)).toBe('autofill'));
  it('flags the middle band for review', () => expect(dispositionForConfidence(0.7)).toBe('needs_review'));
  it('drops low confidence entirely', () => expect(dispositionForConfidence(0.4)).toBe('drop'));
});
