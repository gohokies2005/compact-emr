import { type S3Client } from '@aws-sdk/client-s3';
import { isSignOffAffirmative } from './sign-off-validation.js';
import { resolveCurrentTxtWithHash, resolveCurrentRevisionMeta, readPdfBytesWithHash } from './letter-current.js';
import type { AppDb } from './db-types.js';

/**
 * SINGLE SOURCE OF TRUTH for "may this case's signed nexus letter egress to the veteran?"
 * (correction-round SSOT, audit 2026-06-13).
 *
 * Three independent egress paths were each enforcing (or NOT enforcing) the sign/byte contract on
 * their own — and they had drifted: the RN delivery panel (delivery.ts /send) re-hashed the signed
 * bytes correctly, but the REAL Stripe→portal egress (payment-delivery.processStripePayment) had NO
 * byte-binding gate at all, and a bare RN status-flip correction_review→delivered skipped both. A
 * version advanced after sign-off (an editor save, a correction round, a bare flip) would ship
 * UNSIGNED or WRONG bytes — a signed legal opinion the physician never attested to, for money.
 *
 * This function is the one predicate all of them now call. It does NOT throw — it returns a
 * structured verdict so the Stripe path can record the payment + flip the case to paid while still
 * withholding the token+email, and the human status-route can translate the verdict into a 409.
 *
 * It checks, for a case:
 *   1. a sign-off EXISTS (latest by signedAt). Missing = ineligible ('no_signoff') — NEVER fail-open.
 *   2. that sign-off is AFFIRMATIVE — every attestation answer is "Yes" (mirrors sign-offs.ts:46 via
 *      the shared isSignOffAffirmative predicate; a "No" attestation can never finalize a letter).
 *      Non-affirmative = ineligible ('signoff_not_affirmative') — NEVER fail-open.
 *   3. BYTE-BINDING — re-hash the CURRENT version's TXT (resolveCurrentTxtWithHash, the same
 *      deterministic source of truth the sign-off bound to) and compare to the sign-off's
 *      signedContentSha256. A mismatch = the letter changed after sign-off = ineligible
 *      ('signed_bytes_changed'). This is a verbatim port of the working gate at delivery.ts:216-236.
 *      EXCEPTION (import deliver-as-is, 2026-06-14): when the current LetterRevision is an
 *      externally-imported letter (source='external_import'), the bound bytes are the imported PDF —
 *      there is no real TXT — so the gate re-hashes the PDF artifact instead.
 *
 * FAIL-OPEN is allowed ONLY where delivery.ts already fails open — and ONLY for the byte step, and
 * ONLY for a NORMAL rendered letter (which has a deterministic TXT re-render backstop):
 *   - no bound signedContentSha256 on the latest sign-off (a legacy sign-off predating byte-binding), or
 *   - S3/bucket unconfigured (no S3 client or no bucket name), so the current TXT can't be re-hashed.
 * In those cases the byte check is SKIPPED but the exists + affirmative checks have already passed,
 * so we return eligible. A MISSING or NON-AFFIRMATIVE sign-off is never fail-open.
 *
 * IMPORTS NEVER FAIL OPEN (P2-1, 2026-06-14): for an external_import the PDF byte-bind is the ONLY
 * proof the delivered bytes match the attestation — there is NO TXT re-render fallback. So when the
 * current revision is an import and the byte step CANNOT run (no S3/bucket, no bound hash, or no PDF
 * key to re-hash), we return INELIGIBLE 'cannot_verify_import' rather than shipping unverified bytes.
 * The source is resolved (a pure DB read) BEFORE the fail-open branch so this can't be bypassed.
 */

export type DeliveryIneligibleReason =
  | 'no_signoff'
  | 'signoff_not_affirmative'
  | 'signed_bytes_changed'
  | 'cannot_verify_import';

export interface DeliveryEligibility {
  readonly eligible: boolean;
  readonly reason?: DeliveryIneligibleReason;
  readonly details?: {
    readonly caseId: string;
    readonly signedVersion?: number | null;
    readonly currentVersion?: number;
    /** True when the byte check was skipped fail-open (legacy/no-hash or S3 unconfigured). */
    readonly byteCheckSkipped?: boolean;
  };
}

export interface DeliveryEligibilityDeps {
  /** S3 + bucket power the byte re-hash. When either is absent the byte step fails open (like delivery.ts). */
  readonly s3?: S3Client;
  readonly bucketName?: string;
}

export async function assertDeliveryEligible(
  db: AppDb,
  caseId: string,
  currentVersion: number,
  deps: DeliveryEligibilityDeps = {},
): Promise<DeliveryEligibility> {
  // 1. Latest sign-off must EXIST. (Same ordering the delivery.ts gate + the sign-offs list use.)
  const signOffs = await db.signOff.findMany({ where: { caseId }, orderBy: { signedAt: 'desc' } });
  const latest = signOffs.length > 0 ? signOffs[0] : null;
  if (latest === null) {
    return { eligible: false, reason: 'no_signoff', details: { caseId } };
  }

  // 2. The latest sign-off must be AFFIRMATIVE (every item "Yes"). Reuse the shared predicate so the
  //    delivery gate and the sign-off route can never diverge on what "ready" means.
  if (!isSignOffAffirmative(latest.answersJson)) {
    return { eligible: false, reason: 'signoff_not_affirmative', details: { caseId, signedVersion: latest.signedVersion } };
  }

  // 3. BYTE-BINDING (verbatim port of delivery.ts:216-236). The current revision's SOURCE decides
  //    what fail-open means, so resolve it FIRST (a pure DB read; needs no S3/bucket). For a normal
  //    rendered letter, the byte step may fail open (the TXT re-render is a backstop). For an
  //    external_import there is NO re-render backstop — the PDF byte-bind is the ONLY proof the
  //    delivered bytes are the bytes the physician attested to — so an UNVERIFIABLE import must BLOCK,
  //    never fail open. (P2-1, doc-set closure + sweep hardening, 2026-06-14.)
  const meta = await resolveCurrentRevisionMeta(db, caseId, currentVersion);
  const isImport = meta !== null && meta.source === 'external_import';

  const hasBoundHash = typeof latest.signedContentSha256 === 'string' && latest.signedContentSha256.length > 0;
  const byteCheckUnavailable = !hasBoundHash || deps.s3 === undefined || deps.bucketName === undefined;

  if (byteCheckUnavailable) {
    if (isImport) {
      // IMPORTED LETTER with no way to re-hash the bound PDF (no S3/bucket, or a legacy sign-off with
      // no bound hash). There is no TXT re-render fallback, so we CANNOT prove the delivered bytes
      // match the attestation. Block — do NOT fail open. (P2-1, 2026-06-14.)
      return {
        eligible: false,
        reason: 'cannot_verify_import',
        details: { caseId, signedVersion: latest.signedVersion, currentVersion: meta!.version },
      };
    }
    // Normal (non-import) letter: skip the byte step, same fail-open as delivery.ts (TXT re-render
    // is the backstop). The exists + affirmative gates have already passed.
    return { eligible: true, details: { caseId, signedVersion: latest.signedVersion, byteCheckSkipped: true } };
  }

  // From here s3 + bucketName + a bound hash are all present (TS-narrowed by byteCheckUnavailable).
  const s3 = deps.s3 as NonNullable<typeof deps.s3>;
  const bucketName = deps.bucketName as NonNullable<typeof deps.bucketName>;

  // IMPORTED LETTERS (import deliver-as-is, 2026-06-14): an externally-imported letter
  // (LetterRevision source='external_import') has no real TXT — only a placeholder sidecar — and its
  // canonical content is the PDF. /letter/finalize-import binds the sign-off to sha256(PDF bytes), so
  // here we MUST re-hash the same PDF (NOT the placeholder TXT, whose hash never moves and would
  // always "match", defeating the gate). Unlike the TXT path, an UNRESOLVABLE import artifact does
  // NOT fail open (no re-render backstop) — a missing PDF key blocks as cannot_verify_import (P2-1).
  if (isImport) {
    if (meta!.pdfKey === null) {
      return {
        eligible: false,
        reason: 'cannot_verify_import',
        details: { caseId, signedVersion: latest.signedVersion, currentVersion: meta!.version },
      };
    }
    const pdf = await readPdfBytesWithHash(s3, bucketName, meta!.pdfKey, { caseId, version: meta!.version });
    if (pdf.sha256 !== latest.signedContentSha256) {
      return {
        eligible: false,
        reason: 'signed_bytes_changed',
        details: { caseId, signedVersion: latest.signedVersion, currentVersion: meta!.version },
      };
    }
    return { eligible: true, details: { caseId, signedVersion: latest.signedVersion, currentVersion: meta!.version } };
  }

  const cur = await resolveCurrentTxtWithHash(db, s3, bucketName, caseId, currentVersion);
  // A null current TXT (no resolvable letter) leaves nothing to compare; treat as fail-open on the
  // byte step (the exists + affirmative gates already passed) — matches delivery.ts, which 409s only
  // on a POSITIVE mismatch, never on an unresolvable current letter.
  if (cur !== null && cur.sha256 !== latest.signedContentSha256) {
    return {
      eligible: false,
      reason: 'signed_bytes_changed',
      details: { caseId, signedVersion: latest.signedVersion, currentVersion: cur.version },
    };
  }
  return { eligible: true, details: { caseId, signedVersion: latest.signedVersion, currentVersion: cur?.version } };
}
