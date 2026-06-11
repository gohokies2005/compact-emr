import { describe, expect, it } from 'vitest';
import {
  classifyContentText,
  classifyDocument,
  classifyFile,
  classifyFileWithContentHint,
  CLASSIFIER_VERSION,
  isHighSignal,
  mapDocTagToDocType,
  sortByDoctorPackPriority,
} from '../services/key-docs-classifier.js';

describe('classifyFile', () => {
  it.each([
    ['ClaimLetter-2024-3-12.pdf', 'high_signal', 'rating_decision'],
    ['RatingDecision-2023.pdf', 'high_signal', 'rating_decision'],
    ['Rated_Disabilities_view.pdf', 'high_signal', 'rated_disabilities_view'],
    ['View_Your_VA_Disability_Ratings.pdf', 'high_signal', 'rated_disabilities_view'],
    ['DenialLetter-2024.pdf', 'high_signal', 'denial_letter'],
    ['DBQ-OSA-2024.pdf', 'high_signal', 'dbq'],
    ['CandP_Exam_2024.pdf', 'high_signal', 'c_and_p_exam'],
    ['Compensation_and_Pension_2024.pdf', 'high_signal', 'c_and_p_exam'],
    ['TERA_Memo_2024.pdf', 'high_signal', 'tera_memo'],
    ['ILES_2024.pdf', 'high_signal', 'individual_exposure_summary'],
    ['IES_2024.pdf', 'high_signal', 'individual_exposure_summary'],
    ['Nexus_Letter_2023.pdf', 'high_signal', 'nexus_letter_prior'],
    ['IMO_2023.pdf', 'high_signal', 'medical_opinion'],
    ['DD-214.pdf', 'high_signal', 'dd_214'],
    ['DD_214_member4.pdf', 'high_signal', 'dd_214'],
    ['Separation_Exam_2008.pdf', 'high_signal', 'separation_exam'],
    ['Entrance_Exam_2001.pdf', 'high_signal', 'entrance_exam'],
    ['Audiogram_2024.pdf', 'high_signal', 'audiogram'],
    ['Sleep_Study_2024.pdf', 'high_signal', 'sleep_study'],
    ['PSG_2024.pdf', 'high_signal', 'sleep_study'],
    ['PFT_2024.pdf', 'high_signal', 'pulmonary_function_test'],
    ['Lay_Statement_Friend.pdf', 'high_signal', 'lay_statement'],
    ['Buddy_Statement.pdf', 'high_signal', 'buddy_statement'],
    ['Benefit_Summary_2024.pdf', 'high_signal', 'benefit_summary'],
  ])('classifies %s as high_signal / %s', (filename, expectedClass, expectedType) => {
    const r = classifyFile(filename);
    expect(r.classification).toBe(expectedClass);
    expect(r.docType).toBe(expectedType);
    expect(r.importance).toBeGreaterThanOrEqual(70);
  });

  it.each([
    ['Blue_Button_Records_2024.pdf', 'bulk', 'blue_button'],
    ['Full_Health_Record.pdf', 'bulk', 'blue_button'],
    ['Complete_Medical_Record.pdf', 'bulk', 'blue_button'],
    ['Progress_Notes_VA_Dermatology.pdf', 'bulk', 'progress_notes'],
  ])('classifies %s as bulk / %s', (filename, expectedClass, expectedType) => {
    const r = classifyFile(filename);
    expect(r.classification).toBe(expectedClass);
    expect(r.docType).toBe(expectedType);
  });

  it.each([
    'random_file.pdf',
    'photo.jpg',
    'unknown_doc.docx',
  ])('returns normal/unspecified for %s', (filename) => {
    const r = classifyFile(filename);
    expect(r.classification).toBe('normal');
    expect(r.docType).toBe('unspecified');
    expect(r.importance).toBe(50);
  });

  it('handles directory-prefixed paths by classifying on basename', () => {
    const r = classifyFile('records/2024/uploads/DD-214.pdf');
    expect(r.classification).toBe('high_signal');
    expect(r.docType).toBe('dd_214');
  });

  it('returns normal/unspecified for empty/invalid input', () => {
    expect(classifyFile('').classification).toBe('normal');
    expect(classifyFile(undefined as unknown as string).classification).toBe('normal');
  });

  it('CLASSIFIER_VERSION is exported', () => {
    expect(CLASSIFIER_VERSION).toMatch(/^key-docs-classifier/);
  });

  // Chunk D filename patterns.
  it.each([
    ['MRI_Lumbar_Spine_2024.pdf', 'imaging'],
    ['XRay_Knee_2023.pdf', 'imaging'],
    ['Radiology_Report.pdf', 'imaging'],
    ['CO_Letter_2008.pdf', 'buddy_statement'],
    ['Commanding_Officer_Statement.pdf', 'buddy_statement'],
    ['Intake_Summary.pdf', 'intake_summary'],
  ])('classifies %s as %s (Chunk D)', (filename, expectedType) => {
    const r = classifyFile(filename);
    expect(r.docType).toBe(expectedType);
    expect(r.classification).toBe('high_signal');
  });
});

// ===================== Chunk D (2026-06-11): content-text classification =====================
// THE production curation bug: real uploads are named Misc_1.pdf...Misc_12.pdf, so filename-only
// classification returned 'unspecified' for everything and the page-selector's VA-letter rules
// never ran. These lock the content path.

const RATING_DECISION_PAGE = `Department of Veterans Affairs
Regional Office

Dear Veteran:

We have made a decision on your claim for service connected compensation received on March 12, 2024.

Entitlement to service connection for obstructive sleep apnea is established with an evaluation of 50 percent.`;

describe('classifyContentText', () => {
  it('classifies rating-decision page text as rating_decision / high_signal', () => {
    const hint = classifyContentText(RATING_DECISION_PAGE);
    expect(hint?.docType).toBe('rating_decision');
    expect(hint?.classification).toBe('high_signal');
    expect(hint?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('classifies the DD-214 certificate line', () => {
    const hint = classifyContentText('CERTIFICATE OF RELEASE OR DISCHARGE FROM ACTIVE DUTY  This Report Contains Information Subject to the Privacy Act');
    expect(hint?.docType).toBe('dd_214');
    expect(hint?.confidence).toBe(0.9);
  });

  it('classifies denial phrasing as denial_letter', () => {
    const hint = classifyContentText('After careful review of the evidence, entitlement to service connection for tinnitus is denied because the evidence does not show a link to service.');
    expect(hint?.docType).toBe('denial_letter');
  });

  it('classifies VA Form 21-4138 as statement_in_support', () => {
    const hint = classifyContentText('STATEMENT IN SUPPORT OF CLAIM  VA Form 21-4138  The following statement is made in connection with my claim.');
    expect(hint?.docType).toBe('statement_in_support');
  });

  it('classifies a DBQ title page', () => {
    const hint = classifyContentText('SLEEP APNEA DISABILITY BENEFITS QUESTIONNAIRE  Name of patient/veteran:');
    expect(hint?.docType).toBe('dbq');
  });

  it('classifies an imaging report via impression+findings section headers', () => {
    const hint = classifyContentText('EXAM: MRI lumbar spine without contrast. FINDINGS: Disc desiccation at L4-L5. IMPRESSION: 1. L4-L5 herniation.');
    expect(hint?.docType).toBe('imaging');
  });

  it('classifies a Blue Button dump as bulk', () => {
    const hint = classifyContentText('My HealtheVet Blue Button report — VA Health Record. Date range: all available data. 512 pages.');
    expect(hint?.docType).toBe('blue_button');
    expect(hint?.classification).toBe('bulk');
  });

  it('a mixed grant+denial decision letter classifies as rating_decision (grant phrasing checked first)', () => {
    const hint = classifyContentText('We have made a decision on your claim. Entitlement to service connection for PTSD is established. Entitlement to service connection for GERD is denied.');
    expect(hint?.docType).toBe('rating_decision');
  });

  it('returns null for short or unrecognized text', () => {
    expect(classifyContentText('')).toBeNull();
    expect(classifyContentText('   ')).toBeNull();
    expect(classifyContentText('Routine note about general wellness counseling and diet.')).toBeNull();
  });
});

describe('classifyFileWithContentHint — canonical importance (Chunk D fix)', () => {
  it('content-classified rating decision in a Misc file ranks like a rating decision, not a generic upload', () => {
    const r = classifyFileWithContentHint('Misc_3.pdf', { docType: 'rating_decision', classification: 'high_signal', confidence: 0.9 });
    expect(r.docType).toBe('rating_decision');
    // Must outrank a filename-classified audiogram (80); canonical rating_decision is 100, capped at 100.
    expect(r.importance).toBeGreaterThanOrEqual(80);
    expect(r.importance).toBeLessThanOrEqual(100);
  });

  it('ignores hints below the confidence floor', () => {
    const r = classifyFileWithContentHint('Misc_3.pdf', { docType: 'rating_decision', classification: 'high_signal', confidence: 0.4 });
    expect(r.docType).toBe('unspecified');
  });
});

describe('classifyDocument — docTag > content > filename precedence', () => {
  it('Misc_N.pdf with rating-decision page text classifies as rating_decision (THE Chunk D bug fix)', () => {
    const r = classifyDocument({ filePath: 'cases/CASE-1/abc123-Misc_2.pdf', contentText: RATING_DECISION_PAGE });
    expect(r.docType).toBe('rating_decision');
    expect(r.classification).toBe('high_signal');
    expect(r.matchedPattern).toBe('content_classification');
  });

  it('a human docTag override beats the content text', () => {
    const r = classifyDocument({ filePath: 'Misc_4.pdf', docTag: 'DBQ', contentText: RATING_DECISION_PAGE });
    expect(r.docType).toBe('dbq');
    expect(r.matchedPattern).toBe('doc_tag_override');
  });

  it("docTag 'Other' is no signal — falls through to content", () => {
    const r = classifyDocument({ filePath: 'Misc_4.pdf', docTag: 'Other', contentText: RATING_DECISION_PAGE });
    expect(r.docType).toBe('rating_decision');
  });

  it('falls back to filename when content is absent or unrecognized', () => {
    expect(classifyDocument({ filePath: 'DD-214.pdf' }).docType).toBe('dd_214');
    expect(classifyDocument({ filePath: 'Misc_9.pdf', contentText: 'nothing recognizable here at all today' }).docType).toBe('unspecified');
  });
});

describe('mapDocTagToDocType', () => {
  it.each([
    ['STR', 'service_treatment_record_summary'],
    ['DBQ', 'dbq'],
    ['C&P', 'c_and_p_exam'],
    ['Lay Statement', 'lay_statement'],
  ])('maps %s -> %s', (tag, expected) => {
    expect(mapDocTagToDocType(tag)).toBe(expected);
  });

  it('returns null for Other / null / unknown', () => {
    expect(mapDocTagToDocType('Other')).toBeNull();
    expect(mapDocTagToDocType(null)).toBeNull();
    expect(mapDocTagToDocType('mystery')).toBeNull();
  });
});

describe('isHighSignal', () => {
  it('returns true for high-signal files', () => {
    expect(isHighSignal('ClaimLetter-2024.pdf')).toBe(true);
    expect(isHighSignal('DD_214.pdf')).toBe(true);
  });

  it('returns false for bulk and normal files', () => {
    expect(isHighSignal('Blue_Button.pdf')).toBe(false);
    expect(isHighSignal('random.pdf')).toBe(false);
  });
});

describe('sortByDoctorPackPriority', () => {
  it('puts high_signal first, then normal, then bulk', () => {
    const sorted = sortByDoctorPackPriority([
      'Blue_Button.pdf',
      'random_file.pdf',
      'DBQ-OSA.pdf',
      'Progress_Notes.pdf',
      'DD-214.pdf',
    ]);
    expect(sorted.slice(0, 2)).toEqual(['DD-214.pdf', 'DBQ-OSA.pdf']);
    // Within bulk tier: Progress_Notes (importance 35) sorts before Blue_Button (importance 30).
    expect(sorted.slice(-2)).toEqual(['Progress_Notes.pdf', 'Blue_Button.pdf']);
  });

  it('within high_signal, sorts by importance descending', () => {
    const sorted = sortByDoctorPackPriority([
      'IMO_PriorProvider.pdf',         // importance 75
      'DenialLetter-2024.pdf',         // importance 100
      'Audiogram-2024.pdf',            // importance 80
    ]);
    expect(sorted[0]).toBe('DenialLetter-2024.pdf');
    expect(sorted[1]).toBe('Audiogram-2024.pdf');
    expect(sorted[2]).toBe('IMO_PriorProvider.pdf');
  });

  it('does not mutate the input array', () => {
    const input = ['Blue_Button.pdf', 'DD-214.pdf'];
    const sorted = sortByDoctorPackPriority(input);
    expect(input).toEqual(['Blue_Button.pdf', 'DD-214.pdf']);
    expect(sorted).toEqual(['DD-214.pdf', 'Blue_Button.pdf']);
  });
});
