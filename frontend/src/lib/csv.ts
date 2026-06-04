// CSV export for the Cases/Veterans list pages. CSV (not .xlsx) — Excel opens it natively,
// no new dependency. The pure builders (escapeCsvField/rowsToCsv) are unit-tested; the DOM
// download (exportRowsToCsv) is kept separate so tests never touch jsdom download internals.
// Added 2026-06-03 for Option B1 (sortable lists + export). See docs/OPTION_B_EXECUTION_PLAN.md.

export type CsvCell = string | number | null | undefined;

/** Quote a field iff it contains a comma, double-quote, CR, or LF; double any internal quotes. */
export function escapeCsvField(value: CsvCell): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a CSV string: header row + data rows, CRLF-terminated, prefixed with a UTF-8 BOM so
 * Excel decodes accented veteran names correctly.
 */
export function rowsToCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM so Excel decodes accented names
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(','));
  return BOM + lines.join('\r\n');
}

/** Trigger a client-side CSV download via a temporary <a download>. */
export function exportRowsToCsv(
  filename: string,
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): void {
  const csv = rowsToCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
