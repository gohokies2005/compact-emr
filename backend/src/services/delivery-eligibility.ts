import { type S3Client } from '@aws-sdk/client-s3';
import { isSignOffAffirmative } from './sign-off-validation.js';
import { resolveCurrentTxtWithHash } from './letter-current.js';
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
 *
 * FAIL-OPEN is allowed ONLY where delivery.ts already fails open — and ONLY for the byte step:
 *   - no bound signedContentSha256 on the latest sign-off (a legacy sign-off predating byte-binding), or
 *   - S3/bucket unconfigured (no S3 client or no bucket name), so the current TXT can't be re-hashed.
 * In those cases the byte check is SKIPPED but the exists + affirmative checks have already passed,
 * so we return eligible. A MISSING or NON-AFFIRMATIVE sign-off is never fail-open.
 */

export type DeliveryIneligibleReason = 'no_signoff' | 'signoff_not_affirmative' | 'signed_bytes_changed';

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

  // 3. BYTE-BINDING (verbatim port of delivery.ts:216-236). Skip ONLY when there is no bound hash to
  //    compare against (legacy sign-off) or S3/bucket is unconfigured — same fail-open as delivery.ts.
  const hasBoundHash = typeof latest.signedContentSha256 === 'string' && latest.signedContentSha256.length > 0;
  if (!hasBoundHash || deps.s3 === undefined || deps.bucketName === undefined) {
    return { eligible: true, details: { caseId, signedVersion: latest.signedVersion, byteCheckSkipped: true } };
  }
  const cur = await resolveCurrentTxtWithHash(db, deps.s3, deps.bucketName, caseId, currentVersion);
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
