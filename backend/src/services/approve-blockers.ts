import type { S3Client } from '@aws-sdk/client-s3';
import { loadReconciledChartReadiness } from './chart-readiness.js';
import { findChartReadinessOverride } from './chart-readiness-override.js';
import {
  parseCredentialBlock,
  substituteSignerSentinels,
  signerNameAppears,
  findForeignSignerNames,
} from './credential-block.js';
import { resolveViewableCurrentTxtKey, readTxtFromS3 } from './letter-current.js';
import type { AppDb, CaseRecord } from './db-types.js';

/**
 * Pre-flight mirror of the POST /cases/:id/letter/approve gates (routes/letter.ts) — the
 * sign-off incident 2026-06-09: the physician completed the whole attestation popup and only
 * THEN hit the 409 signer-name gate (whose message the frontend also swallowed). These advisory
 * flags ride on GET /cases/:id (physician_review only) so the review page can show WHY approve
 * will be blocked BEFORE the physician attests.
 *
 * ADVISORY ONLY — the approve route's own gates remain the single authority (this mirror reuses
 * the exact same primitives: evaluateChartReadiness, parseCredentialBlock,
 * substituteSignerSentinels, signerNameAppears, findForeignSignerNames, resolveViewableCurrentTxtKey —
 * so the verdicts cannot drift in logic, only in coverage). Deliberately NOT mirrored here:
 *   - sign_off_required / sign_off_not_affirmative — the attestation is what the physician is
 *     about to do; flagging its absence pre-attest would always show a banner.
 *   - bad_transition — the review page only renders Approve in physician_review.
 * Codes match the approve gates' details.reason values verbatim so an operator can correlate
 * the banner, the 409 envelope, and the CloudWatch http_error line.
 */

export interface ApproveBlocker {
  readonly code: string;
  readonly message: string;
}

export interface ApproveBlockerDeps {
  readonly s3?: S3Client;
  readonly bucketName?: string;
}

type CaseForBlockers = Pick<CaseRecord, 'id' | 'assignedPhysicianId' | 'currentVersion'>;

export async function computeApproveBlockers(
  db: AppDb,
  c: CaseForBlockers,
  deps: ApproveBlockerDeps = {},
): Promise<ApproveBlocker[]> {
  const blockers: ApproveBlocker[] = [];
  const caseId = c.id;

  // Chart-readiness gate (mirrors letter.ts approve + sign-offs.ts). Suppress this advisory when a
  // physician/admin override already exists (CLM-4DACAF4A80, 2026-06-14) — approve honors it, so the
  // review page must not warn about a gate that will not actually fire (keep the advisory honest with
  // the authoritative gate).
  // RECONCILED readiness (CLM-4DACAF4A80, 2026-06-14): the advisory must mirror the authoritative
  // approve gate, which now drops orphaned rows — otherwise the review page would warn about a gate
  // that will not actually fire. Same shared loader the approve route uses.
  const readiness = await loadReconciledChartReadiness(db, caseId);
  if (!readiness.ready && (await findChartReadinessOverride(db, caseId)) === null) {
    blockers.push({
      code: 'chart_not_ready',
      message: `Approve will be blocked: the chart-readiness gate is failing — ${readiness.blockingFiles.length} file(s) still need an RN manual summary (or a physician override at sign-off).`,
    });
  }

  // A current letter must exist. RECONCILED 2026-07-01 (CLM-8EC828F1D7, Hildreth): use the SAME
  // recovery-capable resolver the read path / review card uses (resolveViewableCurrentTxtKey), NOT the
  // STRICT currentVersion-pinned resolveCurrentTxtKey. A stranded-but-recoverable letter (a halted
  // render-parity draft, hand-edited then forwarded) is served by the review card yet the strict
  // resolver returned null here → the contradictory "Letter ready · Grade A" card AND a hard
  // "No current letter to approve" blocker on the same screen. The approve route now recovers the same
  // letter (resolveCurrentForEdit), so this advisory must mirror it. FAIL-OPEN: with s3/bucket unwired
  // (local/test) it degrades to the strict DB resolution — identical to the pre-change behavior.
  const cur = await resolveViewableCurrentTxtKey(db, deps.s3, deps.bucketName, caseId, c.currentVersion);
  if (cur === null) {
    blockers.push({ code: 'no_letter', message: 'No current letter to approve.' });
  }

  // ── D2 fraud-gate preconditions (signer identity) ──
  if (c.assignedPhysicianId === null) {
    blockers.push({
      code: 'no_assigned_physician',
      message: 'Cannot approve: no physician is assigned to this case. Assign a signing physician, then approve.',
    });
    return blockers; // every remaining check keys off the assigned signer
  }
  const signer = await db.physician.findFirst({ where: { id: c.assignedPhysicianId } });
  if (signer === null) {
    blockers.push({
      code: 'assigned_physician_not_found',
      message: 'Cannot approve: the assigned physician record was not found. Reassign the case to a current physician, then approve.',
    });
    return blockers;
  }
  if (!signer.active) {
    blockers.push({
      code: 'assigned_physician_inactive',
      message: `Cannot approve: ${signer.fullName} is inactive. Reactivate the physician or reassign the case, then approve.`,
    });
  }
  const signerCreds = parseCredentialBlock(signer.credentialBlockJson);
  if (signerCreds === null) {
    blockers.push({
      code: 'signer_credentials_incomplete',
      message: `Cannot approve: ${signer.fullName}'s credential profile is incomplete. An administrator must complete the credential block (name, specialty, board, license, NPI) on the Physicians admin page, then re-approve.`,
    });
  }
  const signatureKey = signer.signatureImageS3Key;
  if (signatureKey === null || signatureKey.trim() === '') {
    blockers.push({
      code: 'signer_signature_missing',
      message: `Cannot approve: ${signer.fullName} has no signature image on file. An administrator must upload the physician's signature on the Physicians admin page, then re-approve.`,
    });
  }

  // ── CO-SIGN preconditions (DPT docket 2026-07-19) ── Mirror the approve route's co-signer gates:
  // if the assigned provider is co-signed, the co-signer must exist, be active, carry a complete
  // credential block, and have a signature on file (else the render's concurrence block would be
  // signature-less or mis-credentialed). coSignerName (when resolvable) is also excluded from the
  // foreign-name check below. A provider with NO co-signer skips all of this (single-signer path).
  let coSignerName: string | null = null;
  if (signer.coSignedByPhysicianId != null) {
    const coSigner = await db.physician.findFirst({ where: { id: signer.coSignedByPhysicianId } });
    if (coSigner === null) {
      blockers.push({
        code: 'co_signer_not_found',
        message: `Approve will be blocked: the co-signing physician for ${signer.fullName} was not found. Reassign the co-signer on the Staff admin page.`,
      });
    } else {
      if (!coSigner.active) {
        blockers.push({
          code: 'co_signer_inactive',
          message: `Approve will be blocked: the co-signing physician ${coSigner.fullName} is inactive. Reactivate them or remove the co-sign on the Staff admin page.`,
        });
      }
      if (parseCredentialBlock(coSigner.credentialBlockJson) === null) {
        blockers.push({
          code: 'co_signer_credentials_incomplete',
          message: `Approve will be blocked: the co-signing physician ${coSigner.fullName}'s credential profile is incomplete. Complete their credential block on the Physicians admin page.`,
        });
      }
      const coSignatureKey = coSigner.signatureImageS3Key;
      if (coSignatureKey === null || coSignatureKey.trim() === '') {
        blockers.push({
          code: 'co_signer_signature_missing',
          message: `Approve will be blocked: the co-signing physician ${coSigner.fullName} has no signature image on file. Upload it on the Physicians admin page.`,
        });
      }
      coSignerName = parseCredentialBlock(coSigner.credentialBlockJson)?.fullNameWithCredential ?? null;
    }
  }

  // ── Letter-text checks (the gate that burned the hour: signer_name_absent). Needs the creds,
  // a current letter, and S3 wired; when any is missing the text checks are SKIPPED (fail-open —
  // never block the GET; approve itself still enforces them authoritatively). ──
  if (signerCreds !== null && cur !== null && deps.s3 !== undefined && deps.bucketName !== undefined) {
    const text = await readTxtFromS3(deps.s3, deps.bucketName, cur.txtKey);
    // Same substitution approve performs before its positive identity check.
    const finalText = substituteSignerSentinels(text, signerCreds, 'their');
    if (!signerNameAppears(finalText, signerCreds.fullNameWithCredential)) {
      blockers.push({
        code: 'signer_name_absent',
        message: `Cannot approve: the letter does not name the assigned signing physician (${signerCreds.fullNameWithCredential}). Regenerate or correct the letter so it is authored under the assigned physician, then approve.`,
      });
    } else {
      // Foreign-name check only runs once the positive check passes (matches approve's ordering).
      const roster = await db.physician.findMany({ where: { active: true } });
      const rosterNames = roster
        .map((p) => parseCredentialBlock(p.credentialBlockJson)?.fullNameWithCredential)
        .filter((n): n is string => typeof n === 'string')
        // Exclude the legit co-signer (see the CO-SIGN block above) so a concurring letter is not
        // false-flagged — without weakening detection of the primary signer or any other physician.
        .filter((n) => coSignerName === null || n !== coSignerName);
      const foreign = findForeignSignerNames(finalText, rosterNames, signerCreds.fullNameWithCredential);
      if (foreign.length > 0) {
        blockers.push({
          code: 'foreign_signer_name',
          message: `Cannot approve: the letter names ${foreign.join(', ')} but the assigned signing physician is ${signerCreds.fullNameWithCredential}. A letter must be signed by the physician it is authored under. Reassign the case to the named physician or regenerate the letter, then approve.`,
        });
      }
    }
  }

  return blockers;
}
