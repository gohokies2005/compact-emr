/**
 * Task #107a path-traversal hardening: defensive validators for S3 keys received from
 * worker callbacks.
 *
 * Threat model: a compromised worker (OCR / Doctor Pack assembler / drafter wrapper) could
 * POST/PATCH an arbitrary S3 key into the body of an internal callback. Without validation,
 * that key gets stored on the DoctorPack / DraftJob row and any downstream signed-URL
 * generator would dereference it. A '..' or '/' prefix or cross-tenant key could redirect
 * reads/writes outside the intended subtree.
 *
 * Defense: keys must (a) have no '..' segments, (b) not start with '/', (c) stay under
 * 500 chars, (d) match a per-domain pattern (doctor-packs/<...>.pdf, drafter-artifacts/<...>).
 *
 * Server-side WRITES (POST /generate, etc.) construct keys via builders that already pass
 * these checks. This module is for INBOUND keys from workers — where the trust boundary is.
 */

const MAX_KEY_LENGTH = 500;

function isPathTraversalSafe(s3Key: unknown): s3Key is string {
  if (typeof s3Key !== 'string') return false;
  if (s3Key.length === 0 || s3Key.length > MAX_KEY_LENGTH) return false;
  if (s3Key.startsWith('/')) return false;
  if (s3Key.includes('..')) return false;
  // Reject anything with control chars or backslashes (Windows-style paths can break
  // S3 key handling and indicate tampering).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(s3Key)) return false;
  return true;
}

/**
 * doctor-packs/<caseId>/v<N>/<doctorPackUuid>.pdf
 */
export function isDoctorPackS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^doctor-packs\/[a-zA-Z0-9_-]+\/v\d+\/[a-f0-9-]+\.pdf$/.test(s3Key);
}

/**
 * drafter-artifacts/<caseId>/v<N>/<filename> — pdf, txt, docx, or sidecar JSON.
 * Filenames produced by the drafter wrapper are version-named (v<N>.pdf, v<N>.txt,
 * v<N>.docx) and side-cars (v<N>_qa_grade.json, v<N>_manifest.json). Strict alphanumeric
 * + underscore + dot in the basename; no slashes inside the filename segment.
 */
export function isDrafterArtifactS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^drafter-artifacts\/[a-zA-Z0-9_-]+\/v\d+\/[a-zA-Z0-9._-]+\.(pdf|txt|docx|json)$/.test(s3Key);
}

/**
 * drafter-exports/<caseId>/<jobId>.json OR drafter-exports/<caseId>/manual-<iso>.json.
 * Used by F1's bundle path; defensive validator if we ever accept this from a body.
 */
export function isDrafterExportS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^drafter-exports\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+\.json$/.test(s3Key);
}

/**
 * cases/<caseId>/<uuid>-<sanitizedFilename> — the presign endpoint computes this server-side
 * and the client must echo the SAME key back in POST /veterans/:id/documents (the "register
 * uploaded document" callback). Without validation, a malicious admin/ops_staff client (or
 * leaked token) could register a Document row pointing at any phiBucket key and then download
 * or delete it via the existing /documents/:id/{download,DELETE} endpoints.
 *
 * Filename portion is sanitized in documents.ts#sanitizeFilename: alphanumeric, dot,
 * underscore, dash only (max 180 chars). UUID portion is lowercase hex from `randomUUID()`.
 */
export function isCaseDocumentS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^cases\/[a-zA-Z0-9_-]+\/[a-f0-9-]+-[a-zA-Z0-9._-]+$/.test(s3Key);
}

/**
 * letter-revisions/<caseId>/v<N>/letter.{txt,pdf,docx} — the in-EMR letter editor's
 * versioned source TXT + rendered pair. Distinct prefix from drafter-artifacts/ (the
 * Fargate drafter's write grant) and cases/ (veteran document uploads), so the editor's
 * IAM grant is scoped to its own subtree. Server-computed per save via
 * buildLetterRevisionKey; this validator guards any inbound key (e.g. from the render
 * Lambda callback) before it is persisted on a LetterRevision row or dereferenced by a
 * signed-URL endpoint. Immutable per version (matches the "version advances, never
 * overwrite in place" rule).
 */
export function isLetterRevisionS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^letter-revisions\/[a-zA-Z0-9_-]+\/v\d+\/letter\.(txt|pdf|docx)$/.test(s3Key);
}

/**
 * physician-signatures/<physicianId>/<uuid>-signature.png — a physician's signature image,
 * composited onto rendered letters. Distinct, non-case prefix so it never collides with the
 * cases/<caseId>/... namespace guarded by isCaseDocumentS3Key. PNG only (transparency). The
 * presign endpoint computes the key server-side; this guards the inbound key on the register
 * callback before it is persisted on the Physician row or dereferenced by a signed-URL endpoint.
 */
export function isPhysicianSignatureS3Key(s3Key: unknown): s3Key is string {
  if (!isPathTraversalSafe(s3Key)) return false;
  return /^physician-signatures\/[a-zA-Z0-9_-]+\/[a-f0-9-]+-signature\.png$/.test(s3Key);
}

/** Build the canonical physician-signature key. Throws if inputs would produce an unsafe key. */
export function buildPhysicianSignatureKey(physicianId: string, uuid: string): string {
  const key = `physician-signatures/${physicianId}/${uuid}-signature.png`;
  if (!isPhysicianSignatureS3Key(key)) {
    throw new Error(`buildPhysicianSignatureKey produced an invalid key for physicianId=${JSON.stringify(physicianId)}`);
  }
  return key;
}

/**
 * Build the canonical letter-revision key for a (caseId, version, ext). Throws if the
 * inputs would produce an unsafe/invalid key — defense-in-depth so a malformed caseId can
 * never silently escape the letter-revisions/ subtree.
 */
export function buildLetterRevisionKey(caseId: string, version: number, ext: 'txt' | 'pdf' | 'docx'): string {
  const key = `letter-revisions/${caseId}/v${version}/letter.${ext}`;
  if (!isLetterRevisionS3Key(key)) {
    throw new Error(`buildLetterRevisionKey produced an invalid key for caseId=${JSON.stringify(caseId)} version=${version}`);
  }
  return key;
}
