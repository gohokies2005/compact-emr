// Relative-time formatting using the platform Intl.RelativeTimeFormat. No date-fns.
const DIVISIONS: readonly { readonly amount: number; readonly unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Returns e.g. "3 hours ago", "in 2 days", "now". Empty string for an unparseable input.
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  let duration = (date.getTime() - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) return rtf.format(Math.round(duration), division.unit);
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'years');
}

// Absolute month-NAME date, e.g. "Jun 9, 2026", in the viewer's local timezone. Deliberately not
// a numeric format (6/9/26): with Sep/Oct/Nov dates in the list, all-numeric forms are exactly
// the "9 and 10 and 11 out of order" ambiguity Ryan flagged (2026-06-11). Empty string if unparseable.
export function formatAbsoluteDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
