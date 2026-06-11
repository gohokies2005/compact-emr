import { describe, expect, it } from 'vitest';
import {
  buildUserAvatarKey,
  isCaseDocumentS3Key,
  isDoctorPackS3Key,
  isDrafterArtifactS3Key,
  isDrafterExportS3Key,
  isUserAvatarS3Key,
} from '../services/s3-key-safety.js';

/**
 * Task #107a regression tests. The validators close worker-callback + client-callback
 * tampering by enforcing per-domain S3 key patterns. These tests lock the behavior so
 * a future regex relaxation can't silently re-open the path-traversal hole.
 */

describe('isDoctorPackS3Key', () => {
  it('accepts a canonical doctor-pack key', () => {
    expect(isDoctorPackS3Key('doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf')).toBe(true);
  });

  it('rejects path-traversal via "..": doctor-packs/../etc/passwd', () => {
    expect(isDoctorPackS3Key('doctor-packs/../etc/passwd.pdf')).toBe(false);
  });

  it('rejects path-traversal embedded in caseId segment', () => {
    expect(isDoctorPackS3Key('doctor-packs/..foo/v1/00000000-0000-0000-0000-000000000000.pdf')).toBe(false);
  });

  it('rejects wrong prefix (different bucket subtree)', () => {
    expect(isDoctorPackS3Key('drafter-artifacts/CASE-1/v1/foo.pdf')).toBe(false);
  });

  it('rejects leading slash', () => {
    expect(isDoctorPackS3Key('/doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf')).toBe(false);
  });

  it('rejects uppercase-hex filename (randomUUID always lowercase)', () => {
    expect(isDoctorPackS3Key('doctor-packs/CASE-1/v1/A1B2C3D4-E5F6-7890-ABCD-EF1234567890.pdf')).toBe(false);
  });

  it('rejects control chars + backslashes', () => {
    expect(isDoctorPackS3Key('doctor-packs/CASE-1\\v1\\foo.pdf')).toBe(false);
    expect(isDoctorPackS3Key('doctor-packs/CASE-1/v1/foo\x00.pdf')).toBe(false);
  });

  it('rejects empty string + over-length key', () => {
    expect(isDoctorPackS3Key('')).toBe(false);
    expect(isDoctorPackS3Key('doctor-packs/CASE-1/v1/' + 'a'.repeat(600) + '.pdf')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isDoctorPackS3Key(null)).toBe(false);
    expect(isDoctorPackS3Key(undefined)).toBe(false);
    expect(isDoctorPackS3Key(42)).toBe(false);
    expect(isDoctorPackS3Key({})).toBe(false);
  });
});

describe('isDrafterArtifactS3Key', () => {
  it('accepts canonical drafter artifact keys (pdf, txt, docx, json)', () => {
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/v3.pdf')).toBe(true);
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/v3.txt')).toBe(true);
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/v3.docx')).toBe(true);
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/v3_qa_grade.json')).toBe(true);
  });

  it('rejects path-traversal via ".." in artifact key', () => {
    expect(isDrafterArtifactS3Key('drafter-artifacts/../doctor-packs/foo.pdf')).toBe(false);
  });

  it('rejects wrong extension', () => {
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/v3.exe')).toBe(false);
  });

  it('rejects nested subdirectory in filename slot', () => {
    expect(isDrafterArtifactS3Key('drafter-artifacts/CASE-1/v3/sub/v3.pdf')).toBe(false);
  });
});

describe('isCaseDocumentS3Key', () => {
  it('accepts a canonical case-document key', () => {
    expect(isCaseDocumentS3Key('cases/CASE-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890-report.pdf')).toBe(true);
  });

  it('rejects path-traversal in the document-registration callback', () => {
    expect(isCaseDocumentS3Key('cases/../secrets/leak.pdf')).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(isCaseDocumentS3Key('doctor-packs/CASE-1/v1/foo.pdf')).toBe(false);
  });
});

describe('isDrafterExportS3Key', () => {
  it('accepts canonical export keys', () => {
    expect(isDrafterExportS3Key('drafter-exports/CASE-1/abc-123.json')).toBe(true);
    expect(isDrafterExportS3Key('drafter-exports/CASE-1/manual-2026-05-26T08-00-00-000Z.json')).toBe(true);
  });

  it('rejects path-traversal', () => {
    expect(isDrafterExportS3Key('drafter-exports/../secrets/foo.json')).toBe(false);
  });

  it('rejects non-JSON extension', () => {
    expect(isDrafterExportS3Key('drafter-exports/CASE-1/foo.pdf')).toBe(false);
  });
});

describe('isUserAvatarS3Key (P3 identity/avatar)', () => {
  it('accepts canonical avatar keys for each allowed extension', () => {
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png')).toBe(true);
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg')).toBe(true);
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpeg')).toBe(true);
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.webp')).toBe(true);
  });

  it('rejects path-traversal', () => {
    expect(isUserAvatarS3Key('avatars/../physician-signatures/leak.png')).toBe(false);
    expect(isUserAvatarS3Key('avatars/U-1/../../leak.png')).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(isUserAvatarS3Key('cases/U-1/a1b2c3d4.png')).toBe(false);
    expect(isUserAvatarS3Key('physician-signatures/U-1/a1b2-signature.png')).toBe(false);
  });

  it('rejects wrong extension and uppercase-hex uuid slot', () => {
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4.svg')).toBe(false);
    expect(isUserAvatarS3Key('avatars/U-1/a1b2c3d4.exe')).toBe(false);
    expect(isUserAvatarS3Key('avatars/U-1/NOTHEX.png')).toBe(false);
  });

  it('rejects nested subdirectory in the filename slot and non-string input', () => {
    expect(isUserAvatarS3Key('avatars/U-1/sub/a1b2.png')).toBe(false);
    expect(isUserAvatarS3Key(null)).toBe(false);
    expect(isUserAvatarS3Key(42)).toBe(false);
  });
});

describe('buildUserAvatarKey', () => {
  it('builds a key the validator accepts', () => {
    const key = buildUserAvatarKey('U-1', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'webp');
    expect(key).toBe('avatars/U-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.webp');
    expect(isUserAvatarS3Key(key)).toBe(true);
  });

  it('throws on a userId that would escape the avatars/ subtree', () => {
    expect(() => buildUserAvatarKey('../etc', 'a1b2c3d4', 'png')).toThrow(/invalid key/);
  });
});
