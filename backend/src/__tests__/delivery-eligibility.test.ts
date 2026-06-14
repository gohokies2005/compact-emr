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

// ── Imported letters (import deliver-as-is, 2026-06-14) ──────────────────────────────────────────
// An external_import current revision has no real TXT; the gate must re-hash the PDF artifact and
// compare to the sign-off's PDF-bound hash. These pin: eligible (PDF matches), bytes-changed (PDF
// changed after sign-off → block), and the affirmative + exists gates still apply.
import { createHash } from 'node:crypto';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x99, 0x01]); // "%PDF-1.7\n.."
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');
const PDF_KEY = 'drafter-artifacts/C1/v7/imported-letter.pdf';

function fakeS3Pdf(bytes: Uint8Array) {
  return {
    send: vi.fn(async () => ({ Body: { transformToByteArray: async () => bytes, transformToString: async () => '[placeholder]' } })),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}

function makeImportDb(signOffs: SignOffRow[], opts: { pdfKey?: string | null; source?: string } = {}): AppDb {
  const pdfKey = opts.pdfKey === undefined ? PDF_KEY : opts.pdfKey;
  const source = opts.source ?? 'external_import';
  return {
    signOff: { findMany: vi.fn(async () => signOffs.map((s, i) => ({ id: `S${i}`, ...s }))) },
    // resolveCurrentRevisionMeta reads source + artifactPdfS3Key; resolveCurrentTxtKey (TXT path) is
    // NOT reached for an external_import row.
    letterRevision: { findFirst: vi.fn(async () => ({ id: 'REV7', version: 7, source, artifactPdfS3Key: pdfKey, artifactTxtS3Key: 'drafter-artifacts/C1/v7/imported-letter.txt' })) },
    draftJob: { findFirst: vi.fn(async () => null) },
  } as unknown as AppDb;
}

describe('assertDeliveryEligible — imported letters (PDF byte-binding)', () => {
  it('ELIGIBLE: external_import whose sign-off hash matches the imported PDF bytes', async () => {
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: PDF_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.details?.currentVersion).toBe(7);
  });

  it('BYTES_CHANGED: the imported PDF changed after sign-off → block (false ALLOW would ship the wrong PDF)', async () => {
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: 'old_pdf_hash_deadbeef' }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signed_bytes_changed');
  });

  it('binds to the PDF, NOT the placeholder TXT: a TXT-hash sign-off does NOT match the PDF re-hash', async () => {
    // A sign-off bound to the placeholder TXT (the wrong source) must be rejected — the PDF is what
    // ships. We bind to the TXT sha and confirm the PDF re-hash blocks it.
    const placeholderTxtSha = sha256OfText('[placeholder]');
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: placeholderTxtSha }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signed_bytes_changed');
  });

  it('NO_SIGNOFF still blocks an imported letter (exists gate runs before the PDF re-hash)', async () => {
    const db = makeImportDb([]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('no_signoff');
  });

  it('NOT_AFFIRMATIVE still blocks an imported letter (affirmative gate runs before the PDF re-hash)', async () => {
    const db = makeImportDb([{ answersJson: NON_AFFIRMATIVE, signedVersion: 7, signedContentSha256: PDF_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('signoff_not_affirmative');
  });

  // ── P2-1 (doc-set closure + sweep hardening, 2026-06-14): imports NEVER fail open ──
  // For an external_import the PDF byte-bind is the ONLY proof the delivered bytes match the
  // attestation — there is no TXT re-render backstop. So whenever the byte step CANNOT run, an import
  // must BLOCK ('cannot_verify_import'), unlike a normal letter which fails open to the TXT backstop.
  it('CANNOT_VERIFY_IMPORT (no PDF key): an import with nothing to re-hash BLOCKS — never fail-open', async () => {
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: PDF_SHA }], { pdfKey: null });
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('cannot_verify_import');
  });

  it('CANNOT_VERIFY_IMPORT (S3 unconfigured): an import with no s3/bucket BLOCKS (a normal letter would fail-open here)', async () => {
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: PDF_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, {}); // no s3, no bucket
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('cannot_verify_import');
  });

  it('CANNOT_VERIFY_IMPORT (legacy sign-off, no bound hash): an import with no signedContentSha256 BLOCKS', async () => {
    const db = makeImportDb([{ answersJson: AFFIRMATIVE, signedVersion: null, signedContentSha256: null }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, { s3: fakeS3Pdf(PDF_BYTES), bucketName: 'phi-bucket' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('cannot_verify_import');
  });

  it('exists + affirmative gates STILL run before the import-verify block (no_signoff beats cannot_verify_import)', async () => {
    // An import with no s3/bucket AND no sign-off must report no_signoff (the more fundamental gate),
    // proving the import-block didn't short-circuit ahead of the exists check.
    const db = makeImportDb([]);
    const r = await assertDeliveryEligible(db, 'C1', 7, {});
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('no_signoff');
  });

  it('REGRESSION: a NORMAL (non-import) letter with no s3/bucket STILL fails open (TXT backstop) — import-block must not bleed into the normal path', async () => {
    const db = makeDb([{ answersJson: AFFIRMATIVE, signedVersion: 7, signedContentSha256: SIGNED_SHA }]);
    const r = await assertDeliveryEligible(db, 'C1', 7, {}); // no s3, no bucket
    expect(r.eligible).toBe(true);
    expect(r.details?.byteCheckSkipped).toBe(true);
  });
});
