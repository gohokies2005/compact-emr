import { createHash } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
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
