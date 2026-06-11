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

/**
 * Render a person's name LAST-NAME-FIRST — "Kasky, Ryan" — the EMR convention for every list,
 * column, dropdown, and record header (Ryan 2026-06-06: "ALL names ... LAST NAME FIRST,
 * everywhere"). Sorting on this string sorts by last name. Degrades gracefully: if only one part
 * is present it's returned alone; if BOTH are absent `fallback` (e.g. the veteran's MRN) is used.
 */
export function formatNameLastFirst(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback = '',
): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || fallback;
}

/**
 * First name from a stored display name ("Riley Staffer, RN" -> "Riley") for the personalized
 * dashboard greeting (P4). Token 0 of the whitespace split; empty string when there's nothing
 * usable so callers can fall back to the plain greeting.
 */
export function formatFirstName(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';
  return name.trim().split(/\s+/)[0] ?? '';
}

// Trailing credential tokens that may ride on a physician display name WITHOUT a comma
// ("Jane Smith DO"). The comma form ("Jane Smith, DO, FACS") is handled by the comma split.
const CREDENTIAL_TOKEN = /^(?:M\.?D\.?|D\.?O\.?|RN|NP|PA(?:-C)?|Ph\.?D\.?|DPT|DC|OD|DDS|DMD|FNP|APRN|MBBS|MPH|MSN|BSN)\.?$/i;

/**
 * Last name for "Dr. <LastName>" greetings from a credentialed physician display name (P4).
 * "Jane Smith, DO" -> "Smith"; "Dr. Jane Smith-Jones, MD, FACS" -> "Smith-Jones"; "Jane Smith DO"
 * -> "Smith"; single token returned as-is; empty/null -> '' (caller falls back to the plain
 * greeting). Deliberately simple and unit-tested — swap for a server-provided structured name
 * if a future Physician row carries one.
 */
export function formatPhysicianLastName(fullName: string | null | undefined): string {
  if (typeof fullName !== 'string') return '';
  // Everything before the first comma is the name; after it are credentials.
  const base = (fullName.split(',')[0] ?? '').trim();
  const tokens = base.split(/\s+/).filter(Boolean);
  // Strip comma-less trailing credentials ("Jane Smith DO"), but never strip down to nothing.
  // Uppercase-only (plus PhD) so a real mixed-case surname like "Do" is never eaten.
  const isCredential = (t: string | undefined): boolean =>
    t !== undefined && CREDENTIAL_TOKEN.test(t) && (t === t.toUpperCase() || /^ph\.?d\.?$/i.test(t));
  while (tokens.length > 1 && isCredential(tokens[tokens.length - 1])) tokens.pop();
  return tokens[tokens.length - 1] ?? '';
}
