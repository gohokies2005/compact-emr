// The human filename for a chart document, from its S3 key/filePath. Keys are minted
// `cases/<caseId>/<uuid>-<OriginalName.ext>` (backend documents presign), so show the basename
// minus the leading 36-char uuid- prefix — a GUID wrapping across three lines tells a human
// nothing (Ryan 2026-06-06, Yorde). Idempotent on already-stripped names and legacy non-uuid keys
// (falls back to the basename, or the whole input when there is no '/').
//
// Extracted from SendToDrafterPanel (Package 1 (J), 2026-06-11) so the drafter blocking-file
// alert and the RN manual-summary queue render ONE copy. The backend queue routes apply the same
// strip server-side (`originalFileName` in routes/chart-readiness.ts) — keep the regexes in sync.
export function documentFileName(filePath: string): string {
  const base = filePath.split('/').pop() || filePath;
  return base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
}
