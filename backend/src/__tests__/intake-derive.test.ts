import { describe, expect, it } from 'vitest';
import { deriveIntakeFields, fillIntakeDerived, normalizeDob, toStateAbbr } from '../services/intake-derive.js';

// Real Stage-2 condition-form answers (Marcus Justice, form 261483559233058, sub 6564157048815576155),
// trimmed to the fields the derivation reads. This is the exact shape stored in rawAnswersJson for the
// 25+ intakes ingested before the worker sent submittedDob — the rows where DOB "wasn't prefilling".
const MARCUS_STAGE2 = {
  q1: { type: 'control_textbox', name: 's2_condition_slug', text: 'Condition (from Stage 1)', answer: 'unspecified_genitourinary' },
  q2: { type: 'control_textbox', name: 's2_claim_type_stage1', text: 'Claim type (from Stage 1)', answer: 'direct' },
  q3: { type: 'control_radio', name: 's2_prior_denial', text: 'Have you been denied for this condition by VA before?', answer: 'Yes' },
  q4: { type: 'control_radio', name: 's2_q6', text: 'Has VA decided on this condition before?', answer: 'Yes — denied' },
  q5: { type: 'control_textbox', name: 's2_confirm_name', text: 'Confirm name', answer: 'Marcus Justice' },
  q6: { type: 'control_email', name: 's2_confirm_email', text: 'Confirm email', answer: 'majusticemjustice@yahoo.com' },
  q7: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985' },
  q8: { type: 'control_textbox', name: 's2_phone_s1', text: 'Phone', answer: '9099006833' },
  q9: { type: 'control_textbox', name: 's2_state_s1', text: 'State', answer: 'Texas' },
};

// Returning-intake form (261495407772061): DOB is a control_datetime with a {month,day,year} object.
const MARCUS_RETURNING = {
  q1: { type: 'control_fullname', name: 'fullName', text: 'Your full name', answer: { first: 'Marcus', last: 'Justice' } },
  q2: { type: 'control_email', name: 'email', text: 'Email address', answer: 'majusticemjustice@yahoo.com' },
  q3: { type: 'control_datetime', name: 'dateOf', text: 'Date of Birth', answer: { month: '08', day: '13', year: '1985' }, prettyFormat: '08-13-1985' },
};

describe('intake-derive', () => {
  it('derives DOB (US MM/DD/YYYY textbox) + state abbr + supplemental from real Stage-2 answers', () => {
    const d = deriveIntakeFields(MARCUS_STAGE2);
    expect(d.dob).toBe('1985-08-13'); // the field that was not prefilling
    expect(d.state).toBe('TX'); // was mangled to "TE" (Texas truncated)
    expect(d.name).toBe('Marcus Justice');
    expect(d.email).toBe('majusticemjustice@yahoo.com');
    expect(d.condition).toBe('unspecified_genitourinary');
    expect(d.claimType).toBe('supplemental'); // prior denial = Yes / "Yes — denied"
  });

  it('derives DOB from a control_datetime {month,day,year} object (returning form)', () => {
    const d = deriveIntakeFields(MARCUS_RETURNING);
    expect(d.dob).toBe('1985-08-13');
    expect(d.name).toBe('Marcus Justice');
  });

  it('fillIntakeDerived fills a NULL submittedDob and repairs a truncated state', () => {
    const row = { id: 'i1', submittedDob: null, submittedState: 'TE', submittedName: 'Marcus Justice', rawAnswersJson: MARCUS_STAGE2 };
    const filled = fillIntakeDerived(row);
    expect(filled.submittedDob).toBe('1985-08-13');
    expect(filled.submittedState).toBe('TX');
    expect(filled.submittedName).toBe('Marcus Justice'); // unchanged (already set)
  });

  it('does not overwrite an already-correct submittedDob', () => {
    const row = { submittedDob: '1990-01-01', rawAnswersJson: MARCUS_STAGE2 };
    expect(fillIntakeDerived(row).submittedDob).toBe('1990-01-01');
  });

  it('normalizeDob + toStateAbbr edge cases', () => {
    expect(normalizeDob('1985-8-13')).toBe('1985-08-13');
    expect(normalizeDob('August 13, 1985')).toBe('1985-08-13');
    expect(normalizeDob('garbage')).toBeUndefined();
    expect(toStateAbbr('CO')).toBe('CO');
    expect(toStateAbbr('Idaho')).toBe('ID');
    expect(toStateAbbr('nope')).toBeUndefined();
  });
});
