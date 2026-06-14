// Helpers for the multi-file + .zip document upload flow on the veteran chart.
// Kept framework-free so the filtering rules can be unit-tested without rendering React.

export const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', // .txt — the purest format; content IS the text (read directly, no OCR). (2026-06-07)
  'text/html', // .html — VA Rated-Disabilities / Blue Button exports; tags stripped → text, no OCR. (E4, 2026-06-13)
] as const;

export const MAX_BYTES = 50 * 1024 * 1024;

// HTML file-picker filter for the upload <input>. Kept HERE (next to ALLOWED_TYPES) so the picker
// filter and the JS validation cannot drift: .txt was accepted by classifyEntry but missing from the
// accept attr, so the OS picker greyed out .txt files the upload path could handle (Package 2/3 fold,
// 2026-06-11). .zip appears only here — zips are expanded client-side, never uploaded as-is.
export const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.doc,.docx,.txt,.html,.htm,.zip,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/html,application/zip,application/x-zip-compressed';

// Extension -> contentType for files unpacked from a zip (a JSZip entry has no MIME type) and as a
// fallback for OS file pickers that hand us an empty `file.type`.
const EXT_TO_TYPE: Record<string, (typeof ALLOWED_TYPES)[number]> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
};

export function extensionOf(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

// Infer a supported contentType from an explicit MIME (if allowed) then the file extension.
export function inferContentType(filename: string, explicitType?: string): string | null {
  if (explicitType && (ALLOWED_TYPES as readonly string[]).includes(explicitType)) return explicitType;
  const byExt = EXT_TO_TYPE[extensionOf(filename)];
  return byExt ?? null;
}

// Junk / non-document entries we silently skip when unpacking a zip or scanning a multi-select.
export function isJunkPath(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  const base = path.split('/').pop() ?? path;
  if (base === '' ) return true; // directory entry
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (base.startsWith('.')) return true; // dotfiles
  return false;
}

export type SkipReason = 'directory_or_junk' | 'unsupported_type' | 'too_large';

export interface UploadCandidate {
  readonly path: string; // display name (basename for zip entries)
  readonly contentType: string;
  readonly sizeBytes: number;
}

export type CandidateResult =
  | { readonly ok: true; readonly candidate: UploadCandidate }
  | { readonly ok: false; readonly path: string; readonly reason: SkipReason };

// Decide whether a single file (from a multi-select or a zip entry) is uploadable.
// `isDir` lets the caller flag JSZip directory entries explicitly.
export function classifyEntry(args: {
  readonly path: string;
  readonly sizeBytes: number;
  readonly explicitType?: string;
  readonly isDir?: boolean;
}): CandidateResult {
  const { path, sizeBytes, explicitType, isDir } = args;
  if (isDir || isJunkPath(path)) return { ok: false, path, reason: 'directory_or_junk' };
  const contentType = inferContentType(path, explicitType);
  if (!contentType) return { ok: false, path, reason: 'unsupported_type' };
  if (sizeBytes > MAX_BYTES) return { ok: false, path, reason: 'too_large' };
  const base = path.split('/').pop() ?? path;
  return { ok: true, candidate: { path: base, contentType, sizeBytes } };
}

export function isZip(file: { name: string; type?: string }): boolean {
  if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed') return true;
  return extensionOf(file.name) === 'zip';
}

// Turn an upload failure into a human reason the RN can act on. The per-file upload
// (presign -> S3 PUT -> record) can reject in three shapes, and the chart used to swallow
// all of them into a generic "skipped" — leaving the RN with an invisible failure and no
// way to know WHY a file never appeared. Recover the real reason:
//   - API 400 (presign/record): AxiosError carrying { error: { code, message } } in the body
//   - 403: the client maps it to a ForbiddenError (name only, no body)
//   - S3 PUT network/CORS failure: AxiosError with no response (code ERR_NETWORK)
// Kept structural (no axios import) so this stays framework-free and unit-testable.
export function uploadErrorReason(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      response?: { status?: unknown; data?: { error?: { code?: unknown; message?: unknown } } };
    };
    const apiMessage = e.response?.data?.error?.message;
    if (typeof apiMessage === 'string' && apiMessage.trim().length > 0) return apiMessage.trim();
    if (e.name === 'ForbiddenError') return 'permission denied — your account may lack document-upload rights';
    if (e.code === 'ERR_NETWORK') return 'network/CORS error reaching storage (upload blocked before it left the browser)';
    const status = e.response?.status;
    if (typeof status === 'number') return `server returned HTTP ${status}`;
    if (typeof e.message === 'string' && e.message.trim().length > 0) return e.message.trim();
  }
  return 'unexpected error';
}
