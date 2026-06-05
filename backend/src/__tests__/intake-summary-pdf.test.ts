import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { intakeQuestionPairs, renderIntakeSummaryPdf } from '../services/intake-summary-pdf.js';

// Real Stage-2 condition-form answers (Marcus Justice) — the Q&A the drafter needs but that never
// reached the chart for a no-file submission. Includes HTML/instruction blocks that must be skipped.
const MARCUS_STAGE2 = {
  q1: { type: 'control_text', name: 'welcomeText', text: '<p><strong>Hi.</strong> Thanks</p>', answer: '' },
  q2: { type: 'control_textbox', name: 's2_condition_slug', text: 'Condition (from Stage 1)', answer: 'unspecified_genitourinary', order: 2 },
  q3: { type: 'control_dropdown', name: 's2_branch', text: 'Branch of service', answer: 'Air Force', order: 3 },
  q4: { type: 'control_textbox', name: 's2_service_dates', text: 'When did you serve?', answer: '2010-2018', order: 4 },
  q5: { type: 'control_textarea', name: 's2_mos_and_duties', text: 'What was your MOS / job code?', answer: 'Personnel', order: 5 },
  q6: { type: 'control_fileupload', name: 's2_upload_dd214', text: 'Upload your files', answer: '["https://x/a.pdf"]', order: 6 },
  q7: { type: 'control_radio', name: 's2_q1', text: 'Is this condition formally diagnosed by a provider?', answer: 'No — suspected only', order: 7 },
  q8: { type: 'control_radio', name: 's2_q6', text: 'Has VA decided on this condition before?', answer: 'Yes — denied', order: 8 },
  q9: { type: 'control_radio', name: 's2_prior_denial', text: 'Have you been denied for this condition by VA before?', answer: 'Yes', order: 9 },
  q10: { type: 'control_textarea', name: 's2_denial_reason', text: 'What reason did VA give?', answer: 'Not service connected', order: 10 },
  q11: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985', order: 11 },
  q12: { type: 'control_textarea', name: 's2_why_s1', text: 'Why you believe your condition is connected to service', answer: 'During my military service, I began experiencing urinary symptoms that have continued and worsened since separation.', order: 12 },
};

describe('intake-summary-pdf', () => {
  it('extracts the answered questions and skips HTML/instruction + file-upload fields', () => {
    const pairs = intakeQuestionPairs(MARCUS_STAGE2);
    const qs = pairs.map((p) => p.q);
    expect(qs).toContain('Has VA decided on this condition before?');
    expect(qs).toContain('Why you believe your condition is connected to service');
    expect(qs).not.toContain('Upload your files'); // file-upload skipped
    expect(pairs.find((p) => p.q.startsWith('Has VA decided'))?.a).toBe('Yes — denied');
    expect(pairs.find((p) => p.q.startsWith('Why you believe'))?.a).toContain('urinary symptoms');
    expect(pairs.some((p) => p.q.includes('Hi.'))).toBe(false); // welcome HTML block skipped
  });

  it('renders a real, non-trivial PDF (written to disk for eyeball verification)', async () => {
    const bytes = await renderIntakeSummaryPdf(MARCUS_STAGE2, { veteranName: 'Marcus Justice', condition: 'unspecified_genitourinary', formTitle: 'Stage 2', submittedAt: '2026-06-04' });
    expect(bytes.length).toBeGreaterThan(1500);
    // %PDF magic header
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    writeFileSync('/tmp/intake-summary-marcus.pdf', Buffer.from(bytes));
  });

  it('handles an empty submission without throwing', async () => {
    const bytes = await renderIntakeSummaryPdf({}, {});
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });
});
