import { afterEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { readTxtFromS3, sha256OfText } from '../services/letter-current.js';
import { HttpError, isHttpError } from '../http/errors.js';

// CLM-BBFCB3F8CE (2026-06-11): an S3 NoSuchKey escaped readTxtFromS3 as an unhandled 500
// ("Unexpected server error") — a dead-end generic. The fix maps NoSuchKey/NotFound to a
// structured 404 that names the case + version, redacts the S3 key to its basename, and
// logs an http_error warn line (GET routes get NO http_error line from server.ts, which
// only logs mutating methods — without this warn the failure is invisible in CloudWatch).

function s3Throwing(errorName: string): S3Client {
  const err = new Error(`The specified key does not exist. (${errorName})`);
  err.name = errorName;
  return { send: vi.fn(async () => { throw err; }) } as unknown as S3Client;
}

function s3Returning(text: string): S3Client {
  return { send: vi.fn(async () => ({ Body: { transformToString: async () => text } })) } as unknown as S3Client;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('readTxtFromS3 — missing-artifact handling', () => {
  it('maps NoSuchKey to a structured 404 with the real cause + fix path (never a 500)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s3 = s3Throwing('NoSuchKey');

    let caught: unknown;
    try {
      await readTxtFromS3(s3, 'phi-bucket', 'letter-revisions/CASE-1/v3/letter.txt', { caseId: 'CASE-1', version: 3 });
    } catch (e: unknown) {
      caught = e;
    }

    expect(isHttpError(caught)).toBe(true);
    const httpErr = caught as HttpError;
    expect(httpErr.status).toBe(404);
    expect(httpErr.code).toBe('not_found');
    // The message must surface the REAL cause + actionable fix path verbatim.
    expect(httpErr.message).toBe('Letter artifact missing from storage for v3 — the draft run that created this version never uploaded its files. Re-draft to produce a new letter.');
    const details = httpErr.details as { caseId?: string; version?: number; s3Key?: string; reason?: string };
    expect(details.caseId).toBe('CASE-1');
    expect(details.version).toBe(3);
    expect(details.reason).toBe('letter_artifact_missing');
    // S3 key is redacted to the basename — no full path in the envelope.
    expect(details.s3Key).toBe('letter.txt');
    expect(details.s3Key).not.toContain('/');

    // The structured http_error warn fires (GET errors are otherwise SILENT in CloudWatch).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged['msg']).toBe('http_error');
    expect(logged['status']).toBe(404);
    expect(logged['reason']).toBe('letter_artifact_missing');
    expect(logged['caseId']).toBe('CASE-1');
    expect(logged['version']).toBe(3);
  });

  it('maps NotFound (HEAD-style) the same way, and works without caller context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s3 = s3Throwing('NotFound');
    await expect(readTxtFromS3(s3, 'phi-bucket', 'letter-revisions/CASE-9/v1/letter.txt')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      details: { s3Key: 'letter.txt', reason: 'letter_artifact_missing' },
    });
  });

  it('rethrows non-missing-key S3 errors unchanged (no masking of real faults)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s3 = s3Throwing('AccessDenied');
    await expect(readTxtFromS3(s3, 'phi-bucket', 'k.txt', { caseId: 'CASE-1', version: 1 })).rejects.toThrow('AccessDenied');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('happy path still returns the TXT bytes', async () => {
    const s3 = s3Returning('letter body');
    await expect(readTxtFromS3(s3, 'phi-bucket', 'k.txt', { caseId: 'CASE-1', version: 1 })).resolves.toBe('letter body');
    // sanity: hash helper unaffected
    expect(sha256OfText('letter body')).toHaveLength(64);
  });
});
