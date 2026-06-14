import { describe, expect, it, vi } from 'vitest';
import { assertDeliveryEligible } from '../services/delivery-eligibility.js';
import type { AppDb } from '../services/db-types.js';

// Correction-round SSOT (audit 2026-06-13): the ONE predicate every egress (Stripe webhook, the RN
// delivery panel, the human ->delivered status flip) calls before a signed nexus letter reaches a
// veteran. These tests pin its five behaviors: eligible, no-signoff, non-affirmative, bytes-changed,
// and the two fail-open skips (legacy/no-hash sign-off + S3 unconfigured).

const SIGNED_TXT = 'Dear Veteran,\n\nThis is the signed letter body.\n';
// sha256 of SIGNED_TXT — the byte the sign-off bound to. assertDeliveryEligible re-hashes the
// current TXT via resolveCurrentTxtWithHash and compares; we make S3 return SIGNED_TXT so the
// "eligible" + "bytes-changed" cases differ only in the sign-off's stored hash.
import { sha256OfText } from '../services/letter-current.js';
const SIGNED_SHA = sha256OfText(SIGNED_TXT);

function fakeS3(body: string) {
  return {
    send: vi.fn(async () => ({ Body: { transformToString: async () => body } })),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}

interface SignOffRow {
  answersJson: unknown;
  signedVersion: number | null;
  signedContentSha256: string | null;
}

function makeDb(signOffs: SignOffRow[], opts: { revisionTxtKey?: string | null } = {}): AppDb {
  const revKey = opts.revisionTxtKey === undefined ? 'letter-revisions/C1/v7/letter.txt' : opts.revisionTxtKey;
  return {
    signOff: { findMany: vi.fn(async () => signOffs.map((s, i) => ({ id: `S${i}`, ...s }))) },
    // resolveCurrentTxtWithHash -> resolveCurrentTxtKey prefers a LetterRevision; supply one (or null).
    letterRevision: { findFirst: vi.fn(async () => (revKey === null ? null : { version: 7, artifactTxtS3Key: revKey })) },
    draftJob: { findFirst: vi.fn(async () => null) },
  } as unknown as AppDb;
}

const AFFIRMATIVE = { records_reviewed: true, dx_documented: true, nexus_supported: true };
const NON_AFFIRMATIVE = { records_reviewed: true, dx_documented: false, nexus_supported: true };
const DEPS = { s3: fakeS3(SIGNED_TXT), bucketName: 'phi-bucket' };

describe('assertDeliveryEligible (correction-round SSOT)', () => {
  it('ELIGIBLE: affirmative sign-off whose bound hash matches the current bytes', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('NO_SIGNOFF: a case with no sign-off is ineligible (NEVER fail-open)', async () => {
    const db = makeDb([]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('no_signoff');
  });

  it('NOT_AFFIRMATIVE: a sign-off with any "No" answer is ineligible (NEVER fail-open)', async () => {
    const db = makeDb([{ answersJson: NON_AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signoff_not_affirmative');
  });

  it('BYTES_CHANGED: affirmative sign-off but the current TXT no longer matches the bound hash', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: 'deadbeef_old_hash' }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signed_bytes_changed');
    expect(r.details?.currentVersion).toBe(7);
  });

  it('uses the LATEST sign-off (newest by signedAt is [0]) — an older affirmative one does not rescue a newer "No"', async () => {
    const db = makeDb([
      { answersJson: NON_AFFIRMATIVE, signedVersion: 8, signedContentSha256: SIGNED_SHA }, // newest
      { answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA },
    ]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signoff_not_affirmative');
  });

  // ── Fail-open: ONLY the byte step, ONLY where delivery.ts fails open ──
  it('FAIL-OPEN (no bound hash): a legacy affirmative sign-off with no signedContentSha256 skips the byte check and is eligible', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: null, signedContentSha256: null }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(true);
    expect(r.details?.byteCheckSkipped).toBe(true);
  });

  it('FAIL-OPEN (S3 unconfigured): an affirmative sign-off with a bound hash but no S3/bucket skips the byte check and is eligible', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, {}); // no s3, no bucket
    expect(r.eligible).toBe(true);
    expect(r.details?.byteCheckSkipped).toBe(true);
  });

  it('FAIL-OPEN (no resolvable current letter): a bound hash but the current TXT cannot be resolved does NOT block (only a positive mismatch 409s, like delivery.ts)', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA }], { revisionTxtKey: null });
    const r = await assertDeliveryEligible(db, 'C1', 7, DEPS);
    expect(r.eligible).toBe(true);
  });
});
