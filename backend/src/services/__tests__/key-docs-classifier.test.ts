import { describe, it, expect } from 'vitest';
import {
  classifyContentText,
  classifyFileWithContentHint,
  CLASSIFIER_VERSION,
  CLASSIFIER_VERSION_NUM,
} from '../key-docs-classifier.js';

// Doctor-pack classifier lane (1.3.0, 2026-06-26). These are PRECISION regressions: a more-specific
// document (DBQ, C&P, decision) must never be stolen by a value-page matcher (audiogram, PFT,
// sleep_study, rated_disabilities_view) that the same text would also satisfy. Order + the filename
// tie-break carry that guarantee.

describe('key-docs-classifier 1.3.0 — content-pattern precision', () => {
  it('a hearing-loss DBQ stays dbq (not audiogram) even though it quotes Maryland CNC / puretone', () => {
    const text =
      'DISABILITY BENEFITS QUESTIONNAIRE — Hearing Loss and Tinnitus. '
      + 'Maryland CNC word recognition score 88 percent. Puretone threshold average 40 dB.';
    expect(classifyContentText(text)?.docType).toBe('dbq');
  });

  it('a respiratory DBQ stays dbq (not pulmonary_function_test) even though it quotes FEV1/FVC', () => {
    const text =
      'DISABILITY BENEFITS QUESTIONNAIRE — Respiratory Conditions. '
      + 'Spirometry performed: FEV1 65 percent predicted, FVC 70 percent predicted.';
    expect(classifyContentText(text)?.docType).toBe('dbq');
  });

  it('a C&P exam mentioning AHI stays c_and_p_exam (not sleep_study)', () => {
    const text =
      'Compensation and Pension Exam — Sleep Apnea. '
      + "The veteran's AHI was 22 events per hour on the referenced sleep study.";
    expect(classifyContentText(text)?.docType).toBe('c_and_p_exam');
  });

  it('a status snapshot containing "Reasons for Decision" stays rating_decision (not rated_disabilities_view)', () => {
    const text =
      'VA.gov — Your rated disabilities. Reasons for Decision: service connection is established. '
      + 'Combined disability rating 70 percent. Effective date 01/01/2020.';
    expect(classifyContentText(text)?.docType).toBe('rating_decision');
  });

  it('a combined DD-214 + denial bundle classifies as denial_letter (not dd_214)', () => {
    const text =
      'CERTIFICATE OF RELEASE OR DISCHARGE FROM ACTIVE DUTY. DD FORM 214. '
      + 'We have denied your claim for service connection for tinnitus.';
    expect(classifyContentText(text)?.docType).toBe('denial_letter');
  });

  it('a standalone DD-214 still classifies as dd_214', () => {
    const text =
      'CERTIFICATE OF RELEASE OR DISCHARGE FROM ACTIVE DUTY. DD FORM 214. '
      + 'Branch of service: Army. Primary specialty: 11B Infantryman. Net active service: 4 years.';
    expect(classifyContentText(text)?.docType).toBe('dd_214');
  });

  it('a real sleep study with AHI classifies as sleep_study', () => {
    const text =
      'POLYSOMNOGRAPHY REPORT. Sleep study findings: AHI 42 events per hour. '
      + 'Diagnosis: severe obstructive sleep apnea.';
    expect(classifyContentText(text)?.docType).toBe('sleep_study');
  });

  it('the guarded AHI/RDI rate (no "polysomnography" word) still classifies as sleep_study', () => {
    const text = 'Sleep laboratory report. AHI 18 events per hour. Mild obstructive sleep apnea noted.';
    expect(classifyContentText(text)?.docType).toBe('sleep_study');
  });

  it('a standalone audiogram classifies as audiogram', () => {
    const text =
      'Audiometric evaluation. Maryland CNC speech discrimination 84 percent. '
      + 'Puretone threshold average 45 dB across speech frequencies.';
    expect(classifyContentText(text)?.docType).toBe('audiogram');
  });

  it('a standalone pulmonary function test classifies as pulmonary_function_test', () => {
    const text = 'Pulmonary function test. Spirometry. FEV1 62 percent predicted. FVC 70 percent. DLCO reduced.';
    expect(classifyContentText(text)?.docType).toBe('pulmonary_function_test');
  });

  it('the va.gov rated-disabilities page classifies as rated_disabilities_view', () => {
    const text =
      'VA.gov — Your rated disabilities. Disability: Tinnitus — 10 percent. '
      + 'Effective date: 03/15/2019. Combined disability rating: 70 percent.';
    expect(classifyContentText(text)?.docType).toBe('rated_disabilities_view');
  });

  it('a benefit-summary letter classifies as benefit_summary', () => {
    const text =
      'VA Benefit Summary. This letter is a summary of benefits you currently receive from the '
      + 'Department of Veterans Affairs.';
    expect(classifyContentText(text)?.docType).toBe('benefit_summary');
  });

  it('a plain CPRS SOAP note classifies as progress_notes (classification normal)', () => {
    const text =
      'CPRS Progress Note. Subjective: veteran reports ongoing knee pain. Objective: vitals stable, gait antalgic. '
      + 'Assessment: chronic right knee pain. Plan: continue NSAIDs, refer to physical therapy.';
    const hint = classifyContentText(text);
    expect(hint?.docType).toBe('progress_notes');
    expect(hint?.classification).toBe('normal');
  });
});

describe('key-docs-classifier 1.3.0 — filename tie-break', () => {
  it('an explicit high-signal filename beats a <0.9 content guess that disagrees', () => {
    // Denial_Letter.pdf + a misleading 0.7 content hint (dbq) -> filename wins.
    const r = classifyFileWithContentHint('Denial_Letter.pdf', {
      docType: 'dbq',
      classification: 'high_signal',
      confidence: 0.7,
    });
    expect(r.docType).toBe('denial_letter');
  });

  it('a 0.9 content guess still overrides even an explicit high-signal filename', () => {
    // Audiogram.pdf (filename -> audiogram) + a near-certain 0.9 content hint (dd_214) -> content wins.
    const r = classifyFileWithContentHint('Audiogram.pdf', {
      docType: 'dd_214',
      classification: 'high_signal',
      confidence: 0.9,
    });
    expect(r.docType).toBe('dd_214');
  });

  it('content still supersedes when the filename is NOT an explicit match (Misc_3.pdf)', () => {
    // Preserves the Chunk D behavior: a generic filename never wins the tie-break.
    const r = classifyFileWithContentHint('Misc_3.pdf', {
      docType: 'rating_decision',
      classification: 'high_signal',
      confidence: 0.7,
    });
    expect(r.docType).toBe('rating_decision');
  });

  it('content supersedes when the filename agrees (no spurious tie-break)', () => {
    const r = classifyFileWithContentHint('Denial_Letter.pdf', {
      docType: 'denial_letter',
      classification: 'high_signal',
      confidence: 0.7,
    });
    expect(r.docType).toBe('denial_letter');
  });
});

describe('key-docs-classifier 1.3.0 — version stamps', () => {
  it('CLASSIFIER_VERSION + CLASSIFIER_VERSION_NUM are bumped to 1.3.0 / 3', () => {
    expect(CLASSIFIER_VERSION).toBe('key-docs-classifier-1.3.0');
    expect(CLASSIFIER_VERSION_NUM).toBe(3);
  });
});
