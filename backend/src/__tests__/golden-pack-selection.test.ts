import { describe, expect, it } from 'vitest';
import { selectPages, type PageSelectorResult } from '../services/page-selector.js';
import { applyPackPageBudget, PACK_PAGE_BUDGET, type BudgetEntry } from '../services/doctor-pack.js';
import {
  buildCoverIndexLines,
  computeTextFingerprint,
  coverPinnedWhyLine,
  dedupPackDocuments,
  orderPackEntriesMedicineFirst,
  type DedupCandidate,
} from '../services/doctor-pack-generate.js';
import type { KeyDocClassification, KeyDocPageRange, KeyDocType } from '../services/db-types.js';
import { RATING_DECISION_PAGES } from './fixtures/golden-pack/rating-decision-11pp.js';
import { DENIAL_LETTER_PAGES } from './fixtures/golden-pack/denial-letter-3pp.js';
import { PROGRESS_NOTES_PAGES } from './fixtures/golden-pack/progress-notes-4pp.js';
import { DD214_PAGES } from './fixtures/golden-pack/dd214-1pp.js';
import { VETERAN_STATEMENT_PAGES } from './fixtures/golden-pack/veteran-statement-2pp.js';

/**
 * GOLDEN PACK SELECTION TEST — assessment 2026-06-12 §1 ("half of it is boilerplate, no
 * clinical notes"). This replicates the LIVE first-pack failure with synthetic-but-realistic
 * page text and asserts the end state Ryan demanded:
 *   - ZERO VA enclosure/appeal boilerplate pages in the pack;
 *   - the rating decision contributes ONLY its decision-table/reasons pages (<= 6pp sc_proof cap);
 *   - the DENIAL narrative pages are IN (Ryan: "not just SC conditions but denials with
 *     explanations");
 *   - the clinical dx pages are present (>= 4pp clinical floor, or all that exist);
 *   - DD-214 + veteran statement present; total <= PACK_PAGE_BUDGET (20).
 *
 * Written RED-FIRST against page-selector 1.1.0 + the flat prefix-fill budget, per Ryan's
 * red->green proof requirement. $0, no AWS, pure in-process.
 */

interface GoldenDoc {
  readonly filePath: string;
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly importance: number;
  readonly pages: readonly string[];
}

const CLAIMED_CONDITION = 'anxiety';

const GOLDEN_DOCS: readonly GoldenDoc[] = [
  { filePath: 'records/Rating_Decision_2025.pdf', docType: 'rating_decision', classification: 'high_signal', importance: 100, pages: RATING_DECISION_PAGES },
  { filePath: 'records/Denial_Letter_Anxiety.pdf', docType: 'denial_letter', classification: 'high_signal', importance: 100, pages: DENIAL_LETTER_PAGES },
  { filePath: 'records/Progress_Notes_BHS.pdf', docType: 'progress_notes', classification: 'normal', importance: 60, pages: PROGRESS_NOTES_PAGES },
  { filePath: 'records/DD214.pdf', docType: 'dd_214', classification: 'high_signal', importance: 95, pages: DD214_PAGES },
  { filePath: 'records/Veteran_Statement.pdf', docType: 'statement_in_support', classification: 'high_signal', importance: 70, pages: VETERAN_STATEMENT_PAGES },
];

function runSelector(doc: GoldenDoc): PageSelectorResult {
  return selectPages({
    filePath: doc.filePath,
    docType: doc.docType,
    classification: doc.classification,
    pageCount: doc.pages.length,
    pages: doc.pages.map((text, i) => ({ pageNumber: i + 1, text, confidence: 0.95 })),
    claimedCondition: CLAIMED_CONDITION,
  });
}

function expandRanges(ranges: readonly KeyDocPageRange[]): number[] {
  return ranges.flatMap((r) => Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i));
}

// Mirror the generate-flow combine step (doctor-pack-generate.ts ~line 320): sort by
// classification tier, importance desc, filePath asc, then apply the pack budget.
function toBudgetEntries(selections: ReadonlyMap<string, PageSelectorResult>): BudgetEntry[] {
  const tierOrder: Record<string, number> = { high_signal: 0, normal: 1, bulk: 2 };
  return GOLDEN_DOCS
    .map((doc) => {
      const sel = selections.get(doc.filePath);
      const pageRanges = sel?.pageRanges ?? [];
      return {
        filePath: doc.filePath,
        docType: doc.docType,
        classification: doc.classification,
        importance: doc.importance,
        pageRanges,
        pageCount: pageRanges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0),
      };
    })
    .sort((a, b) => {
      if (tierOrder[a.classification] !== tierOrder[b.classification]) return (tierOrder[a.classification] ?? 9) - (tierOrder[b.classification] ?? 9);
      if (a.importance !== b.importance) return b.importance - a.importance;
      return a.filePath.localeCompare(b.filePath);
    });
}

describe('GOLDEN PACK — live-failure replication (anxiety case)', () => {
  const selections = new Map<string, PageSelectorResult>(
    GOLDEN_DOCS.map((doc) => [doc.filePath, runSelector(doc)]),
  );
  const budget = applyPackPageBudget(toBudgetEntries(selections), PACK_PAGE_BUDGET);
  const keptPages = new Map<string, number[]>(
    budget.entries.map((e) => [e.filePath, expandRanges(e.pageRanges)]),
  );
  const pagesOf = (filePath: string): number[] => keptPages.get(filePath) ?? [];

  it('includes ZERO VA enclosure/appeal boilerplate pages (rating pages 3-16 are all boilerplate)', () => {
    // Every one of rating pages 3-16 says "service-connected" and "granted" — exactly like the
    // real enclosures. None of them may ship.
    expect(pagesOf('records/Rating_Decision_2025.pdf').filter((p) => p >= 3)).toEqual([]);
    // Denial page 3 is appeal boilerplate.
    expect(pagesOf('records/Denial_Letter_Anxiety.pdf')).not.toContain(3);
  });

  it('ROUND 2 (B): the notification-letter species that survived the live pack are excluded — VALife (p12), VSignals (p13), VA Form 20-0998 QR (p14), monthly-entitlement table (p15), commissary/travel/state benefits (p16)', () => {
    const kept = pagesOf('records/Rating_Decision_2025.pdf');
    for (const boilerplatePage of [12, 13, 14, 15, 16]) {
      expect(kept).not.toContain(boilerplatePage);
    }
    // And the selector's own rationale shows them dying as boilerplate, not as weak-include misses.
    const selection = selections.get('records/Rating_Decision_2025.pdf');
    for (const boilerplatePage of [12, 13, 14, 15, 16]) {
      expect(selection?.selectorRationale).toContain(`p${boilerplatePage}: boilerplate`);
    }
  });

  it('rating decision contributes ONLY its decision-table + reasons pages, within the 6pp sc_proof cap', () => {
    expect(pagesOf('records/Rating_Decision_2025.pdf')).toEqual([1, 2]);
    expect(pagesOf('records/Rating_Decision_2025.pdf').length).toBeLessThanOrEqual(6);
  });

  it('the DENIAL narrative pages are IN (Ryan: "not just SC conditions but denials with explanations")', () => {
    expect(pagesOf('records/Denial_Letter_Anxiety.pdf')).toEqual([1, 2]);
  });

  it('clinical dx pages are present: the GAD assessment page + >= 4pp clinical floor (or all that exist)', () => {
    const notes = pagesOf('records/Progress_Notes_BHS.pdf');
    expect(notes).toContain(2); // "Assessment: Generalized anxiety disorder... Plan: continue escitalopram"
    expect(notes.length).toBeGreaterThanOrEqual(Math.min(4, PROGRESS_NOTES_PAGES.length));
  });

  it('DD-214 and the veteran statement are present', () => {
    expect(pagesOf('records/DD214.pdf')).toEqual([1]);
    expect(pagesOf('records/Veteran_Statement.pdf')).toEqual([1, 2]);
  });

  it(`total pack size is <= ${PACK_PAGE_BUDGET} pages`, () => {
    const total = budget.entries.reduce((sum, e) => sum + e.pageCount, 0);
    expect(total).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
    expect(total).toBeGreaterThan(0);
  });

  it('a real decision page mentioning ONE boilerplate phrase in passing survives (density rule)', () => {
    // Rating p2 (REASONS FOR DECISION) says "See the enclosure for more information." — a
    // single kill-list hit must NOT exclude it.
    expect(pagesOf('records/Rating_Decision_2025.pdf')).toContain(2);
  });

  it('is deterministic: same input -> identical pack', () => {
    const again = applyPackPageBudget(
      toBudgetEntries(new Map(GOLDEN_DOCS.map((doc) => [doc.filePath, runSelector(doc)]))),
      PACK_PAGE_BUDGET,
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(budget));
  });
});

describe('GOLDEN PACK — budget contention (category floors beat flat prefix-fill)', () => {
  // Assessment §1 root cause 1c: "protected docTypes (rating decisions, importance 100) fill
  // all 20 pages before any clinical note is reached." A giant rating decision must NOT starve
  // the clinical notes: clinical has a 4pp FLOOR that fills first.
  function entry(filePath: string, docType: KeyDocType, classification: KeyDocClassification, importance: number, pageCount: number): BudgetEntry {
    return { filePath, docType, classification, importance, pageRanges: [{ from: 1, to: pageCount }], pageCount };
  }

  const entries: BudgetEntry[] = [
    entry('rating_big.pdf', 'rating_decision', 'high_signal', 100, 18),
    entry('dd214.pdf', 'dd_214', 'high_signal', 95, 1),
    entry('statement.pdf', 'statement_in_support', 'high_signal', 70, 2),
    entry('notes.pdf', 'progress_notes', 'normal', 60, 6),
  ];
  const r = applyPackPageBudget(entries, PACK_PAGE_BUDGET);
  const byPath = new Map(r.entries.map((e) => [e.filePath, e]));

  it('clinical floor: the progress notes keep >= 4 pages even against an 18-page rating decision', () => {
    expect(byPath.get('notes.pdf')?.pageCount ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('no document category is starved to zero: every doc keeps at least one page', () => {
    expect(r.entries.map((e) => e.filePath).sort()).toEqual(
      ['dd214.pdf', 'notes.pdf', 'rating_big.pdf', 'statement.pdf'],
    );
    for (const e of r.entries) expect(e.pageCount).toBeGreaterThan(0);
  });

  it('stays within the budget and trims the over-cap sc_proof doc, recording it in trimNotes', () => {
    expect(r.postTrimPageCount).toBeLessThanOrEqual(PACK_PAGE_BUDGET);
    expect((byPath.get('rating_big.pdf')?.pageCount ?? 0)).toBeLessThan(18);
    expect(r.trimNotes.join(' ')).toContain('rating_big.pdf');
  });
});

describe('GOLDEN PACK — small blue-button export carries the dx (Perez live finding 2026-06-12)', () => {
  // A 6-page My-HealtheVet TEXT export whose page 2 IS the diagnosing note. Under the old
  // blanket blue_button hard-exclude this never entered the pack and the regenerated live pack
  // shipped NO_CLINICAL_DX_DOCUMENTATION. Small exports now ride the condition-keyed branch.
  const BLUE_BUTTON_PAGES: readonly string[] = [
    'My HealtheVet Blue Button report. Personal information report generated for veteran.',
    'PCMHI Functional Assessment Consult. DIAGNOSES (DSM-5): Unspecified Anxiety Disorder. Assessment: anxiety, chronic, related to pain. Plan: continue escitalopram.',
    'Allergies: NKDA. Immunizations list. Influenza 2024.',
    'Vitals history. BP readings table.',
    'Appointment history. Past appointments list.',
    'End of report. My HealtheVet download footer.',
  ];

  const selection = selectPages({
    filePath: 'records/bb_export.txt',
    docType: 'blue_button',
    classification: 'bulk',
    pageCount: BLUE_BUTTON_PAGES.length,
    pages: BLUE_BUTTON_PAGES.map((text, i) => ({ pageNumber: i + 1, text, confidence: 0.99 })),
    claimedCondition: 'anxiety',
  });

  it('selects the dx page via the condition-keyed branch instead of default-excluding', () => {
    expect(selection.selectorRationale).toContain('blue_button_condition_or_recent');
    const pages = selection.pageRanges.flatMap((r) => Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from + k));
    expect(pages).toContain(2); // the PCMHI dx page
  });

  it('a LARGE blue-button dump (40pp) stays default-excluded', () => {
    const big = selectPages({
      filePath: 'records/bb_big_dump.txt',
      docType: 'blue_button',
      classification: 'bulk',
      pageCount: 40,
      pages: Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, text: i === 1 ? 'anxiety mentioned here' : `filler page ${i}`, confidence: 0.99 })),
      claimedCondition: 'anxiety',
    });
    expect(big.pageRanges).toEqual([]);
    expect(big.selectorRationale).toContain('default_exclude (blue_button)');
  });

  it('the kept blue-button pages count as CLINICAL in the budget (floor-protected, not other)', () => {
    const entries: BudgetEntry[] = [
      { filePath: 'rating.pdf', docType: 'rating_decision', classification: 'high_signal', importance: 100, pageRanges: Array.from({ length: 18 }, (_, i) => ({ from: i + 1, to: i + 1 })) as KeyDocPageRange[], pageCount: 18 },
      { filePath: 'bb_export.txt', docType: 'blue_button', classification: 'bulk', importance: 40, pageRanges: selection.pageRanges, pageCount: selection.pageRanges.reduce((n, r) => n + (r.to - r.from + 1), 0) },
    ];
    const r = applyPackPageBudget(entries, PACK_PAGE_BUDGET);
    const bb = r.entries.find((e) => e.filePath === 'bb_export.txt');
    expect(bb).toBeDefined();
    expect(bb!.pageCount).toBeGreaterThan(0);
  });
});

// ============================================================================================
// ROUND 2 (backlog §"Doctor-pack round 2", PCP re-review 2026-06-12)
// ============================================================================================

describe('ROUND 2 (A) — content-hash dedup (Misc_6=Misc_8 live failure shape)', () => {
  const PAGES = [
    { pageNumber: 1, text: 'My HealtheVet export. PCMHI consult: Unspecified Anxiety Disorder.' },
    { pageNumber: 2, text: 'Plan: continue escitalopram. Follow up in 3 months.' },
  ];
  const candidate = (over: Partial<DedupCandidate>): DedupCandidate => ({
    filePath: 'cases/C1/aaaa-Misc_6.pdf',
    displayName: 'Misc_6.pdf',
    fileSha256: '',
    textFingerprint: computeTextFingerprint(PAGES),
    docType: 'blue_button',
    importance: 40,
    uploadIndex: 0,
    ...over,
  });

  it('two identical-content docs under different filenames → ONE survives + a duplicate note naming the kept file', () => {
    const r = dedupPackDocuments([
      candidate({}),
      candidate({ filePath: 'cases/C1/bbbb-Misc_8.pdf', displayName: 'Misc_8.pdf', uploadIndex: 1 }),
    ]);
    expect(r.duplicateOf.size).toBe(1);
    expect(r.duplicateOf.get('cases/C1/bbbb-Misc_8.pdf')).toBe('cases/C1/aaaa-Misc_6.pdf'); // earliest upload kept
    expect(r.notes).toEqual(['Misc_8.pdf: duplicate of Misc_6.pdf (identical content) — omitted']);
  });

  it('matching file-byte sha256 alone (no OCR text yet) also establishes identity', () => {
    const r = dedupPackDocuments([
      candidate({ fileSha256: 'f'.repeat(64), textFingerprint: null }),
      candidate({ filePath: 'cases/C1/bbbb-Copy.pdf', displayName: 'Copy.pdf', fileSha256: 'f'.repeat(64), textFingerprint: null, uploadIndex: 1 }),
    ]);
    expect(r.duplicateOf.get('cases/C1/bbbb-Copy.pdf')).toBe('cases/C1/aaaa-Misc_6.pdf');
  });

  it('the better-classified copy is kept even when uploaded LATER (unspecified loses to a real docType)', () => {
    const r = dedupPackDocuments([
      candidate({ docType: 'unspecified', importance: 40, uploadIndex: 0 }),
      candidate({ filePath: 'cases/C1/bbbb-BlueButton.pdf', displayName: 'BlueButton.pdf', docType: 'blue_button', importance: 40, uploadIndex: 1 }),
    ]);
    expect(r.duplicateOf.get('cases/C1/aaaa-Misc_6.pdf')).toBe('cases/C1/bbbb-BlueButton.pdf');
  });

  it('different content never groups; docs with no sha AND no text never group', () => {
    const r = dedupPackDocuments([
      candidate({}),
      candidate({ filePath: 'cases/C1/cccc-Other.pdf', displayName: 'Other.pdf', textFingerprint: computeTextFingerprint([{ pageNumber: 1, text: 'A completely different rating decision document.' }]), uploadIndex: 1 }),
      candidate({ filePath: 'cases/C1/dddd-Empty1.pdf', displayName: 'Empty1.pdf', textFingerprint: null, uploadIndex: 2 }),
      candidate({ filePath: 'cases/C1/eeee-Empty2.pdf', displayName: 'Empty2.pdf', textFingerprint: null, uploadIndex: 3 }),
    ]);
    expect(r.duplicateOf.size).toBe(0);
    expect(r.notes).toEqual([]);
  });

  it('the text fingerprint normalizes whitespace/case jitter and ignores blank pages', () => {
    const a = computeTextFingerprint(PAGES);
    const b = computeTextFingerprint([
      { pageNumber: 1, text: '  My   HealtheVet export.\nPCMHI consult: unspecified anxiety disorder.  ' },
      { pageNumber: 2, text: 'Plan: continue escitalopram.   Follow up in 3 months.' },
      { pageNumber: 3, text: '   ' },
    ]);
    expect(a).toBe(b);
    expect(computeTextFingerprint([])).toBeNull();
    expect(computeTextFingerprint([{ pageNumber: 1, text: '  ' }])).toBeNull();
  });
});

describe('ROUND 2 (E) — medicine-first manifest order', () => {
  interface E { docType: KeyDocType; importance: number; filePath: string }
  const e = (docType: KeyDocType, importance: number, filePath: string): E => ({ docType, importance, filePath });

  it('orders clinical → lay → denial → sc_proof → tests → service → other; importance then path within category', () => {
    const shuffled: E[] = [
      e('dd_214', 95, 'dd214.pdf'),
      e('rating_decision', 100, 'rating.pdf'),
      e('imaging', 80, 'mri.pdf'),
      e('lay_statement', 70, 'statement.pdf'),
      e('denial_letter', 100, 'denial.pdf'),
      e('progress_notes', 60, 'notes_b.pdf'),
      e('c_and_p_exam', 100, 'cnp.pdf'),
      e('progress_notes', 60, 'notes_a.pdf'),
      e('nexus_letter_prior', 90, 'old_nexus.pdf'),
    ];
    const ordered = orderPackEntriesMedicineFirst(shuffled, (x) => x);
    expect(ordered.map((x) => x.filePath)).toEqual([
      'cnp.pdf', // clinical, importance 100
      'notes_a.pdf', // clinical, 60, path tiebreak
      'notes_b.pdf',
      'statement.pdf', // lay
      'denial.pdf', // denial
      'rating.pdf', // sc_proof
      'mri.pdf', // tests
      'dd214.pdf', // service
      'old_nexus.pdf', // other
    ]);
  });

  it('is deterministic (same input → same order, input untouched)', () => {
    const input: E[] = [e('dd_214', 95, 'a.pdf'), e('progress_notes', 60, 'b.pdf')];
    const snapshot = JSON.stringify(input);
    const once = orderPackEntriesMedicineFirst(input, (x) => x);
    const twice = orderPackEntriesMedicineFirst(input, (x) => x);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('ROUND 2 (D) — cover-index page body', () => {
  const lines = buildCoverIndexLines({
    caseId: 'CASE-77',
    claimedCondition: 'obstructive sleep apnea',
    claimType: 'secondary',
    framingChoice: 'secondary to service-connected condition',
    upstreamScCondition: 'PTSD',
    entries: [
      { displayLabel: 'Clinical notes — SleepClinic.pdf', category: 'clinical', pageRanges: [{ from: 2, to: 3 }], mentionsClaimedCondition: true },
      { displayLabel: 'Veteran statement (from intake)', category: 'lay', pageRanges: [{ from: 1, to: 1 }], mentionsClaimedCondition: true },
      { displayLabel: 'Denial letter — Hip_Denial.pdf', category: 'denial', pageRanges: [{ from: 1, to: 2 }], mentionsClaimedCondition: false },
      { displayLabel: 'Rating decision — Misc_1.pdf', category: 'sc_proof', pageRanges: [], mentionsClaimedCondition: true },
    ],
    notIncluded: ['Misc_8.pdf: duplicate of Misc_6.pdf (identical content) — omitted', 'No lay statement on file'],
  });
  const body = lines.join('\n');

  it('leads with case id, claimed condition, and the theory line (framing + upstream SC)', () => {
    expect(lines[0]).toBe('Case CASE-77 — claimed condition: obstructive sleep apnea');
    expect(lines[1]).toBe('Theory: secondary to service-connected condition — upstream service-connected condition: PTSD');
  });

  it('each included doc gets displayLabel — pages kept — plain-English WHY', () => {
    expect(body).toContain('1. Clinical notes — SleepClinic.pdf — p2-3 — Clinical documentation of the claimed condition — read first.');
    expect(body).toContain("2. Veteran statement (from intake) — p1 — The veteran's own account and timeline.");
    expect(body).toContain('4. Rating decision — Misc_1.pdf — all pages — Proof of the service-connected condition(s) the theory builds on.');
  });

  it("the PCP's non-obvious case: a denial of a DIFFERENT condition explains itself (the nexus must not lean on it)", () => {
    expect(body).toContain('3. Denial letter — Hip_Denial.pdf — p1-2 — Denial of a DIFFERENT condition — shows it is NOT service-connected; the nexus must not lean on it.');
  });

  it('carries the Not-included list verbatim', () => {
    expect(body).toContain('Not included:');
    expect(body).toContain('- Misc_8.pdf: duplicate of Misc_6.pdf (identical content) — omitted');
    expect(body).toContain('- No lay statement on file');
  });

  it('falls back to claimType for the theory line and notes when nothing was omitted', () => {
    const minimal = buildCoverIndexLines({ caseId: 'C2', claimedCondition: 'tinnitus', claimType: 'initial', framingChoice: null, upstreamScCondition: null, entries: [], notIncluded: [] });
    expect(minimal[1]).toBe('Theory: initial');
    expect(minimal.join('\n')).toContain('(nothing was omitted)');
  });
});

// ============ doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): cover WHY lines ============
describe('cover index — pinned-page WHY lines (PR-3)', () => {
  it('(c) coverPinnedWhyLine carries the grant quote + the fact-kind phrase, FRN-style (no em dash / smart quotes)', () => {
    const line = coverPinnedWhyLine(412, 'sc_condition', 'PTSD 70% service-connected');
    expect(line).toBe('p412: service-connected condition grant - "PTSD 70% service-connected"');
    // FRN style guard: plain hyphen + straight quotes only.
    expect(line).not.toMatch(/[—–“”‘’]/);
  });

  it('(c) the cover index emits one indented pinned line per surviving pinned page, carrying the grant quote', () => {
    const lines = buildCoverIndexLines({
      caseId: 'CASE-BB',
      claimedCondition: 'obstructive sleep apnea',
      claimType: 'secondary',
      framingChoice: 'secondary to service-connected condition',
      upstreamScCondition: 'PTSD',
      entries: [
        {
          displayLabel: 'Blue Button dump — Blue_Button_VA.pdf',
          category: 'other',
          pageRanges: [{ from: 412, to: 412 }, { from: 870, to: 870 }],
          mentionsClaimedCondition: false,
          pinnedWhyLines: [
            coverPinnedWhyLine(412, 'sc_condition', 'PTSD 70% service-connected'),
            coverPinnedWhyLine(870, 'active_medication', 'prazosin 2mg nightly'),
          ],
        },
      ],
      notIncluded: [],
    });
    const body = lines.join('\n');
    // The grant quote rides into the cover under its document, indented as a pinned line.
    expect(body).toContain('   pinned p412: service-connected condition grant - "PTSD 70% service-connected"');
    expect(body).toContain('   pinned p870: active medication - "prazosin 2mg nightly"');
  });

  it('(d) NO pinnedWhyLines ⇒ cover body byte-identical to the pre-PR-3 cover (no pinned lines emitted)', () => {
    const args = {
      caseId: 'CASE-NP',
      claimedCondition: 'tinnitus',
      claimType: 'initial' as const,
      framingChoice: null,
      upstreamScCondition: null,
      entries: [
        { displayLabel: 'DD-214 — dd214.pdf', category: 'service' as const, pageRanges: [{ from: 1, to: 1 }], mentionsClaimedCondition: false },
      ],
      notIncluded: [],
    };
    const withoutField = buildCoverIndexLines(args).join('\n');
    // Adding an EMPTY pinnedWhyLines array must not change a single byte (absent === empty).
    const withEmpty = buildCoverIndexLines({
      ...args,
      entries: [{ ...args.entries[0]!, pinnedWhyLines: [] }],
    }).join('\n');
    expect(withEmpty).toBe(withoutField);
    expect(withoutField).not.toContain('pinned ');
  });
});
