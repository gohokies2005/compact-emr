// Shared formatters for document-list rows (Ryan 2026-06-17: show file SIZE in MB + PAGE COUNT so an RN
// can spot a giant dump at a glance and judge re-read cost). Used by the case Documents tab and the
// veteran chart Documents list so both rows read identically.

/** Human-readable file size from the BigInt-serialized sizeBytes string. KB under ~1 MB, else MB to 1dp. */
export function formatFileSize(sizeBytes: string | number | null | undefined): string {
  const n = typeof sizeBytes === 'string' ? Number(sizeBytes) : (sizeBytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Page count for a row. Null/0 (not yet read / non-paged) renders nothing. */
export function formatPageCount(pageCount: number | null | undefined): string {
  return typeof pageCount === 'number' && pageCount > 0 ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : '';
}
