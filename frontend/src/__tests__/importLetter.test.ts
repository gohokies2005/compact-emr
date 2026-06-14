import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { apiPost } from '../api/client';
import { uploadAndImportLetter, validateImportLetterFile } from '../api/drafter';

/**
 * Import final letter (2026-06-14): drop an already-FINISHED letter PDF onto a case so it lands in
 * the RN review queue. Client-side validation (PDF only, 50 MB cap, non-empty) + the presign ->
 * S3 PUT (exact bytes) -> commit sequence with the SERVER-issued key echoed back. The commit body
 * is FLAT ({ ok, version }) — matching the backend res.json, NOT a { data } wrapper. Server-side
 * route coverage lives in backend drafter-import-letter.test.ts.
 */

vi.mock('axios', () => ({ default: { put: vi.fn(async () => ({})) } }));
vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn() }));

const apiPostMock = vi.mocked(apiPost);
const axiosPutMock = vi.mocked(axios.put);

function fileOf(type: string, size: number, name = 'final.pdf'): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateImportLetterFile', () => {
  it('accepts a PDF at or under 50 MB', () => {
    expect(validateImportLetterFile(fileOf('application/pdf', 1024))).toBeNull();
    expect(validateImportLetterFile(fileOf('application/pdf', 50 * 1024 * 1024))).toBeNull();
  });
  it('rejects a non-PDF', () => {
    expect(validateImportLetterFile(fileOf('image/png', 1024))).toMatch(/must be a PDF/);
  });
  it('rejects an empty file', () => {
    expect(validateImportLetterFile(fileOf('application/pdf', 0))).toMatch(/empty/);
  });
  it('rejects a file over the 50 MB cap', () => {
    expect(validateImportLetterFile(fileOf('application/pdf', 50 * 1024 * 1024 + 1))).toMatch(/50 MB/);
  });
});

describe('uploadAndImportLetter', () => {
  const PRESIGNED = {
    data: {
      uploadUrl: 'https://signed.example/put',
      s3Key: 'drafter-artifacts/CASE-1/v4/imported-letter.pdf',
      version: 4,
      expiresInSeconds: 300,
      requiredHeaders: { 'content-type': 'application/pdf', 'x-amz-server-side-encryption': 'aws:kms' },
    },
  };

  it('presigns, PUTs the exact bytes with required headers, then commits the echoed key + filename', async () => {
    const COMMIT = { ok: true, version: 4, draftJobId: 'JOB-1' };
    apiPostMock.mockResolvedValueOnce(PRESIGNED).mockResolvedValueOnce(COMMIT);
    const file = fileOf('application/pdf', 2048, 'signed-final.pdf');

    const result = await uploadAndImportLetter('CASE-1', file);

    expect(apiPostMock).toHaveBeenNthCalledWith(1, '/api/v1/cases/CASE-1/letter/import-presign', {});
    expect(axiosPutMock).toHaveBeenCalledWith('https://signed.example/put', file, { headers: PRESIGNED.data.requiredHeaders });
    expect(apiPostMock).toHaveBeenNthCalledWith(2, '/api/v1/cases/CASE-1/letter/import', { s3Key: PRESIGNED.data.s3Key, filename: 'signed-final.pdf' });
    expect(result).toEqual({ ok: true, version: 4, draftJobId: 'JOB-1' });
  });

  it('rejects a non-PDF BEFORE any network call', async () => {
    await expect(uploadAndImportLetter('CASE-1', fileOf('image/png', 100))).rejects.toThrow(/must be a PDF/);
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(axiosPutMock).not.toHaveBeenCalled();
  });

  it('does NOT commit when the S3 PUT fails (no dangling row pointer)', async () => {
    apiPostMock.mockResolvedValueOnce(PRESIGNED);
    axiosPutMock.mockRejectedValueOnce(new Error('network'));
    await expect(uploadAndImportLetter('CASE-1', fileOf('application/pdf', 100))).rejects.toThrow('network');
    expect(apiPostMock).toHaveBeenCalledTimes(1); // presign only — commit never fired
  });
});
