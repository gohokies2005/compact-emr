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
  it('progress_notes: empty pages with explanatory rationale', () => {
    const r = run('progress_notes', [p(1, 'visit note 2024-01-15')]);
    expect(r.pageRanges).toEqual([]);
    expect(r.selectorRationale).toContain('default_exclude');
  });

  it('blue_button: empty pages', () => {
    const r = run('blue_button', [p(1, 'full health record dump')]);
    expect(r.pageRanges).toEqual([]);
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

  it('high-signal fallback: if <2 page matches, includes all + flags RN', () => {
    const r = run('rating_decision', [
      p(1, 'cover sheet'),
      p(2, 'letterhead only'),
      p(3, 'we have granted PTSD service connection'), // 1 match
      p(4, 'how to appeal — your rights — notice of disagreement'),
    ]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 4 }]);
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
  it('small unspecified (<=8 pages): include all + RN review flag', () => {
    const r = run('unspecified', [p(1, 'mystery doc page 1'), p(2, 'mystery doc page 2')]);
    expect(r.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(r.needsRnReview).toBe(true);
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
