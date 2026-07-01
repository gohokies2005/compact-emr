import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { HttpError } from '../http/errors.js';
import type { AppDb } from './db-types.js';

/**
 * Shared resolution of the CURRENT letter's TXT bytes by Case.currentVersion — the single
 * source of truth used by the letter editor, the delivery panel, and the sign-off byte-binding
 * (#9 Fix 3). Prefer the unified LetterRevision row; fall back to the DraftJob row for
 * drafted-but-pre-mirror cases. Both are keyed to the SAME version.
 *
 * The TXT (not the DOCX/PDF render) is the deterministic source of truth: the sign-off binds to
 * sha256(TXT) and the delivery gate re-hashes the current TXT to detect a post-sign edit.
 */

export interface CurrentTxtRef {
  version: number;
  txtKey: string;
}

export async function resolveCurrentTxtKey(db: AppDb, caseId: string, currentVersion: number): Promise<CurrentTxtRef | null> {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) return null;
  const rev = await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } });
  if (rev !== null) return { version: rev.version, txtKey: rev.artifactTxtS3Key };
  const job = await db.draftJob.findFirst({ where: { caseId, version: currentVersion } });
  if (job !== null && typeof job.artifactTxtS3Key === 'string') {
    return { version: job.version, txtKey: job.artifactTxtS3Key };
  }
  return null;
}

/** Full-key variant of the STRICT resolver (adds pdf/docx). Same currentVersion-pinned semantics as
 * resolveCurrentTxtKey — LetterRevision first, then the DraftJob fallback — for callers that need the
 * pdf/docx keys too (the recovery composer + the forward re-pin materializer). */
export interface CurrentRef {
  version: number;
  txtKey: string;
  pdfKey: string | null;
  docxKey: string | null;
}

export async function resolveCurrentRefStrict(db: AppDb, caseId: string, currentVersion: number): Promise<CurrentRef | null> {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) return null;
  const rev = await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } });
  if (rev !== null) return { version: rev.version, txtKey: rev.artifactTxtS3Key, pdfKey: rev.artifactPdfS3Key, docxKey: rev.artifactDocxS3Key };
  const job = await db.draftJob.findFirst({ where: { caseId, version: currentVersion } });
  if (job !== null && typeof job.artifactTxtS3Key === 'string') {
    return { version: job.version, txtKey: job.artifactTxtS3Key, pdfKey: job.artifactPdfS3Key, docxKey: job.artifactDocxS3Key };
  }
  return null;
}

/**
 * STRANDED-LETTER RECOVERY support (CLM-9925837B7B, 2026-06-23): HeadObject existence probe.
 * Returns false on NoSuchKey/NotFound, re-throws anything else (a transient S3 error must NOT be
 * silently treated as "object absent" — that would skip a good letter). Shared by the letter
 * router's read-path resolver, which walks DB versions DESC across BOTH artifact tables and returns
 * the newest version whose TXT object actually EXISTS — so a failed re-draft that advanced
 * Case.currentVersion to a dead version can never strand the prior good letter behind a 404.
 *
 * Two rules baked into that walk (learned from the live data, enforced by the caller):
 *   1) NEVER reconstruct the S3 key from the DB version. The drafter's S3 folder counter and the DB
 *      `version` field are OFFSET (live: DB v72 → S3 folder v53). Each row's stored artifactTxtS3Key
 *      is authoritative; we trust the key, not an arithmetic guess.
 *   2) A non-null artifactTxtS3Key is NOT proof the object exists — a failed run can carry a DANGLING
 *      key (live: DraftJob v99 → .../v97/v97.txt, never written). HeadObject-verify before returning.
 */
export async function headObjectExists(s3: S3Client, bucketName: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') return false;
    throw e;
  }
}

export interface S3DrafterArtifactRef {
  version: number;
  txtKey: string;
  pdfKey: string | null;
  docxKey: string | null;
}

/**
 * S3-TRUTH FALLBACK (CLM-9925837B7B, 2026-06-23): when NO DB row resolves to a present artifact — a good
 * drafter letter exists in S3 but its DraftJob/LetterRevision row lost or offset its key (Hackworth v73 is
 * in S3 but currentVersion points at the failed v97/v98 and no row carries a resolvable key) — discover the
 * letter directly from S3. Lists drafter-artifacts/<caseId>/vN/ folders, picks the NEWEST vN whose vN.txt
 * object actually exists, returns its txt/pdf/docx keys. DISCOVERY of what exists (S3 = artifact source of
 * truth), not key-reconstruction from a DB version. Fail-soft: any list/probe error returns null.
 */
export async function resolveLatestS3DrafterArtifact(s3: S3Client, bucketName: string, caseId: string): Promise<S3DrafterArtifactRef | null> {
  const prefix = `drafter-artifacts/${caseId}/`;
  let listed;
  try {
    listed = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, Delimiter: '/' }));
  } catch {
    return null;
  }
  const versions: number[] = [];
  for (const cp of listed.CommonPrefixes ?? []) {
    const m = /\/v(\d+)\/$/.exec(cp.Prefix ?? '');
    if (m !== null) versions.push(Number(m[1]));
  }
  versions.sort((a, b) => b - a);
  for (const v of versions) {
    const txtKey = `${prefix}v${v}/v${v}.txt`;
    if (await headObjectExists(s3, bucketName, txtKey)) {
      const pdfKey = `${prefix}v${v}/v${v}.pdf`;
      const docxKey = `${prefix}v${v}/v${v}.docx`;
      return {
        version: v,
        txtKey,
        pdfKey: (await headObjectExists(s3, bucketName, pdfKey)) ? pdfKey : null,
        docxKey: (await headObjectExists(s3, bucketName, docxKey)) ? docxKey : null,
      };
    }
  }
  return null;
}

/**
 * DESC-walk BOTH artifact tables and return the newest version whose TXT object is CONFIRMED PRESENT
 * in S3 (HeadObject-verified), with its full key set. Ported from the letter router's inline
 * resolveLatestResolvableTxt so the read path and the approve-gate advisory share ONE implementation.
 */
async function resolveLatestResolvablePresent(db: AppDb, s3: S3Client, bucketName: string, caseId: string): Promise<CurrentRef | null> {
  const candidates = new Map<number, CurrentRef>();
  const revs = await db.letterRevision.findMany({ where: { caseId }, orderBy: { version: 'desc' } });
  for (const r of revs) {
    if (typeof r.artifactTxtS3Key === 'string' && r.artifactTxtS3Key.length > 0 && !candidates.has(r.version)) {
      candidates.set(r.version, { version: r.version, txtKey: r.artifactTxtS3Key, pdfKey: r.artifactPdfS3Key, docxKey: r.artifactDocxS3Key });
    }
  }
  const jobs = await db.draftJob.findMany({ where: { caseId }, orderBy: { version: 'desc' } });
  for (const j of jobs) {
    if (typeof j.artifactTxtS3Key === 'string' && j.artifactTxtS3Key.length > 0 && !candidates.has(j.version)) {
      candidates.set(j.version, { version: j.version, txtKey: j.artifactTxtS3Key, pdfKey: j.artifactPdfS3Key, docxKey: j.artifactDocxS3Key });
    }
  }
  const versionsDesc = Array.from(candidates.keys()).sort((a, b) => b - a);
  for (const version of versionsDesc) {
    const ref = candidates.get(version) as CurrentRef;
    if (await headObjectExists(s3, bucketName, ref.txtKey)) return ref;
  }
  return null;
}

/**
 * SINGLE recovery-capable "does a current OPENABLE letter exist?" resolver — the one existence signal
 * shared by the read path (GET /letter → resolveCurrentForRead), the approve-blocker advisory
 * (computeApproveBlockers), the approve route's edit-resolver, and the forward re-pin. Resolves the
 * strict pointer first (HeadObject-verified), then the newest prior version whose TXT is present across
 * BOTH tables, then the S3-truth drafter-artifact fallback. Every returned ref is a CONFIRMED-PRESENT
 * artifact — never a dangling key — so a review card, the "No current letter" banner, and the approve
 * route can never disagree about whether a letter exists. Returns null only when NO version anywhere
 * resolves to a present artifact.
 *
 * FAIL-OPEN: when s3/bucketName is undefined (local/test wiring), falls back to the STRICT DB
 * resolution with NO HeadObject probe — exactly resolveCurrentTxtKey's pre-existing behavior — so a
 * caller without S3 wired never throws and never regresses.
 */
export async function resolveViewableCurrentTxtKey(
  db: AppDb,
  s3: S3Client | undefined,
  bucketName: string | undefined,
  caseId: string,
  currentVersion: number,
): Promise<CurrentRef | null> {
  // FAIL-OPEN strict-only when S3 is not wired: mirror resolveCurrentTxtKey (no probe, no recovery).
  if (s3 === undefined || bucketName === undefined) {
    return resolveCurrentRefStrict(db, caseId, currentVersion);
  }
  // 1) Strict pointer, HeadObject-verified.
  const strict = await resolveCurrentRefStrict(db, caseId, currentVersion);
  if (strict !== null && (await headObjectExists(s3, bucketName, strict.txtKey))) return strict;
  // 2) Newest prior version whose TXT object is present (both tables).
  const walked = await resolveLatestResolvablePresent(db, s3, bucketName, caseId);
  if (walked !== null) return walked;
  // 3) S3-truth: a good drafter letter whose DB row lost/offset its key.
  const s3hit = await resolveLatestS3DrafterArtifact(s3, bucketName, caseId);
  if (s3hit !== null) return { version: s3hit.version, txtKey: s3hit.txtKey, pdfKey: s3hit.pdfKey, docxKey: s3hit.docxKey };
  return null;
}

/** Optional caller context so the missing-artifact 404 names the case + version it failed on. */
export interface LetterTxtContext {
  readonly caseId: string;
  readonly version: number;
}

export async function readTxtFromS3(s3: S3Client, bucketName: string, key: string, ctx?: LetterTxtContext): Promise<string> {
  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (e: unknown) {
    // An S3 NoSuchKey used to escape as an unhandled 500 ("Unexpected server error") — a dead-end
    // generic for the operator (CLM-BBFCB3F8CE, 2026-06-11: a draft run's DB row pointed at artifacts
    // that were never uploaded). Surface the REAL cause + the actionable fix path as a structured 404.
    const name = e instanceof Error ? e.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      const baseName = key.split('/').pop() ?? key; // redact the full S3 key path; the basename identifies the artifact
      // server.ts logs http_error only for MUTATING methods — the GET /letter path would otherwise be
      // SILENT in CloudWatch. Log the structured line here so every consumer (GET included) leaves a trace.
      console.warn(JSON.stringify({
        msg: 'http_error',
        source: 'letter-current.readTxtFromS3',
        status: 404,
        code: 'not_found',
        reason: 'letter_artifact_missing',
        ...(ctx !== undefined ? { caseId: ctx.caseId, version: ctx.version } : {}),
        s3KeyBasename: baseName,
      }));
      throw new HttpError(
        404,
        'not_found',
        `Letter artifact missing from storage for v${ctx?.version ?? '?'} — the draft run that created this version never uploaded its files. Re-draft to produce a new letter.`,
        { ...(ctx !== undefined ? { caseId: ctx.caseId, version: ctx.version } : {}), s3Key: baseName, reason: 'letter_artifact_missing' },
      );
    }
    throw e;
  }
  if (obj.Body === undefined) throw new HttpError(502, 'internal_error', 'Letter TXT object had no body.', { reason: 'read_failed', key });
  return obj.Body.transformToString('utf-8');
}

/** Deterministic byte-binding hash of the letter TXT (the signed source of truth). */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Resolve the current version's TXT and return { version, txt, sha256 }. Returns null when no
 * current letter exists (caller decides whether that is a 409). Reuses the same resolution the
 * /letter route uses so sign-off and delivery agree on what "current" means byte-for-byte.
 */
export async function resolveCurrentTxtWithHash(
  db: AppDb,
  s3: S3Client,
  bucketName: string,
  caseId: string,
  currentVersion: number,
): Promise<{ version: number; txt: string; sha256: string } | null> {
  const ref = await resolveCurrentTxtKey(db, caseId, currentVersion);
  if (ref === null) return null;
  const txt = await readTxtFromS3(s3, bucketName, ref.txtKey, { caseId, version: ref.version });
  return { version: ref.version, txt, sha256: sha256OfText(txt) };
}

/**
 * RECOVERY-CAPABLE byte-binding (CLM-8EC828F1D7 must-fix #2, 2026-07-01). Identical to
 * resolveCurrentTxtWithHash but resolves the letter via resolveViewableCurrentTxtKey (strict → walk →
 * S3-truth) — the SAME letter the physician was shown by GET /letter. The sign-off must bind its content
 * hash to the letter the physician actually saw: on a stranded pointer the strict resolver returned null,
 * so the sign-off recorded signedVersion/sha256 = null → the delivery "signed_bytes_changed" tamper
 * tripwire was ABSENT and the egress gate failed open. Binding to the recovered version restores the
 * tamper check. s3/bucket are REQUIRED here (the sign-off path only calls this when both are wired);
 * resolveViewableCurrentTxtKey still fails open to strict if they were somehow undefined.
 */
export async function resolveViewableCurrentTxtWithHash(
  db: AppDb,
  s3: S3Client,
  bucketName: string,
  caseId: string,
  currentVersion: number,
): Promise<{ version: number; txt: string; sha256: string } | null> {
  const ref = await resolveViewableCurrentTxtKey(db, s3, bucketName, caseId, currentVersion);
  if (ref === null) return null;
  const txt = await readTxtFromS3(s3, bucketName, ref.txtKey, { caseId, version: ref.version });
  return { version: ref.version, txt, sha256: sha256OfText(txt) };
}

/**
 * Current-revision metadata (import deliver-as-is, 2026-06-14). The TXT-binding above is the source
 * of truth for the NORMAL letter lifecycle, but an externally-imported letter (LetterRevision
 * source='external_import') has no real TXT — only a placeholder sidecar — and its canonical content
 * is the PDF artifact. The finalize-as-is path + the delivery-eligibility gate need to know the
 * source + the PDF key of the CURRENT version so they can byte-bind to the imported PDF instead of
 * the placeholder TXT. Resolves the LetterRevision row only (a plain DraftJob has no `source`).
 */
export interface CurrentRevisionMeta {
  readonly id: string;
  readonly version: number;
  readonly source: string;
  readonly pdfKey: string | null;
}

export async function resolveCurrentRevisionMeta(db: AppDb, caseId: string, currentVersion: number): Promise<CurrentRevisionMeta | null> {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) return null;
  const rev = (await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } })) as
    | { id: string; version: number; source: string; artifactPdfS3Key: string | null }
    | null;
  if (rev === null) return null;
  return { id: rev.id, version: rev.version, source: rev.source, pdfKey: rev.artifactPdfS3Key };
}

/**
 * Fetch a binary S3 object (a PDF) and return its raw bytes + sha256 (import deliver-as-is,
 * 2026-06-14). Used to byte-bind a sign-off to the EXACT imported PDF bytes — the same role
 * sha256OfText(TXT) plays for a rendered letter. Reuses the readTxtFromS3 NoSuchKey→404 mapping
 * shape so a missing PDF surfaces as a structured 404, not an unhandled 500.
 */
export async function readPdfBytesWithHash(
  s3: S3Client,
  bucketName: string,
  key: string,
  ctx?: LetterTxtContext,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      const baseName = key.split('/').pop() ?? key;
      console.warn(JSON.stringify({
        msg: 'http_error',
        source: 'letter-current.readPdfBytesWithHash',
        status: 404,
        code: 'not_found',
        reason: 'letter_artifact_missing',
        ...(ctx !== undefined ? { caseId: ctx.caseId, version: ctx.version } : {}),
        s3KeyBasename: baseName,
      }));
      throw new HttpError(
        404,
        'not_found',
        `Imported letter PDF missing from storage for v${ctx?.version ?? '?'} — re-import the finished PDF.`,
        { ...(ctx !== undefined ? { caseId: ctx.caseId, version: ctx.version } : {}), s3Key: baseName, reason: 'letter_artifact_missing' },
      );
    }
    throw e;
  }
  if (obj.Body === undefined) throw new HttpError(502, 'internal_error', 'Imported letter PDF object had no body.', { reason: 'read_failed', key });
  const bytes = await obj.Body.transformToByteArray();
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
