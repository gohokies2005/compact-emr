import { describe, expect, it } from 'vitest';
import { classifyFile, CLASSIFIER_VERSION, isHighSignal, sortByDoctorPackPriority } from '../services/key-docs-classifier.js';

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
