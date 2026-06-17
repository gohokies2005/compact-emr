// PHI redactor for the advisory chart slice.
//
// Vendored copy of the cross-repo PHI structural-identifier patterns. Canonical source-of-record:
// flatratenexus-project/app/config/advisory/phi_patterns.json (require() across repos doesn't work, so
// each repo vendors a copy + ships a string-equality test that asserts the copy === the canonical
// literal — see phiRedactor.test.ts). The index is PHI-free BY CONSTRUCTION; this protects the LIVE
// chart slice that gets pulled per-question and handed to the model. Structural identifiers only
// (SSN / VA file number / labeled DOB / phone / email) — not a surname-completeness guarantee.
// phone + email added 2026-06-16: the chart slice now feeds free-text email/note/message bodies, where
// phone numbers and email addresses are the dominant unstructured-PHI leak.

export const PHI_PATTERNS: Readonly<Record<string, string>> = {
  ssn: '\\b\\d{3}[-\\s]\\d{2}[-\\s]\\d{4}\\b',
  ssn_no_sep: '(?:SSN|SSAN|social security)\\D{0,12}\\d{9}\\b',
  va_file_number: '(?:VA\\s*File\\s*(?:Number|No\\.?|#)|C-?file(?:\\s*(?:Number|No\\.?|#))?)\\s*:?\\s*\\d{6,9}\\b',
  dob_labeled: '(?:DOB|date of birth|born(?:\\s+on)?)\\b\\s*:?\\s*\\d{1,2}[/-]\\d{1,2}[/-](?:19|20)\\d\\d',
  phone: '(?:\\+?1[-.\\s]?)?\\(?\\d{3}\\)?[-.\\s]\\d{3}[-.\\s]\\d{4}\\b',
  email_addr: '\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b',
};
export const PHI_FLAGS = 'i';

// Replace every structural-PHI match with a labeled placeholder. Global flag so ALL occurrences are
// redacted, not just the first. Applied to the chart slice BEFORE the model ever sees it.
export function redactPhi(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [name, src] of Object.entries(PHI_PATTERNS)) {
    out = out.replace(new RegExp(src, `${PHI_FLAGS}g`), `[REDACTED:${name}]`);
  }
  return out;
}

// Belt-and-suspenders: does this text still contain a structural identifier? (for a post-redaction
// assertion + logging — a non-empty result after redactPhi would be a bug worth surfacing loudly.)
export function hasPhi(text: string): boolean {
  if (!text) return false;
  return Object.values(PHI_PATTERNS).some((src) => new RegExp(src, PHI_FLAGS).test(text));
}
