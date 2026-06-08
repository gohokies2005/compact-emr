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

export async function readTxtFromS3(s3: S3Client, bucketName: string, key: string): Promise<string> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
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
  const txt = await readTxtFromS3(s3, bucketName, ref.txtKey);
  return { version: ref.version, txt, sha256: sha256OfText(txt) };
}
