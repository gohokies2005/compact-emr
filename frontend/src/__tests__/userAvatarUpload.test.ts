import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { apiPost } from '../api/client';
import { MAX_AVATAR_BYTES, uploadAndAttachUserAvatar, validateAvatarFile } from '../api/users';

/**
 * P3 avatar upload helper: client-side validation (type + 2 MB cap) and the presign -> PUT ->
 * register sequence with the SERVER-issued key echoed back (mirrors the physician-signature
 * upload). Server-side validation coverage lives in backend users-avatar.test.ts.
 */

vi.mock('axios', () => ({ default: { put: vi.fn(async () => ({})) } }));
vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn() }));

const apiPostMock = vi.mocked(apiPost);
const axiosPutMock = vi.mocked(axios.put);

function fileOf(type: string, size: number, name = 'me.png'): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateAvatarFile', () => {
  it('accepts png/jpeg/webp at or under 2 MB', () => {
    expect(validateAvatarFile(fileOf('image/png', 1024))).toBeNull();
    expect(validateAvatarFile(fileOf('image/jpeg', 1024))).toBeNull();
    expect(validateAvatarFile(fileOf('image/webp', MAX_AVATAR_BYTES))).toBeNull();
  });

  it('rejects other content types', () => {
    expect(validateAvatarFile(fileOf('image/gif', 1024))).toMatch(/PNG, JPEG, or WebP/);
    expect(validateAvatarFile(fileOf('application/pdf', 1024))).toMatch(/PNG, JPEG, or WebP/);
  });

  it('rejects files over the 2 MB cap', () => {
    expect(validateAvatarFile(fileOf('image/png', MAX_AVATAR_BYTES + 1))).toMatch(/2 MB or smaller/);
  });
});

describe('uploadAndAttachUserAvatar', () => {
  const PRESIGNED = {
    data: {
      uploadUrl: 'https://signed.example/put',
      s3Key: 'avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png',
      expiresInSeconds: 300,
      requiredHeaders: { 'content-type': 'image/png', 'x-amz-server-side-encryption': 'aws:kms' },
    },
  };

  it('presigns with the file type+size, PUTs with the required headers, registers the echoed key', async () => {
    const ATTACHED = { data: { id: 'U-1', email: 'rn@x.test', name: 'RN', version: 2, avatarUrl: 'https://signed.example/get' } };
    apiPostMock.mockResolvedValueOnce(PRESIGNED).mockResolvedValueOnce(ATTACHED);
    const file = fileOf('image/png', 2048);

    const result = await uploadAndAttachUserAvatar('U-1', file);

    expect(apiPostMock).toHaveBeenNthCalledWith(1, '/api/v1/users/U-1/avatar/presign', { contentType: 'image/png', sizeBytes: 2048 });
    expect(axiosPutMock).toHaveBeenCalledWith('https://signed.example/put', file, { headers: PRESIGNED.data.requiredHeaders });
    expect(apiPostMock).toHaveBeenNthCalledWith(2, '/api/v1/users/U-1/avatar', { s3Key: PRESIGNED.data.s3Key });
    expect(result.data.avatarUrl).toBe('https://signed.example/get');
  });

  it('rejects a wrong type BEFORE any network call', async () => {
    await expect(uploadAndAttachUserAvatar('U-1', fileOf('image/gif', 100))).rejects.toThrow(/PNG, JPEG, or WebP/);
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(axiosPutMock).not.toHaveBeenCalled();
  });

  it('rejects an oversize file BEFORE any network call', async () => {
    await expect(uploadAndAttachUserAvatar('U-1', fileOf('image/png', MAX_AVATAR_BYTES + 1))).rejects.toThrow(/2 MB/);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('does not register a key when the S3 PUT fails (no dangling row pointer)', async () => {
    apiPostMock.mockResolvedValueOnce(PRESIGNED);
    axiosPutMock.mockRejectedValueOnce(new Error('network'));
    await expect(uploadAndAttachUserAvatar('U-1', fileOf('image/png', 100))).rejects.toThrow('network');
    expect(apiPostMock).toHaveBeenCalledTimes(1); // presign only — attach never fired
  });
});
