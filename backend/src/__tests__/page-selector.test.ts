import { describe, expect, it } from 'vitest';
import { PAGE_SELECTOR_VERSION, selectPages, type PageSelectorInputPage } from '../services/page-selector.js';
import type { KeyDocClassification, KeyDocType } from '../services/db-types.js';

function p(pageNumber: number, text: string, confidence: number | null = 0.95): PageSelectorInputPage {
  return { pageNumber, text, confidence };
}

function run(docType: KeyDocType, pages: readonly PageSelectorInputPage[], opts: { classification?: KeyDocClassification; physicianIncludeAllPages?: boolean; pageCount?: number; filePath?: string } = {}) {
  return selectPages({
    filePath: opts.filePath ?? 'records/test.pdf',
    docType,
    classification: opts.classification ?? 'high_signal',
    pageCount: opts.pageCount ?? pages.length,
    pages,
    physicianIncludeAllPages: opts.physicianIncludeAllPages ?? false,
  });
}

describe('selectPages — physician override', () => {
  it('returns all pages when physicianIncludeAllPages is true, regardless of rules', () => {
    const r = run('rating_decision', [p(1, 'irrelevant text')], { physicianIncludeAllPages: true });
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
    expect(r.selectorRationale).toBe('physician_override');
    expect(r.needsRnReview).toBe(false);
  });
});

describe('selectPages — empty / no per-page text', () => {
  it('returns empty ranges + rationale when no pages provided', () => {
    const r = run('rating_decision', [], { pageCount: 10 });
    expect(r.pageRanges).toEqual([]);
    expect(r.selectorRationale).toBe('no_per_page_text_available');
  });
});

describe('selectPages — always-all doc types', () => {
  it('DD-214: all pages', () => {
    const r = run('dd_214', [p(1, 'service'), p(2, 'characterization')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(r.selectorRationale).toContain('small_doc_always_all');
  });

  it('audiogram: all pages', () => {
    const r = run('audiogram', [p(1, 'audiometric data')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
  });

  it('lay_statement: all pages', () => {
    const r = run('lay_statement', [p(1, 'I have known the veteran for 20 years')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
  });

  it('tera_memo: all pages', () => {
    const r = run('tera_memo', [p(1, 'TERA exposure conceded')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
  });
});

describe('selectPages — default-exclude doc types', () => {
  it('blue_button: empty pages', () => {
    const r = run('blue_button', [p(1, 'full health record dump')]);
    expect(r.pageRanges).toEqual([]);
  });
});

// Chunk D (2026-06-11): progress notes are no longer blanket-excluded — Ryan's spec wants the
// most recent/pertinent visit notes IN. Include = mentions the claimed condition OR belongs to
// the most recent encounter (the doc's max parsed date).
describe('selectPages — progress_notes condition / recent-encounter rules', () => {
  function runNotes(pages: readonly PageSelectorInputPage[], claimedCondition?: string) {
    return selectPages({
      filePath: 'records/Misc_7.pdf',
      docType: 'progress_notes',
      classification: 'bulk',
      pageCount: pages.length,
      pages,
      ...(claimedCondition !== undefined ? { claimedCondition } : {}),
    });
  }

  it('includes pages mentioning the claimed condition, excludes unrelated notes', () => {
    const r = runNotes(
      [
        p(1, 'Encounter 01/05/2020. Podiatry follow-up, ingrown toenail resolved without issue today.'),
        p(2, 'Encounter 02/10/2021. Veteran reports worsening obstructive sleep apnea; CPAP compliance reviewed in detail.'),
        p(3, 'Encounter 03/15/2022. Sleep clinic: apnea symptoms persist despite therapy adjustments this year.'),
      ],
      'obstructive sleep apnea',
    );
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toContain(2);
    expect(included).toContain(3); // p3 also carries the doc's most recent date
    expect(included).not.toContain(1);
    expect(r.selectorRationale).toContain('mentions_claimed_condition');
  });

  it('includes the most recent encounter pages even without a condition mention', () => {
    const r = runNotes(
      [
        p(1, 'Encounter 01/05/2020. Routine dermatology check, benign nevus monitored, no change.'),
        p(2, 'Encounter 06/20/2024. Annual physical: blood pressure stable, labs reviewed with patient.'),
      ],
      'tinnitus',
    );
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toEqual([2]);
    expect(r.selectorRationale).toContain('most_recent_encounter');
  });

  it('returns empty when nothing mentions the condition and no dates parse', () => {
    const r = runNotes(
      [p(1, 'General wellness counseling provided. Patient verbalized understanding of the plan.')],
      'tinnitus',
    );
    expect(r.pageRanges).toEqual([]);
    expect(r.selectorRationale).toContain('progress_notes_no_condition_or_recent_match');
    expect(r.needsRnReview).toBe(false);
  });

  it('without claimedCondition, falls back to the recent-encounter rule alone', () => {
    const r = runNotes([
      p(1, 'Visit March 3, 2021: knee brace fitted, exercises reviewed and demonstrated correctly.'),
      p(2, 'Visit March 3, 2023: knee pain worsening, MRI ordered for further evaluation today.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toEqual([2]);
  });
});

describe('selectPages — imaging rules (Chunk D)', () => {
  it('small imaging report (<=2 pages): all pages', () => {
    const r = run('imaging', [p(1, 'MRI lumbar spine. Impression: L4-L5 disc herniation.')], { pageCount: 1 });
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
    expect(r.selectorRationale).toContain('small_doc_shortcut');
  });

  it('large imaging doc: selects the impression/findings pages only', () => {
    const r = run('imaging', [
      p(1, 'Patient demographics and order information for the requested radiology study series.'),
      p(2, 'Findings: Moderate degenerative disc disease at L4-L5 with posterior disc bulge noted.'),
      p(3, 'Impression: 1. L4-L5 disc herniation with nerve root impingement. 2. Facet arthropathy.'),
      p(4, 'Technical acquisition parameters and series listing for archival reference purposes only.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toContain(2);
    expect(included).toContain(3);
    expect(included).not.toContain(1);
    expect(included).not.toContain(4);
  });
});

describe('selectPages — rating_decision real-world VA phrasings (Chunk D)', () => {
  it.each([
    'We have made a decision on your claim for benefits received in March 2024.',
    'Entitlement to service connection for obstructive sleep apnea is established effective June 1, 2023.',
    'REASONS FOR DECISION\n\nThe examiner reviewed the record in connection with the issue on appeal.',
    'Evaluation of post-traumatic stress disorder, currently 50 percent, is continued.',
  ])('includes a page reading "%s"', (text) => {
    // Two matching pages so the high-signal <2-match fallback doesn't mask the rule under test.
    const r = run('rating_decision', [p(1, text), p(2, text)]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(r.needsRnReview).toBe(false);
  });
});

describe('selectPages — rating_decision rules', () => {
  it('picks the decision page, skips appeal-rights boilerplate', () => {
    const r = run('rating_decision', [
      p(1, 'Department of Veterans Affairs — Rating Decision'),
      p(2, 'Decision\n\nWe have granted service connection for PTSD at 70 percent.'),
      p(3, 'Reasons and Bases\n\nThe evidence considered includes the C&P exam dated 2024-03-15.'),
      p(4, 'How to appeal\n\nIf you disagree with this decision, you may file a Notice of Disagreement. Your appeal rights are explained below.'),
      p(5, 'VA Form 9 — Substantive Appeal\n\nNotice of Disagreement\n\nAppellate review by the Board of Veterans\' Appeals'),
    ]);
    const includedPages = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedPages).toContain(2);
    expect(includedPages).toContain(3);
    expect(includedPages).not.toContain(4);
    expect(includedPages).not.toContain(5);
    expect(r.needsRnReview).toBe(false);
  });

  // Assessment 2026-06-12 §1a (page-selector 1.2.0) — DELIBERATE flip: the fallback now
  // returns all NON-boilerplate pages (was: ALL pages). p4 is appeal boilerplate and may
  // never ship, even under the "decision is in here somewhere" fallback.
  it('high-signal fallback: if <2 page matches, includes all NON-boilerplate pages + flags RN', () => {
    const r = run('rating_decision', [
      p(1, 'cover sheet'),
      p(2, 'letterhead only'),
      p(3, 'we have granted PTSD service connection'), // 1 match
      p(4, 'how to appeal — your rights — notice of disagreement'),
    ]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 3 }]);
    expect(r.needsRnReview).toBe(true);
    expect(r.selectorRationale).toContain('high_signal_fallback');
  });

  it('matches alternative grant phrasings ("we have granted", "service-connected", "granted at")', () => {
    const r = run('rating_decision', [
      p(1, 'We have granted service connection.'),
      p(2, 'Granted at 70 percent.'),
    ]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
  });
});

describe('selectPages — denial_letter rules', () => {
  it('picks denial-decision pages, skips appeal-rights boilerplate', () => {
    const r = run('denial_letter', [
      p(1, 'Department of Veterans Affairs'),
      p(2, 'Decision\n\nWe have denied your claim for service connection of OSA.'),
      p(3, 'Reasons and Bases\n\nThe evidence considered did not establish a nexus.'),
      p(4, 'How to appeal this decision. Your rights to appellate review. Notice of Disagreement instructions.'),
    ]);
    const includedPages = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedPages).toContain(2);
    expect(includedPages).toContain(3);
    expect(includedPages).not.toContain(4);
  });
});

describe('selectPages — DBQ rules', () => {
  it('small DBQ (<=2 pages) → all pages', () => {
    const r = run('dbq', [p(1, 'DBQ for sleep apnea')], { pageCount: 1 });
    expect(r.pageRanges).toEqual([{ from: 1, to: 1 }]);
    expect(r.selectorRationale).toContain('small_doc_shortcut');
  });

  it('large DBQ: picks checked-box + signature pages', () => {
    const r = run('dbq', [
      p(1, 'Section 1: Diagnosis\n\nDiagnosis: PTSD'),
      p(2, 'Section 2: Findings\n[X] symptoms present\n[X] criteria met'),
      p(3, 'instructions for completing this form'),
      p(4, 'examiner signature\nphysician signature: Dr. Smith'),
    ]);
    const includedPages = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedPages).toContain(1);
    expect(includedPages).toContain(2);
    expect(includedPages).toContain(4);
  });
});

describe('selectPages — C&P exam rules', () => {
  it('picks diagnosis + opinion + rationale pages, skips claimant-info header', () => {
    const r = run('c_and_p_exam', [
      p(1, 'Claimant Information: name, address, file number'),
      p(2, 'Diagnosis\n\nThe veteran has obstructive sleep apnea per polysomnography.'),
      p(3, 'Medical Opinion\n\nIt is at least as likely as not that...'),
      p(4, 'Rationale\n\nThe peer-reviewed literature supports a 2x relative risk for OSA in PTSD veterans.'),
    ]);
    const includedPages = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedPages).toContain(2);
    expect(includedPages).toContain(3);
    expect(includedPages).toContain(4);
    expect(includedPages).not.toContain(1);
  });
});

describe('selectPages — sleep study rules', () => {
  it('picks impression + AHI summary pages, skips raw-waveform blank pages', () => {
    const r = run('sleep_study', [
      p(1, 'Polysomnography Report'), // less than 50 alpha chars? has > 50 → not blank
      p(2, 'Impression\n\nModerate obstructive sleep apnea.'),
      p(3, 'AHI: 18.4 events per hour. ODI: 22 events per hour.'),
      p(4, '   '), // raw waveform / blank page heuristic
    ]);
    const includedPages = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedPages).toContain(2);
    expect(includedPages).toContain(3);
    expect(includedPages).not.toContain(4);
  });
});

describe('selectPages — benefit_summary special case', () => {
  it('always returns first 3 pages', () => {
    const r = run('benefit_summary', [
      p(1, 'page 1'),
      p(2, 'page 2'),
      p(3, 'page 3'),
      p(4, 'page 4'),
      p(5, 'page 5'),
    ]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 3 }]);
    expect(r.selectorRationale).toBe('benefit_summary_first_3_pages');
  });

  it('handles smaller-than-3-page benefit summaries gracefully', () => {
    const r = run('benefit_summary', [p(1, 'page 1'), p(2, 'page 2')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
  });
});

describe('selectPages — unspecified doc type', () => {
  // Item 3 flag-volume cut (2026-06-11): DELIBERATE behavior flip. Small unspecified docs are
  // included in full, so no pages can have been silently dropped — they no longer flood the RN
  // "Doc selection review" queue. (Was needsRnReview=true.)
  it('small unspecified (<=8 pages): include all, NO RN review flag (included-in-full = low risk)', () => {
    const r = run('unspecified', [p(1, 'mystery doc page 1'), p(2, 'mystery doc page 2')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(r.selectorRationale).toBe('unspecified_small_doc_all_pages');
    expect(r.needsRnReview).toBe(false);
  });

  it('large unspecified (>8 pages): first 8 + RN review flag', () => {
    const pages = Array.from({ length: 12 }, (_, i) => p(i + 1, `page ${i + 1}`));
    const r = run('unspecified', pages);
    expect(r.pageRanges).toEqual([{ from: 1, to: 8 }]);
    expect(r.needsRnReview).toBe(true);
  });
});

describe('selectPages — range merging', () => {
  it('merges adjacent included pages into a single range', () => {
    const r = run('rating_decision', [
      p(1, 'we have granted'),
      p(2, 'reasons and bases for the decision'),
      p(3, 'evidence considered'),
      p(4, 'how to appeal — your rights — notice of disagreement'), // excluded
      p(5, 'service connection is established'),
    ]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 3 }, { from: 5, to: 5 }]);
  });
});

// Assessment 2026-06-12 §1a (page-selector 1.2.0): benefits-enclosure kill-list + tiered
// includes. The live failure: VA "Additional Benefits" enclosures say "service-connected"
// and "granted" on every page and sailed into the pack.
describe('selectPages — benefits-enclosure boilerplate kill-list (1.2.0)', () => {
  it('excludes a benefits enclosure page even though it says "service-connected" and "granted"', () => {
    const r = run('rating_decision', [
      p(1, 'REASONS FOR DECISION\n\nEntitlement to service connection for lumbar strain is granted.'),
      p(2, 'Evaluation of lumbar strain is assigned at 40 percent based on limitation of motion.'),
      p(3, 'What You Should Know About Additional Benefits — Enclosure 2\n\nBecause you are a service-connected veteran whose claim has been granted, you may be eligible for vocational rehabilitation.'),
      p(4, 'Veterans Crisis Line\n\nIf you are a veteran in crisis — even if not service-connected or granted benefits — Dial 988 then Press 1.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toEqual([1, 2]);
    expect(r.needsRnReview).toBe(false);
  });

  it('density rule: a REAL decision page mentioning one boilerplate phrase in passing survives', () => {
    const r = run('rating_decision', [
      p(1, 'REASONS FOR DECISION\n\nWe have granted service connection. See the enclosure for more information.'),
      p(2, 'An evaluation of 40 percent is assigned because flexion is limited to 25 degrees.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toContain(1); // one 'enclosure' hit is NOT boilerplate (needs >= 2 distinct)
    expect(included).toContain(2);
  });

  it('weak tokens (bare granted/service-connect) count only when a strong anchor fired in the doc', () => {
    // Doc A: strong anchor on p1 -> the weak-only p2 rides in.
    const withStrong = run('rating_decision', [
      p(1, 'REASONS FOR DECISION\n\nEntitlement to service connection for tinnitus is granted.'),
      p(2, 'The veteran is service-connected for tinnitus and the granted evaluation is unchanged in this narrative continuation.'),
    ]);
    const includedA = withStrong.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(includedA).toEqual([1, 2]);
    expect(withStrong.needsRnReview).toBe(false);

    // Doc B: NO strong anchor anywhere -> weak tokens alone select nothing; the high-signal
    // fallback takes over (all non-boilerplate pages + RN review).
    const weakOnly = run('rating_decision', [
      p(1, 'Your service-connected benefits summary is enclosed for reference purposes granted to you.'),
      p(2, 'Thank you for your service. This page mentions granted benefits only in passing.'),
      p(3, 'General correspondence text without any decision language at all beyond being granted.'),
    ]);
    expect(weakOnly.needsRnReview).toBe(true);
    expect(weakOnly.selectorRationale).toContain('high_signal_fallback');
  });

  it('combined-rating math table page is excluded (PCP NEVER list)', () => {
    const r = run('rating_decision', [
      p(1, 'REASONS FOR DECISION\n\nEntitlement to service connection for lumbar strain is granted.'),
      p(2, 'Evaluation of lumbar strain is assigned at 40 percent under diagnostic code 5237.'),
      p(3, 'How VA Combines Ratings — Combined Ratings Table — Enclosure 3\n\nFor service-connected granted disabilities, 40 combined with 10 is 46 percent.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).not.toContain(3);
  });

  it('denial letter: narrative continuation page with only weak "is denied" rides in on page-1 strong anchors', () => {
    const r = run('denial_letter', [
      p(1, 'We made a decision on your claim.\n\nREASONS FOR DECISION\n\nService connection for anxiety is denied because the evidence does not show a link to service.'),
      p(2, 'The examiner opined the condition was less likely than not related. The claimed condition of generalized anxiety disorder is denied.'),
      p(3, 'Your Rights to Appeal Our Decision\n\nYou may file a Notice of Disagreement or complete VA Form 9 for appellate review.'),
    ]);
    const included = r.pageRanges.flatMap((rg) => Array.from({ length: rg.to - rg.from + 1 }, (_, i) => rg.from + i));
    expect(included).toEqual([1, 2]);
  });
});

describe('selectPages — invariants', () => {
  it('selectorVersion is always set', () => {
    const r = run('rating_decision', [p(1, 'decision granted')]);
    expect(r.selectorVersion).toBe(PAGE_SELECTOR_VERSION);
  });

  it('does not mutate the input pages array', () => {
    const input = [p(1, 'decision granted'), p(2, 'reasons')];
    const before = JSON.stringify(input);
    run('rating_decision', input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// doctor-pack grounded pages, 2026-06-13 (PR-2): grounded pages union into EVERY path, including
// the blue_button hard-exclude. groundedPages absent ⇒ byte-identical (covered implicitly by the
// 37 tests above that never pass it; here we assert the union behavior when present).
describe('selectPages — grounded-page union (PR-2)', () => {
  const bbPages = Array.from({ length: 20 }, (_, i) => p(i + 1, 'blue button dump page'));

  it('pulls a grounded page out of a hard-excluded large Blue Button (BB-as-a-whole stays excluded)', () => {
    const r = selectPages({
      filePath: 'records/Blue_Button_VA.pdf',
      docType: 'blue_button',
      classification: 'bulk',
      pageCount: 900,
      pages: bbPages,
      groundedPages: [412, 870],
    });
    // Only the grounded pages — NOT the whole dump.
    expect(r.pageRanges).toEqual([{ from: 412, to: 412 }, { from: 870, to: 870 }]);
    expect(r.selectorRationale).toContain('grounded page');
  });

  it('unions grounded pages WITH a normal selection and coalesces adjacency', () => {
    const r = selectPages({
      filePath: 'records/rating.pdf',
      docType: 'rating_decision',
      classification: 'high_signal',
      pageCount: 5,
      pages: [p(1, 'Rating decision: granted.'), p(2, 'continued'), p(3, 'x'), p(4, 'y'), p(5, 'z')],
      groundedPages: [2, 3],
    });
    // rating_decision (high_signal) selects all 5; grounded [2,3] already inside → no change, no suffix.
    expect(r.pageRanges).toEqual([{ from: 1, to: 5 }]);
    expect(r.selectorRationale).not.toContain('grounded page');
  });

  it('drops grounded page numbers outside [1, pageCount] (defensive)', () => {
    const r = selectPages({
      filePath: 'records/Blue_Button_VA.pdf',
      docType: 'blue_button',
      classification: 'bulk',
      pageCount: 100,
      pages: bbPages,
      groundedPages: [50, 0, 999, -3],
    });
    expect(r.pageRanges).toEqual([{ from: 50, to: 50 }]);
  });

  it('groundedPages empty ⇒ unchanged blue_button hard-exclude (flag-off shape)', () => {
    const r = selectPages({
      filePath: 'records/Blue_Button_VA.pdf',
      docType: 'blue_button',
      classification: 'bulk',
      pageCount: 900,
      pages: bbPages,
      groundedPages: [],
    });
    expect(r.pageRanges).toEqual([]);
    expect(r.selectorRationale).not.toContain('grounded page');
  });
});
