// Document display naming (Ryan 2026-06-18 "kill Misc/Other"). The label must never be the literal
// "Misc"/"Other" or a raw "_Misc_N" veteran filename — content title when known, cleaned filename else.
import { describe, expect, it } from 'vitest';
import { cleanDocFilename, documentDisplayName } from '../lib/docName';

describe('cleanDocFilename', () => {
  it('strips extension, separators, and noise tokens (Misc/scan/etc.)', () => {
    expect(cleanDocFilename('Woodley_GERD_Misc_4.docx')).toBe('Woodley GERD 4');
    expect(cleanDocFilename('VA-Rating-Decision-FINAL.pdf')).toBe('VA Rating Decision');
    expect(cleanDocFilename('sleep_study_scan.pdf')).toBe('sleep study');
  });
  it('never returns an empty/number-only/"Misc"/"Other" label', () => {
    expect(cleanDocFilename('Misc.pdf')).toBe('Document'); // all-noise → neutral, never "Misc"/"Other"
    expect(cleanDocFilename('Other_3.pdf')).toBe('Document'); // noise + digit → neutral
    expect(cleanDocFilename('')).toBe('Document');
  });
});

describe('documentDisplayName', () => {
  it('prefers the classifier content title when present', () => {
    expect(documentDisplayName({ autoTitle: 'VA Rating Decision — GERD denied', filename: 'Woodley_GERD_Misc_4.docx' }))
      .toBe('VA Rating Decision — GERD denied');
  });
  it('falls back to a cleaned filename (never the raw "_Misc_" name) when no title', () => {
    expect(documentDisplayName({ autoTitle: null, filename: 'Woodley_GERD_Misc_4.docx' })).toBe('Woodley GERD 4');
    expect(documentDisplayName({ filename: 'Misc_2.pdf' })).toBe('Document');
  });
});
