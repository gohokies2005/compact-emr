// Small display formatters shared across the case + veteran headers. Pure, no deps — each
// returns the ORIGINAL input unchanged when it doesn't match the expected shape, so a surprising
// value (already-formatted, partial, non-US) is shown verbatim rather than mangled or blanked.

/**
 * Render the date portion of a date string. Handles a full ISO datetime ("1997-09-02T00:00:00.000Z")
 * by taking the leading YYYY-MM-DD, and passes through a value that is already a plain date.
 * Anything that doesn't start with a YYYY-MM-DD prefix is returned unchanged.
 *
 * Ryan 2026-06-04: DOB rendered as "1997-09-02T00:00:00.000Z" in the UI — show date-only.
 * (Age math elsewhere uses Date.parse on the full value and is unaffected.)
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const m = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return m ? m[0] : value;
}

/**
 * Format a US phone number as "(408) 887-1744". Accepts a bare 10-digit number or an
 * 11-digit number with a leading US country code (1 / +1). Any other shape (too short,
 * international, already-formatted with extension, empty) is returned unchanged.
 *
 * Ryan 2026-06-04: phone rendered as raw "4088871744" — format the common case, never lose info.
 */
export function formatPhone(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  let local = digits;
  if (digits.length === 11 && digits.startsWith('1')) local = digits.slice(1);
  if (local.length !== 10) return value;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}
