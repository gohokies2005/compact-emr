import { describe, it, expect } from 'vitest';
import { PHI_PATTERNS, PHI_FLAGS, redactPhi, hasPhi } from '../phiRedactor.js';

// The CANONICAL pattern set — copied from flatratenexus-project/app/config/advisory/phi_patterns.json.
// If that source-of-record changes, THIS test fails until the EMR vendored copy (phiRedactor.PHI_PATTERNS)
// is re-synced. Assert on the PARSED pattern set (not file bytes), so a cosmetic reformat doesn't break
// the build but a real pattern drift does. (Architect plan-gate gap #3.)
const CANONICAL_PATTERNS: Record<string, string> = {
  ssn: '\\b\\d{3}[-\\s]\\d{2}[-\\s]\\d{4}\\b',
  ssn_no_sep: '(?:SSN|SSAN|social security)\\D{0,12}\\d{9}\\b',
  va_file_number: '(?:VA\\s*File\\s*(?:Number|No\\.?|#)|C-?file(?:\\s*(?:Number|No\\.?|#))?)\\s*:?\\s*\\d{6,9}\\b',
  dob_labeled: '(?:DOB|date of birth|born(?:\\s+on)?)\\b\\s*:?\\s*\\d{1,2}[/-]\\d{1,2}[/-](?:19|20)\\d\\d',
};
const CANONICAL_FLAGS = 'i';

describe('phiRedactor — cross-repo drift guard', () => {
  it('vendored PHI_PATTERNS deep-equals the canonical phi_patterns.json pattern set', () => {
    expect({ ...PHI_PATTERNS }).toEqual(CANONICAL_PATTERNS);
    expect(PHI_FLAGS).toBe(CANONICAL_FLAGS);
  });
});

describe('redactPhi', () => {
  it('redacts an SSN (with separators)', () => {
    expect(redactPhi('SSN 123-45-6789 on file')).toBe('SSN [REDACTED:ssn] on file');
  });
  it('redacts a VA file number', () => {
    expect(redactPhi('VA File Number: 12345678')).toContain('[REDACTED:va_file_number]');
  });
  it('redacts a LABELED DOB but leaves a citation year untouched', () => {
    expect(redactPhi('DOB: 03/15/1985')).toContain('[REDACTED:dob_labeled]');
    expect(redactPhi('per Smith 2012;201(2):33')).toBe('per Smith 2012;201(2):33');
  });
  it('redacts ALL occurrences, not just the first', () => {
    expect(redactPhi('123-45-6789 and 987-65-4321')).toBe('[REDACTED:ssn] and [REDACTED:ssn]');
  });
  it('leaves clean text unchanged', () => {
    expect(redactPhi('chronic low back pain, no identifiers here')).toBe('chronic low back pain, no identifiers here');
  });
});

describe('hasPhi (post-redaction assertion helper)', () => {
  it('detects a structural identifier and is false after redaction', () => {
    expect(hasPhi('123-45-6789')).toBe(true);
    expect(hasPhi(redactPhi('123-45-6789'))).toBe(false);
    expect(hasPhi('no identifiers here')).toBe(false);
  });
});
