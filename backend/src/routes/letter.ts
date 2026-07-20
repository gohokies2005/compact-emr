import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { letterFilename } from '../services/letterFilename.js';
import { getAiViabilityState } from '../services/ai-viability.js';
import { isSignOffAffirmative } from '../services/sign-off-validation.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';
import { buildLetterRevisionKey } from '../services/s3-key-safety.js';
import { cleanProseForSave, sanityCheckLetterText, computeLockedRanges, type SanityFinding } from '../services/letter-sanity.js';
import { applyStructuredEdit, type EditProposal } from '../services/letter-edit-apply.js';
import { diffCitationsSanctioned, describeToken, extractCitationTokenMap, type CitationDiff } from '../services/letter-citation-integrity.js';
import {
  anchorsToCandidates,
  insertVerifiedCitations,
  type EnrichCandidate,
  type ExtractedTerms,
  type PmidResolveResult,
  type RetrieveResult,
  type VerifyResult,
  type VerifiedCitationForInsert,
} from '../services/citation-enricher.js';
import { holdingConclusionWeakened, sectionViiChanged } from '../services/letter-opinion-excerpt.js';
import { isValidCaseStatusTransition, canRolePerformCaseStatusTransition } from '../services/case-status-transitions.js';
import { resolveRateCents } from '../services/pay-earnings.js';
import { loadReconciledChartReadiness, buildChartNotReadyMessage } from '../services/chart-readiness.js';
import { findChartReadinessOverride, resolveOverrideReason } from '../services/chart-readiness-override.js';
import { readTxtFromS3 as readLetterTxtFromS3, type LetterTxtContext, resolveCurrentRevisionMeta, readPdfBytesWithHash, headObjectExists, resolveViewableCurrentTxtKey } from '../services/letter-current.js';
import { detectLetterLeaks, blockingLeaks } from '../services/letter-leak-detector.js';
import { gradeLetterText, type LetterRegrade } from '../services/letter-grade.js';
import { resolveChangesSinceSigned } from '../services/letter-change-diff.js';
import { parseSignOffCreate } from '../services/sign-off-validation.js';
import {
  parseCredentialBlock,
  substituteSignerSentinels,
  findForeignSignerNames,
  signerNameAppears,
  buildRendererCredentialLines,
} from '../services/credential-block.js';
import type { AppDb } from '../services/db-types.js';

/**
 * In-EMR letter editor backend (cloud). The TXT is the single source of truth and
 * Case.currentVersion is the single pointer to the most recent version — render/GET/save all
 * key off it, so a physician edit can never be shadowed by a stale AI draft (see
 * LETTER_EDITOR_BACKEND_PLAN.md). Every save advances the version + writes a LetterRevision
 * row; the dumb renderer (returnBuffer + skipEnvelopeGate, byte-verbatim) produces the
 * artifacts via the injected render Lambda.
 */

const PRESIGN_TTL_SECONDS = 300;
// Statuses in which the letter may be edited. Outside these (e.g. delivered/paid/rejected)
// the editor is read-only. 'delivered' staying OUT of this set is load-bearing for the ratified
// sign/edit lifecycle (Ryan 2026-06-12): the approved/signed letter is send-only forever — no
// editor path may mutate a delivered case (pinned by the G2 tests in letter-routes.test.ts).
// 'correction_requested' = the physician sent the letter BACK to the RN. The RN must be able to EDIT
// it immediately in the full editor (it is NOT physician-signed, so nothing should bar editing) — not
// just View/Redraft (Ryan 2026-06-20, Apolito). Editing creates a new version; it does not change
// status. (correction_review = the RN actively reworking before sending back to the doctor.)
// 'needs_rn_decision' = a body-quality PARK (a FULL draft was produced but the deterministic body-quality
// gate found a letter-killing defect). Per the 2026-06-22 advisory/editable redesign, that hold is a SOFT
// advisory, not re-draft-only: the RN may open the held letter in the full editor and fix the flagged
// section by hand (cheaper than a ~$15 re-draft). Editing creates a new version; it does NOT change status.
// Load-bearing safety: 'needs_rn_decision' carries a currentVersion only when /halt confirmed a produced
// txt exists in S3 (a dx/event hold leaves currentVersion untouched → GET /letter resolves null → editor
// shows nothing to edit). sign-offs.ts SEPARATELY refuses needs_rn_decision so a held-for-defect letter can
// never be physician-signed while parked. 'needs_records' stays OUT — by definition no draft exists there.
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['drafting', 'rn_review', 'physician_review', 'correction_requested', 'correction_review', 'needs_rn_decision']);

/**
 * G4 — ratified sign/edit lifecycle (Ryan 2026-06-12): "nurse cannot edit the version the doctor
 * signed … they can go in and do a surgical edit, but then if changed that has to go back to
 * doctor to resign before sending."
 *
 * Computed when a save / surgical-apply creates version N+1 over a version N that carries a
 * SignOff (SignOff.signedVersion === N): the prior signature is now STALE — the signed bytes no
 * longer match the current letter. The byte-hash delivery gate (delivery.ts signed_bytes_changed)
 * remains the ULTIMATE enforcement; this makes the re-sign demand proactive at edit time instead
 * of a delivery-time surprise:
 *   - delivered: the case RETURNS to physician_review (legal map transition added for exactly
 *     this) in the same transaction. Defensive today — 'delivered' is NOT in EDITABLE_STATUSES,
 *     so no editor path can currently reach it — but enforced so a future widening of the
 *     editable set can never leave a delivered case sitting on changed bytes.
 *   - every other (editable) status, physician_review above all: the case STAYS put — the doctor
 *     re-signs at approve anyway — but the edit is flagged in the activity log and the response
 *     carries a notice the UI can surface.
 */
export interface StaleSignOffOutcome {
  returnToPhysicianReview: boolean;
  logAction: 'letter_edited_after_signoff' | 'letter_edited_after_signoff_returned_to_physician';
  notice: string;
}
export function staleSignOffOutcome(status: string): StaleSignOffOutcome {
  if (status === 'delivered') {
    return {
      returnToPhysicianReview: true,
      logAction: 'letter_edited_after_signoff_returned_to_physician',
      notice: "This letter was already signed — it has returned to the doctor's queue for re-signature.",
    };
  }
  return {
    returnToPhysicianReview: false,
    logAction: 'letter_edited_after_signoff',
    notice: 'This letter was signed before this edit — the doctor must re-sign before it can be delivered.',
  };
}

export interface RenderInvokeInput {
  caseData: {
    id: string; veteran_name: string; veteran_last: string; claimed_condition: string;
    // D2 signer fields — optional + additive so an older render Lambda ignores them. The
    // credential PROSE is already substituted into letterText; the Lambda needs only the
    // signature PNG key (to composite the image) and the signer name (artifact metadata).
    signer_name?: string;
    signature_image_s3_key?: string;
    // CO-SIGN (DPT docket 2026-07-19) — optional + additive, exactly like the signer fields above.
    // Present ONLY when the assigned signer has a co-signer (coSignedByPhysicianId); the renderer
    // draws a second "Independently reviewed and concurred in by" block. ABSENT for a solo signer
    // (byte-identical single-signer render path — the c0-A regression guard). The co-signer's name
    // appears ONLY in the render signature block, never in the letter body / §I.
    cosigner_name?: string;
    cosigner_signature_image_s3_key?: string;
  };
  letterText: string;
  version: number;
  draft: boolean;
  bucket: string;
  keys: { txtKey: string; pdfKey: string; docxKey: string };
}
export interface RenderInvokeResult {
  ok: boolean;
  version: number;
  keys: { txtKey: string; pdfKey: string; docxKey: string };
  sizes: { txt: number; pdf: number; docx: number };
}
/** Injected so this router has no @aws-sdk/client-lambda dependency at type-check time; the
 *  concrete sync-invoke impl (letter-render-invoke.ts) is wired at mount in server.ts. */
export type RenderInvoker = (input: RenderInvokeInput) => Promise<RenderInvokeResult>;

/** Surgical-AI proposer — the LLM (Opus 4.8) call, injected so it's a deterministic stub in
 *  unit tests (same pattern as renderLetter). It returns a STRUCTURED edit + the metered cost;
 *  the deterministic applyStructuredEdit applies it. The concrete impl (Anthropic SDK + the
 *  bounded-edit prompt) is wired at mount. Cloud meters the key (no free Claude-Max lane). */
// mode distinguishes the two edit tiers that share this proposer (Guided Revision, 2026-06-13):
//   'surgical'         — the narrow tier: ONE bounded {operation, anchor_text, new_text}, "change
//                        ONLY what is asked". `passage` is unused.
//   'guided_revision'  — the broader tier: the physician HIGHLIGHTS a verbatim `passage` of the
//                        current letter and gives an instruction; the model reshapes ONLY that
//                        passage (always operation 'replace', anchor_text === the highlighted
//                        passage). Softer prose rules, HARD structural guards (the route enforces
//                        the §VII holding lock + citation-integrity guard on the result).
// Defaulting to 'surgical' keeps every existing caller byte-identical.
export type ProposeMode = 'surgical' | 'guided_revision';
export interface SurgicalProposeInput {
  instruction: string;
  letterText: string;
  mode?: ProposeMode;
  /** guided_revision only: the verbatim highlighted substring of letterText to reshape. */
  passage?: string;
}
export interface SurgicalProposeOutput { proposal: EditProposal; costUsd: number; model: string; }
export type SurgicalProposer = (input: SurgicalProposeInput) => Promise<SurgicalProposeOutput>;

// Guided-revision robustness (2026-06-24): the proposer (letter-surgical-propose) throws a typed
// ProposerUnavailableError when the LLM call still fails after the SDK's transient retries OR the
// model returns an empty/truncated/malformed structured edit. The router is decoupled from the
// concrete proposer (it's an injected dep), so we DUCK-TYPE the error here rather than import the
// service. This becomes a SPECIFIC 422 ('proposal_unavailable' + sub-detail) so the UI never shows
// the generic "could not be generated" — every failure path gets an actionable reason. The detail
// also carries passageTooLong so the message can accurately say "it may be too long".
type ProposerFailureDetail = 'model_unavailable' | 'passage_too_complex' | 'no_change_proposed';
interface ProposerUnavailableShape { isProposerUnavailable: true; detail: ProposerFailureDetail; passageTooLong?: boolean; }
function asProposerUnavailable(err: unknown): ProposerUnavailableShape | null {
  if (err !== null && typeof err === 'object' && (err as { isProposerUnavailable?: unknown }).isProposerUnavailable === true) {
    const e = err as ProposerUnavailableShape;
    return { isProposerUnavailable: true, detail: e.detail, passageTooLong: e.passageTooLong === true };
  }
  return null;
}
function proposalUnavailableMessage(pu: ProposerUnavailableShape): string {
  if (pu.detail === 'model_unavailable') return 'The AI service was briefly unavailable. Click Propose again in a moment.';
  if (pu.detail === 'passage_too_complex') return 'The AI could not shape a clean edit for this passage, likely because it is too long. Try a smaller selection (up to about two pages), or hand-edit it directly in the letter.';
  return 'The AI did not return an edit for this passage. Try rephrasing the instruction, narrow the selection, or hand-edit it directly in the letter.';
}

// ── Citation Enricher (Feature B, 2026-06-24) injected dependencies ──────────────────────────────
// All three are injected so the router is stub-testable and carries no NCBI/Anthropic dependency at
// type-check time (mirrors proposeSurgicalEdit). The concrete impls (vendored citationFallback + a
// strict-schema Haiku call) are wired at mount in server.ts.
//   - enrichRetrieve: PROPOSE-time grounded NCBI retrieval (several serial round-trips, run async).
//   - enrichVerify:   APPLY-time SERVER-SIDE re-verify of ONE selected PMID (re-fetch + confirm).
//   - extractTerms:   optional claim-sentence → search-terms mapping (strict-schema Haiku, no cite field).
export type EnrichRetriever = (condition: string, mechanismHints?: string[]) => Promise<RetrieveResult>;
export type EnrichVerifier = (pmid: string, condition?: string) => Promise<VerifyResult>;
//   - enrichResolvePmid: DIRECT-PMID PROPOSE — resolve+verify ONE physician-typed PubMed ID against
//     NCBI (no on-topic gate; the physician chose it) into a preview candidate. (2026-07-02.)
export type EnrichPmidResolver = (pmid: string) => Promise<PmidResolveResult>;
export type TermsExtractor = (claim: string) => Promise<ExtractedTerms>;

export interface LetterRouterDeps {
  renderLetter: RenderInvoker;
  proposeSurgicalEdit?: SurgicalProposer;
  enrichRetrieve?: EnrichRetriever;
  enrichVerify?: EnrichVerifier;
  enrichResolvePmid?: EnrichPmidResolver;
  extractTerms?: TermsExtractor;
  s3?: S3Client;
  bucketName?: string;
}

interface CurrentLetter {
  version: number;
  txtKey: string;
  pdfKey: string | null;
  docxKey: string | null;
}

/**
 * Atomic triple-artifact invariant (#9 Fix 4): a LetterRevision MUST point at all three
 * non-null/non-empty artifact keys {txt, pdf, docx}. Throw (502) BEFORE any persist so a partial
 * render can never produce a LetterRevision row that points at a missing artifact. This is a
 * structural belt — the editor paths already build all three keys + render them — but it makes
 * the invariant impossible to regress (e.g. a future caller that forgets one key).
 */
function assertTripleArtifacts(keys: { txtKey?: string | null; pdfKey?: string | null; docxKey?: string | null }, ctx: { caseId: string; version: number }): asserts keys is { txtKey: string; pdfKey: string; docxKey: string } {
  const missing = (['txtKey', 'pdfKey', 'docxKey'] as const).filter((k) => typeof keys[k] !== 'string' || (keys[k] as string).trim() === '');
  if (missing.length > 0) {
    throw new HttpError(502, 'internal_error', 'Refusing to persist a letter revision with a missing artifact key.', { reason: 'partial_artifacts', caseId: ctx.caseId, version: ctx.version, missing });
  }
}

/**
 * Best-effort persistence of the fast probative grade, DECOUPLED from the letter-save transaction
 * (AWS QA 2026-07-08). It must never (a) roll back an already-rendered+saved revision, nor (b) 500
 * the save during the deploy window where the new grade_json column has not been migrated yet — the
 * migrate CodeBuild runs AFTER cdk deploy (ARCHITECTURE §6), so a fresh Lambda can briefly run against
 * a table without the column. Both grade fields move together: LetterRevision.gradeJson (the per-version
 * audit blob) and the display-only Case.grade mirror. ANY failure (P2022 missing column in the window,
 * P2025 row race, transient DB blip) is swallowed with a warning — a missed grade is safe-direction: the
 * displayed grade simply stays at the prior version's, and no gate reads either field (routing = the
 * untouched shipRecommendation). No-op when the grade failed open (regrade === null).
 */
async function persistLetterGrade(db: AppDb, caseId: string, version: number, regrade: LetterRegrade | null): Promise<void> {
  if (regrade === null) return;
  try {
    await db.$transaction(async (tx) => {
      await tx.letterRevision.updateMany({ where: { caseId, version }, data: { gradeJson: JSON.parse(JSON.stringify(regrade)) as object } });
      await tx.case.update({ where: { id: caseId }, data: { grade: regrade.grade } });
    });
  } catch (e: unknown) {
    console.warn(JSON.stringify({ msg: 'letter-grade: best-effort persist failed (save already committed)', caseId, version, error: e instanceof Error ? e.message : String(e) }));
  }
}

export function createLetterRouter(db: AppDb, deps: LetterRouterDeps): Router {
  const router = Router();
  const s3 = (): S3Client => deps.s3 ?? new S3Client({});
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // Resolve the current letter's artifacts STRICTLY by Case.currentVersion (the single source of
  // truth). Prefer the unified LetterRevision row; fall back to the DraftJob row for drafted-but-
  // pre-mirror cases. Both are keyed to the SAME version. This strict form is used by the MUTATING
  // paths (PUT save, surgical-AI apply, approve): they build version currentVersion+1 over the
  // CURRENT version, so they must NEVER silently fall back to an older version (that would break the
  // version chain / re-derive an edit over the wrong base). Read-only resolution uses
  // resolveCurrentForRead below, which can recover a stranded prior letter.
  async function resolveCurrent(caseId: string, currentVersion: number): Promise<CurrentLetter | null> {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) return null;
    const rev = await db.letterRevision.findFirst({ where: { caseId, version: currentVersion } });
    if (rev !== null) {
      return { version: rev.version, txtKey: rev.artifactTxtS3Key, pdfKey: rev.artifactPdfS3Key, docxKey: rev.artifactDocxS3Key };
    }
    const job = await db.draftJob.findFirst({ where: { caseId, version: currentVersion } });
    if (job !== null && typeof job.artifactTxtS3Key === 'string') {
      return { version: job.version, txtKey: job.artifactTxtS3Key, pdfKey: job.artifactPdfS3Key, docxKey: job.artifactDocxS3Key };
    }
    return null;
  }

  // READ-PATH resolution with STRANDED-LETTER RECOVERY (CLM-9925837B7B, 2026-06-23): when
  // currentVersion resolves to a real, S3-present artifact, return it (current behavior). When it
  // does NOT (a failed re-draft advanced currentVersion to a dead version that produced no artifact),
  // fall back to the most-recent PRIOR version whose TXT object actually exists in S3, so the good
  // letter is never stranded behind a failed attempt. Only when NO version anywhere has a present
  // artifact does the caller get a clean 404. We HeadObject-verify the resolved version's TXT so a
  // dangling key (a non-null artifactTxtS3Key whose object was never written) can never be returned.
  async function resolveCurrentForRead(caseId: string, currentVersion: number): Promise<CurrentLetter | null> {
    // Delegate to the SHARED recovery-capable resolver (letter-current.resolveViewableCurrentTxtKey) so
    // the read path, the approve-blocker advisory, the approve route, and the forward re-pin all read ONE
    // existence truth (CLM-8EC828F1D7, 2026-07-01). It resolves the strict pointer first (HeadObject-
    // verified), then the newest prior present TXT across both tables, then the S3-truth fallback —
    // behavior-identical to the prior inline logic for a normal (non-stranded) letter.
    const hit = await resolveViewableCurrentTxtKey(db, s3(), bucket() as string, caseId, currentVersion);
    if (hit !== null) {
      // FAIL-LOUD parity with the prior inline recovery logging: only when we fell off the pointer.
      if (hit.version !== currentVersion) {
        console.warn(`[letter] stranded/s3-truth recovery: case ${caseId} currentVersion=${currentVersion} had no resolvable artifact at the pointer; served letter v${hit.version}`);
      }
      return { version: hit.version, txtKey: hit.txtKey, pdfKey: hit.pdfKey, docxKey: hit.docxKey };
    }
    // Nothing present anywhere: return the STRICT row (if one exists) so the normal read path runs
    // readTxtFromS3 on it and yields the precise "letter_artifact_missing — re-draft" 404 (more helpful
    // than a generic no_letter). If strict is also null, the caller yields the generic 404. Unchanged.
    return resolveCurrent(caseId, currentVersion);
  }

  // MUTATING-PATH resolution with STRANDED-POINTER SELF-HEAL (Puller, CLM-CCFDA1BCC3, 2026-06-25).
  //
  // The mutating edit paths (PUT save, surgical-AI apply, guided-revision propose) used the STRICT
  // `resolveCurrent`, which returns null when Case.currentVersion points at a dead version (a failed
  // re-draft advanced the pointer onto a version with no artifact). That null became a 409 `no_letter`
  // BEFORE any §VII gate / holding-lock / proposer ran — so an edit on a stranded pointer was simply
  // impossible (Puller: 25+ surgical-ai → 409 no_letter). The READ path already recovers (it serves the
  // last good letter), so the editor opens fine but every SAVE/APPLY/PROPOSE 409'd.
  //
  // This mirrors the read path's recovery for the mutating paths: when the strict resolve fails, fall
  // back to the SAME recovery the read path uses (resolveCurrentForRead → resolveLatestResolvableTxt /
  // the S3-truth walk) and report the RECOVERED version as the base to build N+1 over. The caller then
  // builds version (recoveredVersion + 1) with parentVersion = recoveredVersion, and RE-PINS
  // Case.currentVersion to the new version — so the next edit resolves strictly again. A genuinely
  // no-letter case (no resolvable version anywhere) still returns null → the caller 409s `no_letter`.
  //
  // `recovered` is true ONLY when we fell back off a stranded pointer (resolved.version !== currentVersion);
  // the normal (non-stranded) path returns the strict letter with recovered=false and identical semantics.
  interface EditableLetter { letter: CurrentLetter; recovered: boolean; }
  async function resolveCurrentForEdit(caseId: string, currentVersion: number): Promise<EditableLetter | null> {
    const strict = await resolveCurrent(caseId, currentVersion);
    if (strict !== null) {
      // Strict hit. Probe S3 to confirm the TXT object actually exists (a dangling key must not block
      // recovery). TRANSIENT-TOLERANCE (QA SHOULD-FIX, 2026-06-25): headObjectExists RE-THROWS any error
      // that is not NoSuchKey/NotFound, so a transient S3 Throttling/Timeout/5xx during this probe would
      // throw out of the edit handler → 500 on an edit that pre-fix succeeded (the old strict path did NO
      // HeadObject). Wrap the probe: only a DEFINITIVE NotFound (artifact provably absent) drops to
      // recovery; on ANY transient/non-NotFound error TRUST the strict letter and proceed (recovered=false),
      // exactly as the pre-fix strict path did. Net: a healthy edit never 500s on a transient S3 blip; a
      // provably-stranded pointer still recovers below.
      let strictTxtPresent: boolean;
      try {
        strictTxtPresent = await headObjectExists(s3(), bucket() as string, strict.txtKey);
      } catch {
        // Transient/non-NotFound probe failure: do NOT propagate, do NOT trigger recovery — trust strict.
        return { letter: strict, recovered: false };
      }
      if (strictTxtPresent) return { letter: strict, recovered: false };
    }
    // Stranded (or dangling-key) pointer: recover the last good letter exactly as the read path does.
    const recovered = await resolveCurrentForRead(caseId, currentVersion);
    if (recovered === null) return null; // nothing resolvable anywhere → genuine no-letter
    // If recovery landed on the SAME version the strict resolver claimed (a pure dangling-key edge), it is
    // not a re-pin; treat as non-recovered so the version chain is unchanged. Otherwise it IS a stranded
    // recovery: the caller rebases onto `recovered.version` and re-pins currentVersion.
    const isRecovery = recovered.version !== currentVersion;
    // OBSERVABILITY (QA NIT, 2026-06-25): mirror the read path's stranded-recovery log so a live self-heal
    // on the MUTATING path is visible too. Best-effort — an activityLog write must never block the edit.
    if (isRecovery) {
      console.warn(`[letter] stranded-recovery (edit): case ${caseId} currentVersion=${currentVersion} had no resolvable artifact; rebasing edit onto prior good letter v${recovered.version}`);
      try {
        await db.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.DRAFTER,
            caseId,
            action: 'letter_stranded_recovery',
            detailsJson: { strandedCurrentVersion: currentVersion, recoveredVersion: recovered.version, path: 'edit' },
          },
        });
      } catch (e: unknown) {
        console.warn(`[letter] stranded-recovery breadcrumb write failed for case ${caseId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { letter: recovered, recovered: isRecovery };
  }

  async function enforcePhysicianAssignment(caseId: string, role: string, sub: string, assignedPhysicianId: string | null): Promise<void> {
    if (role === 'physician' && !(await isAssignedPhysicianForCase(db, sub, assignedPhysicianId))) {
      throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
    }
  }

  // Delegates to the shared service reader so an S3 NoSuchKey surfaces as a structured 404
  // ("Letter artifact missing from storage for v<N>…") instead of an unhandled 500 (CLM-BBFCB3F8CE).
  async function readTxtFromS3(bucketName: string, key: string, ctx?: LetterTxtContext): Promise<string> {
    return readLetterTxtFromS3(s3(), bucketName, key, ctx);
  }

  // ── GET — "what changed since the physician last signed" diff (Ryan 2026-07-03) ─────────────
  // Deterministic sentence-level diff between the last-signed version and the current version, so the
  // physician re-signing an RN-corrected letter can GLANCE at the change instead of re-reading. It is an
  // AID, never a gate (the delivery byte-hash gate is the real re-sign enforcement), so it FAILS OPEN:
  // no bucket, no prior signature, or any read error → { available: false } and the UI omits the panel.
  router.get(
    '/cases/:id/letter/changes-since-signed',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);

      const bucketName = bucket();
      if (bucketName === undefined) {
        res.json({ data: { available: false, reason: 'not_configured' } });
        return;
      }
      const changes = await resolveChangesSinceSigned(db, s3(), bucketName, caseId, c.currentVersion);
      res.json({ data: changes });
    }),
  );

  // ── GET — load the current letter for the editor ──────────────────────────
  router.get(
    '/cases/:id/letter',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });

      // READ-PATH resolution with stranded-letter recovery (CLM-9925837B7B): when currentVersion
      // resolves to a real S3-present artifact, that wins; otherwise fall back to the latest prior
      // version that actually has a letter, so a failed re-draft never strands a good letter behind
      // a 404. Only a case with NO present artifact at ANY version 404s.
      const cur = await resolveCurrentForRead(caseId, c.currentVersion);
      if (cur === null) {
        // FAIL-LOUD (CLM-A158C00C07, Michael Dick 2026-06-29): a GET /letter that resolves NOTHING used
        // to 404 SILENTLY, so a UI that offered "View PDF / Open editor" off a halted-job STATE (with no
        // artifact) dead-ended invisibly — the false-affordance bug was un-observable in CloudWatch. Log
        // the no-artifact read so a missing-letter GET is greppable (no_artifact{caseId,currentVersion}).
        // The frontend resolveViewableLetterJob now suppresses the affordance; this is the backstop alarm
        // for any path that still requests a letter that does not exist.
        console.warn(`[letter] no_artifact caseId=${caseId} currentVersion=${c.currentVersion} — GET /letter resolved no letter (no resolvable artifact at the pointer or anywhere in S3)`);
        throw new HttpError(404, 'not_found', 'No letter has been drafted for this case yet.', { reason: 'no_letter', caseId });
      }
      // FAIL-LOUD (CLM-9925837B7B, 2026-06-23): a failed re-draft advanced Case.currentVersion onto a
      // dead (artifact-less) version, stranding the prior good letter behind a 404. The read-path resolver
      // recovered it; log loudly so we can see how often this happens and back it out at the drafter source
      // (the failure /complete path advancing currentVersion with no HeadObject guard — worklist #82).
      if (cur.version !== c.currentVersion) {
        console.warn(`[letter] stranded-recovery: case ${caseId} currentVersion=${c.currentVersion} had no resolvable artifact; served prior good letter v${cur.version}`);
      }

      const txt = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });
      const client = s3();
      // Canonical download name (Ryan 2026-06-18): Ewell_S_OSA_v7.pdf, set via ResponseContentDisposition
      // so a saved letter isn't a bare "letter.pdf". The S3 KEY is unchanged — only the served name.
      // PDF stays `inline` (the "Open PDF" button views it in-browser; it saves under this name); the
      // DOCX is an `attachment` (a download). Filename is RFC-quoted-string-safe (helper strips punctuation).
      // Separate veteran lookup (the db wrapper's CaseRecord type doesn't carry the relation); fail-open
      // to the helper's 'Veteran' default if the row is somehow absent.
      const vet = (await db.veteran.findFirst({
        where: { id: c.veteranId },
        select: { firstName: true, lastName: true },
      })) as { firstName: string | null; lastName: string | null } | null;
      // Filename CONDITION from the route-picker plan (the letter's actual theory), not the broad
      // intake claim bucket (one-brain #72/#89; an "acne"-theory letter must not download as "…_Skin…").
      // $0 read-only; fail-open to claimedCondition. (Dr. Kasky 2026-06-26.)
      let fileCondition = c.claimedCondition;
      try {
        const ai = await getAiViabilityState(db, caseId, { compute: false });
        if (ai.status === 'ready' && typeof ai.card.lead.claimed === 'string' && ai.card.lead.claimed.trim().length > 0) {
          fileCondition = ai.card.lead.claimed.trim();
        }
      } catch { /* fall back to claimedCondition */ }
      const baseName = letterFilename(vet?.lastName, vet?.firstName, fileCondition, cur.version);
      const pdfUrl = cur.pdfKey !== null
        ? await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName, Key: cur.pdfKey, ResponseContentDisposition: `inline; filename="${baseName}.pdf"` }), { expiresIn: PRESIGN_TTL_SECONDS })
        : null;
      const docxUrl = cur.docxKey !== null
        ? await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName, Key: cur.docxKey, ResponseContentDisposition: `attachment; filename="${baseName}.docx"` }), { expiresIn: PRESIGN_TTL_SECONDS })
        : null;

      // source drives the editor's finalize affordance (import deliver-as-is, 2026-06-14): an
      // 'external_import' current revision shows "Finalize for delivery (as-is)" (no re-render),
      // never the normal Approve (which re-renders). Resolved from the LetterRevision row only — a
      // plain DraftJob has no source (null → the normal rendered-letter lifecycle).
      const meta = await resolveCurrentRevisionMeta(db, caseId, c.currentVersion);

      res.json({
        data: {
          version: cur.version,
          txt,
          locked_ranges: computeLockedRanges(txt),
          rendered: { pdfUrl, docxUrl },
          role: user.role,
          source: meta?.source ?? null,
          // Loud warning whenever the letter is opened: forbidden content (editing meta-commentary,
          // PMIDs) that blocks delivery and needs a re-draft (Ryan 2026-06-20). Empty = clean.
          leaks: detectLetterLeaks(txt).map((l) => ({ code: l.code, note: l.note, match: l.match })),
        },
      });
    }),
  );

  // ── PUT — save edited full text as a new version ──────────────────────────
  router.put(
    '/cases/:id/letter',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const body = (req.body ?? {}) as { base_version?: unknown; txt?: unknown };
      const baseVersion = Number(body.base_version);
      if (!Number.isInteger(baseVersion)) throw new HttpError(400, 'bad_request', 'base_version (integer) is required', { caseId });
      if (typeof body.txt !== 'string' || body.txt.trim() === '') throw new HttpError(400, 'bad_request', 'txt (non-empty string) is required', { caseId });

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);
      if (!EDITABLE_STATUSES.has(c.status)) throw new HttpError(409, 'conflict', `Letter is not editable in status '${c.status}'.`, { reason: 'not_editable', caseId, status: c.status });
      // RN lock during physician review (Ryan 2026-06-11 — REVERSES the 2026-06-04 "RNs can
      // edit before the doc reads it" decision): while the case sits in the doctor's queue,
      // ops_staff cannot mutate the letter. Physician + admin retain their tools.
      if (user.role === 'ops_staff' && c.status === 'physician_review') {
        throw new HttpError(409, 'conflict', 'Letter is locked while in physician review.', { reason: 'locked_physician_review', caseId });
      }
      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      // STRANDED-POINTER SELF-HEAL (Puller, CLM-CCFDA1BCC3): resolve the editable letter, recovering the
      // last good version when Case.currentVersion points at a dead version. `editable.letter.version` is
      // the REAL base we build N+1 over (= currentVersion in the normal case; the recovered version when
      // stranded). A genuine no-letter case → null → 409 no_letter (unchanged).
      const editable = await resolveCurrentForEdit(caseId, c.currentVersion);
      if (editable === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });
      const cur = editable.letter;
      const baseLetterVersion = cur.version;
      // Optimistic concurrency: the editor must be saving against the version it LOADED. The read path
      // serves the recovered version on a stranded pointer, so accept base_version === the resolved base
      // (recovered or strict), not only Case.currentVersion (which is the stale/dead pointer when stranded).
      if (baseVersion !== c.currentVersion && baseVersion !== baseLetterVersion) {
        throw new HttpError(409, 'conflict', `base_version ${baseVersion} is stale; current is v${baseLetterVersion}. Reload and reapply your edits.`, { reason: 'stale_version', caseId, currentVersion: baseLetterVersion });
      }

      const oldText = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });
      const cleaned = cleanProseForSave(body.txt);
      // PHYSICIAN-ONLY §VII GATE (Puller, 2026-06-24): the Section VII medical opinion is the
      // physician's own legal determination — an RN (ops_staff) must not edit it through ANY door.
      // Only fires when §VII ACTUALLY changed, so an RN editing §I/§III/etc. still saves freely.
      // In addition to (not replacing) the existing ops_staff && physician_review lock above.
      if (sectionViiChanged(oldText, cleaned) && user.role !== 'physician' && user.role !== 'admin') {
        throw new HttpError(403, 'forbidden', 'Section VII (the medical opinion) can only be edited by a physician. If edits are required, please pass them in a message when submitting for review.', { reason: 'section_vii_physician_only', caseId });
      }
      const warnings: SanityFinding[] = sanityCheckLetterText(oldText, cleaned);

      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });

      // G4: does a SignOff bind to the version we are about to edit over? (signedVersion is null
      // on legacy sign-offs predating byte-binding — those carry no hash, nothing goes stale.)
      // Keyed on the REAL base we built over (baseLetterVersion), not the stale/dead pointer.
      const staleSignOff = (await db.signOff.findFirst({ where: { caseId, signedVersion: baseLetterVersion } })) ?? null;
      const stale = staleSignOff !== null ? staleSignOffOutcome(c.status) : null;

      const newVersion = baseLetterVersion + 1;
      const keys = {
        txtKey: buildLetterRevisionKey(caseId, newVersion, 'txt'),
        pdfKey: buildLetterRevisionKey(caseId, newVersion, 'pdf'),
        docxKey: buildLetterRevisionKey(caseId, newVersion, 'docx'),
      };
      const caseData = {
        id: caseId,
        veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(),
        veteran_last: veteran.lastName,
        claimed_condition: c.claimedCondition,
      };

      // Render FIRST (writes all three artifacts to S3 via the render Lambda). Only persist
      // the revision if render succeeds, so a LetterRevision row never points at missing S3.
      const rendered = await deps.renderLetter({ caseData, letterText: cleaned, version: newVersion, draft: true, bucket: bucketName, keys });
      if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Letter render failed; nothing saved.', { reason: 'render_failed', caseId, version: newVersion });
      // Atomic triple-artifact invariant (#9 Fix 4): never persist a revision missing an artifact key.
      assertTripleArtifacts(keys, { caseId, version: newVersion });

      // Auto-grade the saved edit (Ryan 2026-07-08): a fast Sonnet probative re-grade earmarked to THIS
      // version so the listed grade reflects the edits. SYNCHRONOUS but FAIL-OPEN — a null grade (LLM
      // error/timeout/too-short) NEVER blocks the save. Runs on the CLEANED text that is actually stored.
      // Persistence is DECOUPLED from the save txn below (see the best-effort block after it).
      const regrade = await gradeLetterText({ letterText: cleaned, claimedCondition: c.claimedCondition });

      try {
        await db.$transaction(async (tx) => {
          await tx.letterRevision.create({
            data: {
              caseId,
              version: newVersion,
              parentVersion: baseLetterVersion,
              source: 'editor_save',
              artifactTxtS3Key: keys.txtKey,
              artifactPdfS3Key: keys.pdfKey,
              artifactDocxS3Key: keys.docxKey,
              editedBy: user.sub,
              editorRole: user.role,
              sanityJson: warnings,
            },
          });
          // G4: a stale-signature edit on a delivered case returns it to the doctor's queue in
          // the SAME transaction (delivered → physician_review is legal in CASE_STATUS_TRANSITIONS).
          // NOTE: the probative grade (Case.grade + LetterRevision.gradeJson) is written OUTSIDE this
          // transaction, best-effort — see below. It must never be able to roll back a saved revision.
          await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 }, ...(stale?.returnToPhysicianReview ? { status: 'physician_review' } : {}) } });
          await tx.activityLog.create({
            data: {
              actorUserId: user.sub,
              action: 'letter_saved',
              caseId,
              veteranId: c.veteranId,
              detailsJson: { version: newVersion, source: 'editor_save', warnings: warnings.map((w) => w.rule) },
            },
          });
          if (stale !== null) {
            await tx.activityLog.create({
              data: {
                actorUserId: user.sub,
                action: stale.logAction,
                caseId,
                veteranId: c.veteranId,
                detailsJson: { staleSignedVersion: baseLetterVersion, newVersion, fromStatus: c.status, source: 'editor_save' },
              },
            });
          }
        });
      } catch (e: unknown) {
        // P2002 on letter_revisions_case_version_uq → a concurrent save advanced the version.
        if ((e as { code?: string }).code === 'P2002') {
          throw new HttpError(409, 'conflict', 'Another save advanced the version; reload and reapply.', { reason: 'concurrent_save', caseId });
        }
        throw e;
      }

      // Persist the probative grade OUTSIDE the save transaction, best-effort (AWS QA 2026-07-08).
      // TWO reasons it must not sit inside the txn above: (1) a grade write must NEVER be able to roll
      // back an already-rendered+saved revision; (2) gradeJson is a NEW column and the migrate CodeBuild
      // runs AFTER cdk deploy (ARCHITECTURE §6) — during that brief window a P2022 "column does not exist"
      // must be swallowed here, not 500 the save. gradeJson has no hard reader and Case.grade is
      // display-only (routing gate = shipRecommendation, untouched), so a missed grade is safe-direction
      // (the displayed grade simply stays at the prior version's). Both grade fields move together.
      await persistLetterGrade(db, caseId, newVersion, regrade);

      // Return the canonical saved text — cleanProseForSave may have altered it (em dashes →
      // commas, smart quotes, etc.), so the editor must re-sync to what was actually stored.
      // notice (G4): non-null when this save went over a signed version — the UI surfaces it so
      // the editor learns at save time (not delivery time) that the doctor must re-sign.
      res.json({ data: { version: newVersion, txt: cleaned, rendered: { pdf: rendered.ok, docx: rendered.ok }, warnings, notice: stale?.notice ?? null, grade: regrade ?? null } });
    }),
  );

  // ── POST surgical-ai — bounded LLM edit (propose, or apply a proposal) ──
  // Body: { instruction } to PROPOSE (returns proposal + preview + metered cost, no save), or
  // { apply: true, proposal } to APPLY a previewed proposal via the save path. The LLM only
  // runs on PROPOSE; APPLY is deterministic (applyStructuredEdit re-validates against the
  // current text). Cost is logged at propose time (the spend happens there).
  // ops_staff (RN) has full editor parity with the physician here (Ryan 2026-06-04: "clicking
  // edit letter should be just like what the doctor can do ... AI surgical edits"). The handler
  // is role-safe for RNs: enforcePhysicianAssignment only restricts role==='physician', and the
  // revision records editorRole=user.role so the audit trail shows who actually edited.
  router.post(
    '/cases/:id/letter/surgical-ai',
    requireRole(['admin', 'physician', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const body = (req.body ?? {}) as { instruction?: unknown; apply?: unknown; proposal?: EditProposal; mode?: unknown; passage?: unknown; confirmAddedCitations?: unknown };
      const isGuided = body.mode === 'guided_revision';

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);
      if (!EDITABLE_STATUSES.has(c.status)) throw new HttpError(409, 'conflict', `Letter is not editable in status '${c.status}'.`, { reason: 'not_editable', caseId, status: c.status });
      // RN lock during physician review — the surgical-AI path must match the hand-edit PUT,
      // or the lock leaks through the AI door (architect plan-gate, Ryan 2026-06-11).
      if (user.role === 'ops_staff' && c.status === 'physician_review') {
        throw new HttpError(409, 'conflict', 'Letter is locked while in physician review.', { reason: 'locked_physician_review', caseId });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      // STRANDED-POINTER SELF-HEAL (Puller, CLM-CCFDA1BCC3): same recovery as PUT save. The surgical-AI
      // door (APPLY + guided-revision PROPOSE) was the LIVE failure surface — 25+ surgical-ai → 409
      // no_letter on Puller's stranded v39 pointer. Resolve the editable letter (recovering the last good
      // version when stranded); `baseLetterVersion` is the real base APPLY builds N+1 over and re-pins.
      const editable = await resolveCurrentForEdit(caseId, c.currentVersion);
      if (editable === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });
      const cur = editable.letter;
      const baseLetterVersion = cur.version;
      const oldText = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });

      // ── APPLY a previewed proposal (deterministic, no LLM) ──
      if (body.apply === true) {
        if (body.proposal === undefined) throw new HttpError(400, 'bad_request', 'apply:true requires proposal', { caseId });
        const applied = applyStructuredEdit(oldText, body.proposal);
        if (!applied.ok) throw new HttpError(422, 'conflict', `surgical edit no longer applies: ${applied.error}`, { reason: 'edit_unappliable', caseId });
        // §VII HOLDING-CONCLUSION LOCK at APPLY (NARROWED — Puller, 2026-06-24): the probability
        // conclusion ("more likely than not (>50%)") can never weaken/vanish through ANY structured-
        // edit door, even a hand-crafted apply payload that bypassed propose. The CAUSAL THEORY wording
        // (caused by <-> aggravated by) MAY change — only the >50% holding is locked. Cheap re-check.
        if (holdingConclusionWeakened(oldText, applied.newText)) {
          throw new HttpError(422, 'conflict', "This edit would weaken or remove the 'more likely than not (>50%)' opinion, which is locked. You may change the causal theory wording, but the >50% conclusion must remain.", { reason: 'holding_changed', caseId });
        }
        // PHYSICIAN-ONLY §VII GATE (Puller, 2026-06-24): an RN (ops_staff) may not change Section VII
        // through the surgical-AI door either. Only fires when §VII actually changed.
        if (sectionViiChanged(oldText, applied.newText) && user.role !== 'physician' && user.role !== 'admin') {
          throw new HttpError(403, 'forbidden', 'Section VII (the medical opinion) can only be edited by a physician. If edits are required, please pass them in a message when submitting for review.', { reason: 'section_vii_physician_only', caseId });
        }
        const warnings: SanityFinding[] = sanityCheckLetterText(oldText, applied.newText);
        const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
        if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });
        // G4: same stale-signature detection as the PUT save — the surgical-AI door must not be
        // a way around the re-sign rule (the edit still creates version N+1 over signed version N).
        const staleSignOff = (await db.signOff.findFirst({ where: { caseId, signedVersion: baseLetterVersion } })) ?? null;
        const stale = staleSignOff !== null ? staleSignOffOutcome(c.status) : null;
        const newVersion = baseLetterVersion + 1;
        const keys = {
          txtKey: buildLetterRevisionKey(caseId, newVersion, 'txt'),
          pdfKey: buildLetterRevisionKey(caseId, newVersion, 'pdf'),
          docxKey: buildLetterRevisionKey(caseId, newVersion, 'docx'),
        };
        const caseData = { id: caseId, veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(), veteran_last: veteran.lastName, claimed_condition: c.claimedCondition };
        const rendered = await deps.renderLetter({ caseData, letterText: applied.newText, version: newVersion, draft: true, bucket: bucketName, keys });
        if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Render failed; nothing saved.', { reason: 'render_failed', caseId });
        // Atomic triple-artifact invariant (#9 Fix 4).
        assertTripleArtifacts(keys, { caseId, version: newVersion });
        // Auto-grade the surgical edit (Ryan 2026-07-08): fast Sonnet re-grade earmarked to this version.
        // SYNCHRONOUS + FAIL-OPEN — a null grade never blocks the apply. Persistence is DECOUPLED from the
        // save txn below (best-effort block after it), same as the PUT-save path.
        const regrade = await gradeLetterText({ letterText: applied.newText, claimedCondition: c.claimedCondition });
        try {
          await db.$transaction(async (tx) => {
            await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: baseLetterVersion, source: 'surgical_ai', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: warnings } });
            // G4: stale-signature edit on a delivered case returns it to physician_review in-transaction.
            // currentVersion: newVersion re-pins the pointer (heals a stranded pointer when we recovered).
            // NOTE: the probative grade (Case.grade + gradeJson) is written OUTSIDE this txn, best-effort — see below.
            await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 }, ...(stale?.returnToPhysicianReview ? { status: 'physician_review' } : {}) } });
            await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_surgical_ai_applied', caseId, veteranId: c.veteranId, detailsJson: { version: newVersion, anchor_fallback: applied.anchor_fallback, warnings: warnings.map((w) => w.rule) } } });
            if (stale !== null) {
              await tx.activityLog.create({ data: { actorUserId: user.sub, action: stale.logAction, caseId, veteranId: c.veteranId, detailsJson: { staleSignedVersion: baseLetterVersion, newVersion, fromStatus: c.status, source: 'surgical_ai' } } });
            }
          });
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another save advanced the version; reload and re-propose.', { reason: 'concurrent_save', caseId });
          throw e;
        }
        // Best-effort grade persistence, decoupled from the save txn (see the PUT-save path for the full why).
        await persistLetterGrade(db, caseId, newVersion, regrade);
        res.json({ data: { version: newVersion, txt: applied.newText, warnings, notice: stale?.notice ?? null, grade: regrade ?? null } });
        return;
      }

      // ── GUIDED REVISION PROPOSE (Guided Revision, 2026-06-13) ─────────────────────────────────
      // The broader edit tier: the physician highlights a verbatim passage + gives an instruction;
      // Opus reshapes ONLY that passage (softer prose, HARD structural guards). Propose-only — never
      // auto-applies. Behind GUIDED_REVISION_ENABLED (default off). Role: the requireRole +
      // physician-assignment + RN-lock gates above already apply (shared with surgical).
      if (isGuided) {
        if (process.env.GUIDED_REVISION_ENABLED !== 'true') {
          throw new HttpError(503, 'internal_error', 'Guided revision is not enabled.', { reason: 'guided_revision_disabled', caseId });
        }
        if (deps.proposeSurgicalEdit === undefined) throw new HttpError(503, 'internal_error', 'Surgical-AI is not configured (no proposer wired).', { reason: 'surgical_ai_not_configured', caseId });
        if (typeof body.instruction !== 'string' || body.instruction.trim() === '') throw new HttpError(400, 'bad_request', 'instruction (non-empty string) is required to propose', { caseId });
        if (typeof body.passage !== 'string' || body.passage.trim() === '') throw new HttpError(400, 'bad_request', 'passage (the highlighted text, non-empty) is required for guided revision', { caseId, reason: 'passage_required' });
        const passage = body.passage;
        // The highlighted passage MUST be a verbatim substring of the current letter — otherwise the
        // edit anchor cannot be the highlight and "edit only within the passage" is unenforceable.
        if (!oldText.includes(passage)) {
          throw new HttpError(422, 'conflict', 'The highlighted passage was not found verbatim in the current letter. Reload the letter and re-highlight.', { reason: 'passage_not_found', caseId });
        }

        let out: SurgicalProposeOutput;
        try {
          out = await deps.proposeSurgicalEdit({ instruction: body.instruction, letterText: oldText, mode: 'guided_revision', passage });
        } catch (err: unknown) {
          const pu = asProposerUnavailable(err);
          if (pu === null) throw err;
          // SPECIFIC, actionable 422 instead of the generic could-not-be-generated. The frontend
          // maps detail -> the right message (retry-now vs too-complex vs no-change).
          throw new HttpError(422, 'conflict', proposalUnavailableMessage(pu), { reason: 'proposal_unavailable', detail: pu.detail, passageTooLong: pu.passageTooLong === true, caseId });
        }
        // The proposer pins anchor_text=passage + operation=replace; dry-run so we preview a
        // deterministically-appliable edit and so all downstream guards see the EXACT revised letter.
        const dry = applyStructuredEdit(oldText, out.proposal);

        // CITATION-INTEGRITY GUARD (the key new safety): diff the cited facts of the highlighted
        // passage (before) vs the model's revised passage (after = out.proposal.new_text). A NET-NEW
        // citation/stat => REJECT (the model invented a fact to prop up a reworded argument). A
        // DROPPED citation/stat => return WITH a warning the physician must see before accepting.
        //
        // CROSS-REFERENCE ALLOWANCE (Spring, 2026-06-25): a PMID that is NEW to the highlighted
        // PASSAGE but ALREADY PRESENT ELSEWHERE in the current letter (typically a numbered §VIII
        // reference the physician just added via the Citation Enricher) is a LEGITIMATE internal
        // cross-reference, NOT a fabrication — "use one of our new §VIII citations as a reference for
        // this passage" must be allowed. We build the allowed-PMID set from EVERY PMID already in the
        // full current letter (oldText) and pass it to diffCitationsSanctioned so those PMIDs are not
        // flagged as net-new. The real fabrication guard is UNCHANGED: a PMID that appears NOWHERE in
        // the letter is still rejected, and any net-new author-year or statistic still rejects (the
        // sanctioned set only ever whitelists PMID tokens already in the letter).
        const letterPmids = [...extractCitationTokenMap(oldText).values()]
          .filter((t) => t.kind === 'pmid')
          .map((t) => t.key.replace(/^pmid:/, ''));
        const citationDiff: CitationDiff = diffCitationsSanctioned(passage, out.proposal.new_text, letterPmids);

        // §VII HOLDING-CONCLUSION LOCK (NARROWED — Puller, 2026-06-24): even if the highlighted
        // passage overlaps Section VII, the PROBABILITY conclusion ("more likely than not (>50%)")
        // can NEVER weaken or vanish. The CAUSAL THEORY wording (caused by <-> aggravated by) MAY
        // change. Computed on the would-be letter.
        const holdingWouldChange = dry.ok ? holdingConclusionWeakened(oldText, dry.newText) : false;
        // PHYSICIAN-ONLY §VII GATE (Puller, 2026-06-24): an RN (ops_staff) must not be able to even
        // PROPOSE a §VII change. Block here before returning the proposal (no write happens, but the
        // RN cannot generate a §VII edit). Only fires when §VII actually changed.
        const sectionViiWouldChange = dry.ok ? sectionViiChanged(oldText, dry.newText) : false;

        // Log the propose (cost recorded here — the spend happens at propose, like surgical).
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_guided_revision_proposed', caseId, veteranId: c.veteranId, detailsJson: { instruction: body.instruction.slice(0, 500), model: out.model, costUsd: out.costUsd, appliable: dry.ok, addedCitations: citationDiff.added.length, removedCitations: citationDiff.removed.length, holdingWouldChange } } });

        // PHYSICIAN-ONLY §VII GATE (Puller, 2026-06-24): an RN (ops_staff) cannot even GENERATE a §VII
        // change through guided revision. Block the proposal before any other handling.
        if (sectionViiWouldChange && user.role !== 'physician' && user.role !== 'admin') {
          throw new HttpError(403, 'forbidden', 'Section VII (the medical opinion) can only be edited by a physician. If edits are required, please pass them in a message when submitting for review.', { reason: 'section_vii_physician_only', caseId });
        }

        // REJECTIONS (medico-legal, bias to BLOCK) — never return an applyable proposal:
        //  1) the model invented a citation/stat;
        //  2) the revision would weaken/remove the §VII >50% holding conclusion;
        //  3) the edit does not deterministically apply.
        if (citationDiff.added.length > 0) {
          // PHYSICIAN-ATTESTATION OVERRIDE (Ryan 2026-07-18): the DEFAULT is still to BLOCK a net-new
          // citation/statistic (anti-fabrication — the LLM must never smuggle one in). But the SIGNING
          // PHYSICIAN may have verified that a citation/stat is accurate and supports the passage and
          // want to add it deliberately. So a physician/admin who passes confirmAddedCitations:true is
          // allowed through; an RN (ops_staff) cannot attest (mirrors the §VII + Citation-Enricher
          // physician-only rule). Nothing is written here (propose-only) — the added tokens are surfaced
          // to the physician as a WARNING on the preview, and the attestation is AUDITED for the record.
          const isPhysician = user.role === 'physician' || user.role === 'admin';
          const physicianConfirmed = body.confirmAddedCitations === true && isPhysician;
          if (!physicianConfirmed) {
            // physicianOverridable is role-derived so an RN never sees an override button that can't work.
            res.status(422).json({ error: { code: 'conflict', message: `Guided revision rejected: the revised passage introduces ${citationDiff.added.length} citation/statistic not present in the original (${citationDiff.added.map(describeToken).join(', ')}). A revision may reword prose around the cited facts but must never add a new citation or statistic.${isPhysician ? ' A physician may confirm and add a statistic or author-year deliberately.' : ''}`, details: { reason: 'citation_invented', caseId, proposal: out.proposal, citationDiff, costUsd: out.costUsd, physicianOverridable: isPhysician } } });
            return;
          }
          // HARDENING (QA anthropic-ai-sme 2026-07-18): a physician can attest a STATISTIC or AUTHOR-YEAR
          // by eye (they hold the source). A net-new PMID is different in kind — an LLM can fabricate a
          // syntactically valid PMID that resolves to nothing or to an unrelated paper, which no human
          // can catch by inspection; only NCBI can. So even under a physician override, a net-new PMID is
          // NOT allowed through this door: the physician adds a verified PMID via the Citation Enricher
          // (which re-verifies it against PubMed). Attestation covers stats + author-year; existence of a
          // PMID is a machine check. This keeps the override from becoming a weaker door than the enricher.
          const addedPmids = citationDiff.added.filter((t) => typeof t.key === 'string' && t.key.startsWith('pmid:'));
          if (addedPmids.length > 0) {
            res.status(422).json({ error: { code: 'conflict', message: `A physician may confirm and add a statistic or author-year, but a net-new PMID (${addedPmids.map(describeToken).join(', ')}) must be added through the Citation Enricher, which verifies it against PubMed. Reword to cite an existing reference, or add the PMID via the enricher.`, details: { reason: 'citation_pmid_needs_enricher', caseId, addedPmids: addedPmids.map((t) => t.key), costUsd: out.costUsd } } });
            return;
          }
          await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_guided_revision_citation_override', caseId, veteranId: c.veteranId, detailsJson: { addedCitations: citationDiff.added.map(describeToken), instruction: body.instruction.slice(0, 500) } } });
          // fall through — the added citation(s) are surfaced as a warning below; the physician still
          // reviews the preview and saves through the editor (the PUT save carries no citation block).
        }
        if (holdingWouldChange) {
          res.status(422).json({ error: { code: 'conflict', message: "This edit would weaken or remove the 'more likely than not (>50%)' opinion, which is locked. You may change the causal theory wording, but the >50% conclusion must remain.", details: { reason: 'holding_changed', caseId, proposal: out.proposal, costUsd: out.costUsd } } });
          return;
        }
        if (!dry.ok) {
          res.status(422).json({ error: { code: 'conflict', message: `Guided revision proposal does not apply: ${dry.error}`, details: { reason: 'edit_unappliable', caseId, proposal: out.proposal, costUsd: out.costUsd } } });
          return;
        }

        // ACCEPTED (with possible WARNINGS the physician must see before accepting):
        //  - dropped citation/stat (legitimate when de-emphasizing a marginal theory, but the
        //    physician decides);
        //  - letter-sanity findings on the would-be revised letter.
        const warnings: string[] = [];
        if (citationDiff.added.length > 0) {
          // Only reachable when a physician confirmed the override above (else it 422'd). Surface it.
          warnings.push(`You confirmed adding ${citationDiff.added.length} citation/statistic not in the original (${citationDiff.added.map(describeToken).join(', ')}). As the signing physician you have attested it is accurate and supports the passage.`);
        }
        if (citationDiff.removed.length > 0) {
          warnings.push(`This revision removes ${citationDiff.removed.length} citation/statistic from the passage (${citationDiff.removed.map(describeToken).join(', ')}). Confirm this is intended before accepting.`);
        }
        const sanity = sanityCheckLetterText(oldText, dry.newText);
        res.json({ data: { mode: 'guided_revision', proposal: out.proposal, preview: dry.newText, warnings, sanity, citationDiff, costUsd: out.costUsd, model: out.model } });
        return;
      }

      // ── PROPOSE (LLM runs here; metered) ──
      if (typeof body.instruction !== 'string' || body.instruction.trim() === '') throw new HttpError(400, 'bad_request', 'instruction (non-empty string) is required to propose', { caseId });
      if (deps.proposeSurgicalEdit === undefined) throw new HttpError(503, 'internal_error', 'Surgical-AI is not configured (no proposer wired).', { reason: 'surgical_ai_not_configured', caseId });
      let out: SurgicalProposeOutput;
      try {
        out = await deps.proposeSurgicalEdit({ instruction: body.instruction, letterText: oldText });
      } catch (err: unknown) {
        const pu = asProposerUnavailable(err);
        if (pu === null) throw err;
        throw new HttpError(422, 'conflict', proposalUnavailableMessage(pu), { reason: 'proposal_unavailable', detail: pu.detail, passageTooLong: pu.passageTooLong === true, caseId });
      }
      // Dry-run the proposal so the physician previews a deterministically-appliable edit.
      const dry = applyStructuredEdit(oldText, out.proposal);
      await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_surgical_ai_proposed', caseId, veteranId: c.veteranId, detailsJson: { instruction: body.instruction.slice(0, 500), model: out.model, costUsd: out.costUsd, appliable: dry.ok } } });
      if (!dry.ok) {
        res.status(422).json({ error: { code: 'conflict', message: `proposed edit does not apply: ${dry.error}`, details: { reason: 'edit_unappliable', proposal: out.proposal, costUsd: out.costUsd } } });
        return;
      }
      res.json({ data: { proposal: out.proposal, preview: dry.newText, warnings: sanityCheckLetterText(oldText, dry.newText), costUsd: out.costUsd, model: out.model } });
    }),
  );

  // ── POST approve — physician finalize: chart-readiness + version-match + final render ──
  router.post(
    '/cases/:id/letter/approve',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // Physician must be the assigned physician (admin may act). Resolve identity.
      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null || c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
      }
      // IMPORTED-LETTER GUARD (import deliver-as-is, 2026-06-14): approve RE-RENDERS the FINAL letter
      // from the TXT. An externally-imported letter (LetterRevision source='external_import') has only
      // a PLACEHOLDER txt sidecar — re-rendering it would MANGLE the specially-formatted/externally-
      // signed PDF the operator imported. Refuse here (clear 409 → the finalize-as-is action) so nobody
      // can accidentally re-render an imported letter. This closes the placeholder-txt footgun.
      const approveMeta = await resolveCurrentRevisionMeta(db, caseId, c.currentVersion);
      if (approveMeta !== null && approveMeta.source === 'external_import') {
        throw new HttpError(409, 'conflict', 'This is an imported letter — approving would re-render and mangle the original PDF. Use "Finalize for delivery (as-is)" instead to deliver the imported PDF unchanged.', { reason: 'imported_letter_use_finalize_as_is', caseId, version: approveMeta.version });
      }

      // Chart-readiness machine-read gate (mirrors sign-offs.ts). When it fails, honor an existing
      // physician/admin OVERRIDE recorded at sign-off (CLM-4DACAF4A80, 2026-06-14): if a SignOff with
      // chartReadinessOverridden=true exists, the physician already acknowledged the unread files when
      // they signed — approve proceeds (and logs that it relied on the override) rather than re-prompting.
      // Otherwise keep the gate closed with the SAME descriptive message sign-offs.ts emits.
      // RECONCILED readiness (CLM-4DACAF4A80, 2026-06-14): orphaned rows (a deleted/superseded file's
      // readiness row, no longer in the chart's documents) are dropped so the gate agrees with the UI.
      const readiness = await loadReconciledChartReadiness(db, caseId);
      if (!readiness.ready) {
        const override = await findChartReadinessOverride(db, caseId);
        if (override === null) {
          throw new HttpError(409, 'chart_not_ready', buildChartNotReadyMessage(readiness.blockingFiles, 'Approve'), { caseId, blockingFiles: readiness.blockingFiles, overridable: true });
        }
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_approve_chart_readiness_override_honored', caseId, veteranId: c.veteranId, detailsJson: { caseId, signOffId: override.id, reason: override.chartReadinessOverrideReason, blockingFileCount: readiness.blockingFiles.length } } });
      }
      // A formal sign-off must already exist (recorded via POST /cases/:id/sign-off). Approve
      // finalizes; it does not replace the sign-off questionnaire.
      const signOffs = await db.signOff.findMany({ where: { caseId } });
      if (signOffs.length === 0) throw new HttpError(409, 'conflict', 'Record the physician sign-off before approving.', { reason: 'sign_off_required', caseId });
      // Affirmativeness gate (audit 2026-06-07): the LATEST sign-off must attest every item "Yes" — never
      // finalize a letter the physician signed off against. Defense-in-depth behind the sign-off route gate.
      const latestSignOff = signOffs.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      if (!isSignOffAffirmative(latestSignOff.answersJson)) {
        throw new HttpError(409, 'conflict', 'Approve blocked: the sign-off has a "No" attestation. Resolve it or send the case back to the RN.', { reason: 'sign_off_not_affirmative', caseId });
      }
      // Status transition must be legal + role-permitted (physician_review → delivered).
      if (!isValidCaseStatusTransition(c.status, 'delivered') || !canRolePerformCaseStatusTransition(user.role, c.status, 'delivered')) {
        throw new HttpError(409, 'conflict', `Cannot approve from status '${c.status}'.`, { reason: 'bad_transition', caseId, status: c.status });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      // STRANDED-POINTER SELF-HEAL AT APPROVE (CLM-8EC828F1D7, Hildreth, 2026-07-01): use the same
      // recovery-capable resolver the editor/read path uses, NOT the strict resolveCurrent. A halted
      // render-parity draft that was hand-edited + forwarded leaves Case.currentVersion pointing at a
      // dead version, so the strict resolver 409'd 'no_letter' even though a present, forwarded letter
      // exists (the review card served it) — a no-block-draft violation. resolveCurrentForEdit recovers
      // the last good letter AND re-pins Case.currentVersion; `baseLetterVersion` is the REAL base we
      // build the signed N+1 over (= currentVersion in the normal case; the recovered version when
      // stranded). A genuinely no-letter case (nothing resolvable anywhere) still → 409 no_letter.
      const editable = await resolveCurrentForEdit(caseId, c.currentVersion);
      if (editable === null) throw new HttpError(409, 'conflict', 'No current letter to approve.', { reason: 'no_letter', caseId });
      const cur = editable.letter;
      const baseLetterVersion = cur.version;
      // EXTERNAL-IMPORT GUARD ON THE RECOVERED VERSION (CLM-8EC828F1D7 must-fix #1, 2026-07-01): the
      // import guard above (approveMeta) keyed on the PRE-recovery c.currentVersion → null on a stranded
      // pointer → skipped. If recovery landed on an external_import letter, approve would re-render from
      // its PLACEHOLDER txt and MANGLE the externally-signed PDF. Re-check the guard against the version we
      // actually resolved. (No-op on the normal path: baseLetterVersion === c.currentVersion, and a re-run
      // over the same non-import version stays null.)
      if (baseLetterVersion !== c.currentVersion) {
        const recoveredMeta = await resolveCurrentRevisionMeta(db, caseId, baseLetterVersion);
        if (recoveredMeta !== null && recoveredMeta.source === 'external_import') {
          throw new HttpError(409, 'conflict', 'This is an imported letter — approving would re-render and mangle the original PDF. Use "Finalize for delivery (as-is)" instead to deliver the imported PDF unchanged.', { reason: 'imported_letter_use_finalize_as_is', caseId, version: recoveredMeta.version });
        }
      }
      const text = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });

      // LEAK CHECK = WARN ONLY at signature (Ryan 2026-06-20, HARD: "the block belongs at the DRAFT,
      // NEVER at the doctor's signature"). The physician has reviewed the letter — their signature must
      // never be programmatically blocked. We LOG any residual leak for visibility, but we do NOT block
      // approve. The real gate is at draft time (drafter pipeline) + the visible editor warning (GET
      // /letter `leaks`), so the physician sees + fixes it during review, before signing.
      const residualLeaks = blockingLeaks(detectLetterLeaks(text));
      if (residualLeaks.length > 0) {
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_approved_with_leak_warning', caseId, veteranId: c.veteranId, detailsJson: { caseId, leaks: residualLeaks.map((l) => l.code) } } });
      }

      // Build the signed final over the RESOLVED base (recovered when stranded), not the stale/dead
      // Case.currentVersion pointer — mirrors the PUT-save path (baseLetterVersion + 1).
      const newVersion = baseLetterVersion + 1;
      const keys = {
        txtKey: buildLetterRevisionKey(caseId, newVersion, 'txt'),
        pdfKey: buildLetterRevisionKey(caseId, newVersion, 'pdf'),
        docxKey: buildLetterRevisionKey(caseId, newVersion, 'docx'),
      };
      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });
      const caseData = { id: caseId, veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(), veteran_last: veteran.lastName, claimed_condition: c.claimedCondition };

      // ── D2 FRAUD GATE ── The named/credentialed physician must be the assigned signer. The
      // signer is whoever is ASSIGNED (c.assignedPhysicianId), never whoever clicks approve —
      // an admin acting on a case still finalizes the assigned physician's signature. All checks
      // run before the transaction so a blocked approve never advances the version.
      if (c.assignedPhysicianId === null) {
        throw new HttpError(409, 'conflict', 'Cannot approve: no physician is assigned to this case. Assign a signing physician, then approve.', { reason: 'no_assigned_physician', caseId });
      }
      const signer = await db.physician.findFirst({ where: { id: c.assignedPhysicianId } });
      if (signer === null) {
        throw new HttpError(409, 'conflict', 'Cannot approve: the assigned physician record was not found. Reassign the case to a current physician, then approve.', { reason: 'assigned_physician_not_found', caseId, physicianId: c.assignedPhysicianId });
      }
      if (!signer.active) {
        throw new HttpError(409, 'conflict', `Cannot approve: ${signer.fullName} is inactive. Reactivate the physician or reassign the case, then approve.`, { reason: 'assigned_physician_inactive', caseId, physicianId: signer.id });
      }
      const signerCreds = parseCredentialBlock(signer.credentialBlockJson);
      if (signerCreds === null) {
        throw new HttpError(409, 'conflict', `Cannot approve: ${signer.fullName}'s credential profile is incomplete. An administrator must complete the credential block (name, specialty, board, license, NPI) on the Physicians admin page, then re-approve.`, { reason: 'signer_credentials_incomplete', caseId, physicianId: signer.id });
      }
      const signatureKey = signer.signatureImageS3Key;
      if (signatureKey === null || signatureKey.trim() === '') {
        throw new HttpError(409, 'conflict', `Cannot approve: ${signer.fullName} has no signature image on file. An administrator must upload the physician's signature on the Physicians admin page, then re-approve.`, { reason: 'signer_signature_missing', caseId, physicianId: signer.id });
      }

      // ── CO-SIGN (DPT docket 2026-07-19) ── When the assigned signer is co-signed, resolve the
      // co-signer (the account owner) and thread its name + signature key so the renderer draws the
      // second "Independently reviewed and concurred in by" block. The co-signer must clear the SAME
      // preconditions as the primary signer (exists / active / complete credential block / signature
      // on file) — otherwise the concurrence block would render signature-less or mis-credentialed.
      // A signer with NO co-signer passes NOTHING new: the single-signer render payload below is
      // byte-identical (the c0-A regression guard).
      let cosignerFields: { cosigner_name: string; cosigner_signature_image_s3_key: string } | undefined;
      if (signer.coSignedByPhysicianId != null) {
        const coSigner = await db.physician.findFirst({ where: { id: signer.coSignedByPhysicianId } });
        if (coSigner === null) {
          throw new HttpError(409, 'conflict', `Cannot approve: the co-signing physician for ${signer.fullName} was not found. Reassign the co-signer on the Staff admin page, then re-approve.`, { reason: 'co_signer_not_found', caseId, physicianId: signer.id, coSignerId: signer.coSignedByPhysicianId });
        }
        if (!coSigner.active) {
          throw new HttpError(409, 'conflict', `Cannot approve: the co-signing physician ${coSigner.fullName} is inactive. Reactivate them or remove the co-sign on the Staff admin page, then re-approve.`, { reason: 'co_signer_inactive', caseId, coSignerId: coSigner.id });
        }
        const coSignerCreds = parseCredentialBlock(coSigner.credentialBlockJson);
        if (coSignerCreds === null) {
          throw new HttpError(409, 'conflict', `Cannot approve: the co-signing physician ${coSigner.fullName}'s credential profile is incomplete. Complete their credential block on the Physicians admin page, then re-approve.`, { reason: 'co_signer_credentials_incomplete', caseId, coSignerId: coSigner.id });
        }
        const coSignatureKey = coSigner.signatureImageS3Key;
        if (coSignatureKey === null || coSignatureKey.trim() === '') {
          throw new HttpError(409, 'conflict', `Cannot approve: the co-signing physician ${coSigner.fullName} has no signature image on file. Upload it on the Physicians admin page, then re-approve.`, { reason: 'co_signer_signature_missing', caseId, coSignerId: coSigner.id });
        }
        // Multi-line NPI-only credential block (name + board-cert + NPI) — NOT single-line
        // fullNameWithCredential, or the board-cert + NPI lines vanish from the rendered co-sign
        // block (regression caught by QA 2026-07-19).
        cosignerFields = { cosigner_name: buildRendererCredentialLines(coSignerCreds), cosigner_signature_image_s3_key: coSignatureKey };
      }

      // Substitute any signer sentinels with the assigned signer's rendered blocks (no-op on the
      // legacy hardcoded-credential letters). Pronoun defaults to "their" (gender-neutral; no
      // veteran-pronoun field exists yet) and is irrelevant to no-sentinel letters.
      const finalText = substituteSignerSentinels(text, signerCreds, 'their');

      // Positive identity check: the assigned signer's credentialed name must appear (whole-name).
      if (!signerNameAppears(finalText, signerCreds.fullNameWithCredential)) {
        throw new HttpError(409, 'conflict', `Cannot approve: the letter does not name the assigned signing physician (${signerCreds.fullNameWithCredential}). Regenerate or correct the letter so it is authored under the assigned physician, then approve.`, { reason: 'signer_name_absent', caseId, physicianId: signer.id });
      }
      // Anti-fraud: no OTHER known physician's credentialed name may appear in the letter body. The
      // assigned signer's own name is masked inside findForeignSignerNames; the co-signer (a legit
      // second signer) is additionally excluded so a letter that legitimately concurs is never
      // false-blocked — WITHOUT weakening detection of the primary signer or any unrelated physician.
      // (Per spec the co-signer name appears only in the render signature block, not the body, so this
      // is a defensive exclusion; it never lets an unauthorized name through.)
      const roster = await db.physician.findMany({ where: { active: true } });
      const rosterNames = roster
        .map((p) => parseCredentialBlock(p.credentialBlockJson)?.fullNameWithCredential)
        .filter((n): n is string => typeof n === 'string')
        .filter((n) => cosignerFields === undefined || n !== cosignerFields.cosigner_name);
      const foreign = findForeignSignerNames(finalText, rosterNames, signerCreds.fullNameWithCredential);
      if (foreign.length > 0) {
        throw new HttpError(409, 'conflict', `Cannot approve: the letter names ${foreign.join(', ')} but the assigned signing physician is ${signerCreds.fullNameWithCredential}. A letter must be signed by the physician it is authored under. Reassign the case to the named physician or regenerate the letter, then approve.`, { reason: 'foreign_signer_name', caseId, physicianId: signer.id, foreignNames: foreign });
      }
      // Fail closed: an unresolved signer sentinel must never reach the renderer / S3.
      if (finalText.includes('[[SIGNER_')) {
        throw new HttpError(502, 'internal_error', 'Refusing to render: an unresolved signer sentinel survived substitution.', { reason: 'signer_sentinel_unresolved', caseId });
      }

      // Render FINAL (no DRAFT watermark) at the new version.
      // signer_name = the multi-line NPI-only credential block (name + board-cert + NPI), NOT the
      // single-line fullNameWithCredential — the renderer stamps every line into the header + sig
      // block; passing one line silently dropped the board-cert + NPI from EVERY approved letter
      // (QA 2026-07-19). buildRendererCredentialLines reproduces today's Kasky lines byte-for-byte.
      const rendered = await deps.renderLetter({ caseData: { ...caseData, signer_name: buildRendererCredentialLines(signerCreds), signature_image_s3_key: signatureKey, ...(cosignerFields ?? {}) }, letterText: finalText, version: newVersion, draft: false, bucket: bucketName, keys });
      if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Final render failed; not approved.', { reason: 'render_failed', caseId });
      // Version-match guard (Ryan's safety requirement): the final artifact MUST be the version
      // we're advancing to — never a stale one.
      if (rendered.version !== newVersion) throw new HttpError(500, 'internal_error', 'Render version mismatch; refusing to approve.', { caseId, expected: newVersion, got: rendered.version });
      // Atomic triple-artifact invariant (#9 Fix 4): the final letter must carry all three artifacts.
      assertTripleArtifacts(keys, { caseId, version: newVersion });

      try {
        await db.$transaction(async (tx) => {
          // Doctor-pay stamps (DOCTOR_PAY_BUILD_PLAN §5.6) — written transactionally WITH the
          // completion so a pay row can never exist without a delivered letter (or vice versa):
          //  - letterType: the approve path always produces a nexus letter; memos are an
          //    admin-only manual re-tag (PATCH /letter-revisions/:id/type) until a memo pipeline exists.
          //  - signingPhysicianId: immutable attribution snapshot = the ASSIGNED signer (already
          //    proven by the D2 gate above — never the clicker, who may be an admin). Reassignment
          //    after completion must never move past earnings.
          //  - payCents: rate-at-completion snapshot — future rate changes never rewrite history.
          await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: baseLetterVersion, source: 'approved_final', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: null, letterType: 'nexus_letter', signingPhysicianId: signer.id, payCents: resolveRateCents('nexus_letter') } });
          await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, status: 'delivered', version: { increment: 1 } } });
          await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_approved', caseId, veteranId: c.veteranId, detailsJson: { version: newVersion, finalArtifact: keys.pdfKey } } });
        });
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another change advanced the version; reload and re-approve.', { reason: 'concurrent_save', caseId });
        throw e;
      }
      res.json({ data: { version: newVersion, status: 'delivered', finalPdfKey: keys.pdfKey } });
    }),
  );

  // ── POST finalize-import — finalize an IMPORTED letter for delivery WITHOUT re-rendering ──
  // (import deliver-as-is, 2026-06-14). The normal /approve re-renders the FINAL letter from the TXT;
  // an externally-imported letter (LetterRevision source='external_import') has only a placeholder
  // txt, so re-rendering would mangle the specially-formatted/externally-signed PDF. This sibling
  // route binds a physician sign-off to the EXACT imported PDF bytes (sha256) and flips the case to
  // 'delivered' in one transaction — the imported PDF IS the final artifact, no new revision created.
  //
  // The same physician/admin role + assignment + chart-readiness + affirmative-sign-off gates the
  // normal approve enforces apply here. The sign-off is CREATED here (not pre-recorded) so its
  // signedContentSha256 binds to the PDF — the placeholder-txt sign-off the normal route produces
  // would bind to a hash the delivery gate's PDF re-hash could never match. The delivery-eligibility
  // gate (extended for external_import) then re-hashes that same PDF at egress, so the $500 Stripe
  // path delivers the imported PDF only when a sign-off is bound to those exact bytes.
  router.post(
    '/cases/:id/letter/finalize-import',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      // Parse + affirmativeness-gate the sign-off answers (same contract + predicate as POST /sign-off).
      const parsed = parseSignOffCreate(req.body);
      if (!isSignOffAffirmative(parsed.answers)) {
        throw new HttpError(409, 'conflict', 'Sign-off requires every item to be "Yes". Resolve the flagged item, or send the case back to the RN instead.', { reason: 'sign_off_not_affirmative', caseId });
      }

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null || c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
      }

      // This route is ONLY for imported letters — a rendered letter must go through /approve.
      const meta = await resolveCurrentRevisionMeta(db, caseId, c.currentVersion);
      if (meta === null) throw new HttpError(409, 'conflict', 'No current letter to finalize.', { reason: 'no_letter', caseId });
      if (meta.source !== 'external_import') {
        throw new HttpError(409, 'conflict', 'This is not an imported letter. Use "Approve letter" to finalize a rendered letter.', { reason: 'not_an_imported_letter', caseId, version: meta.version });
      }
      if (meta.pdfKey === null) {
        throw new HttpError(409, 'conflict', 'The imported letter has no PDF artifact to deliver. Re-import the finished PDF.', { reason: 'imported_pdf_missing', caseId, version: meta.version });
      }

      // Chart-readiness machine-read gate (mirrors /approve + sign-offs.ts) with RECONCILED readiness
      // (orphan-drop) so an invisible orphaned readiness row can never block finalize-import.
      // The finalize-import modal submits the override INLINE (overrideChartReadiness + reason) because
      // this route CREATES the sign-off — there is no prior POST /sign-off to carry it. So we parse the
      // inline override here (physician/admin + non-empty reason) AND also honor a PRIOR override sign-off
      // if one exists. (CLM-4DACAF4A80, 2026-06-14: "Sign off anyway" was a DEAD LINK on this path because
      // the inline override was never parsed — only a prior override sign-off was checked, which the
      // inline import path never creates, so the gate 409'd forever.)
      const readiness = await loadReconciledChartReadiness(db, caseId);
      const inlineOverrideReason = resolveOverrideReason(
        req.body?.overrideChartReadiness as boolean | undefined,
        req.body?.chartReadinessOverrideReason as string | undefined,
        user.role,
      );
      const chartReadinessOverridden = !readiness.ready && inlineOverrideReason !== null;
      if (!readiness.ready && !chartReadinessOverridden) {
        const priorOverride = await findChartReadinessOverride(db, caseId);
        if (priorOverride === null) {
          throw new HttpError(409, 'chart_not_ready', buildChartNotReadyMessage(readiness.blockingFiles, 'Finalize'), { caseId, blockingFiles: readiness.blockingFiles, overridable: true });
        }
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_finalize_chart_readiness_override_honored', caseId, veteranId: c.veteranId, detailsJson: { caseId, signOffId: priorOverride.id, reason: priorOverride.chartReadinessOverrideReason, blockingFileCount: readiness.blockingFiles.length } } });
      }
      // Audit snapshot of the blocking files AS THEY WERE at inline-override time (mirrors sign-offs.ts) —
      // stored on the SignOff row + logged, never recomputed. Null when not overriding inline.
      const overrideFileSnapshot = chartReadinessOverridden
        ? readiness.blockingFiles.map((b) => ({ filePath: b.filePath, terminalStatus: b.terminalStatus, note: b.lastAttempt?.note ?? null }))
        : null;

      // Status transition must be legal + role-permitted (same target as /approve: -> delivered).
      if (!isValidCaseStatusTransition(c.status, 'delivered') || !canRolePerformCaseStatusTransition(user.role, c.status, 'delivered')) {
        throw new HttpError(409, 'conflict', `Cannot finalize from status '${c.status}'.`, { reason: 'bad_transition', caseId, status: c.status });
      }

      // The signing physician is whoever is ASSIGNED (never the clicker — an admin may finalize on the
      // physician's behalf). Mirrors /approve's D2 attribution.
      if (c.assignedPhysicianId === null) {
        throw new HttpError(409, 'conflict', 'Cannot finalize: no physician is assigned to this case. Assign a signing physician, then finalize.', { reason: 'no_assigned_physician', caseId });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });

      // BYTE-BINDING: hash the EXACT imported PDF bytes. The sign-off binds to THIS hash; the
      // delivery-eligibility gate re-hashes the same PDF at egress (no re-render anywhere).
      const pdf = await readPdfBytesWithHash(s3(), bucketName, meta.pdfKey, { caseId, version: meta.version });

      let signOffId: string;
      try {
        signOffId = await db.$transaction(async (tx) => {
          const row = await tx.signOff.create({
            data: {
              caseId,
              physicianId: c.assignedPhysicianId as string,
              answersJson: parsed.answers,
              notes: parsed.notes,
              signedVersion: meta.version,
              signedContentSha256: pdf.sha256,
              chartReadinessOverridden,
              chartReadinessOverrideReason: chartReadinessOverridden ? inlineOverrideReason : null,
              chartReadinessOverrideFiles: overrideFileSnapshot,
            },
          });
          // No new LetterRevision — the imported PDF IS the final artifact. Set the same delivery-ready
          // state /approve sets (status -> delivered + the doctor-pay stamps on the CURRENT imported
          // revision). currentVersion does NOT advance (the imported revision is already current).
          await tx.case.update({ where: { id: caseId }, data: { status: 'delivered', version: { increment: 1 } } });
          await tx.letterRevision.update({
            where: { id: meta.id },
            data: { letterType: 'nexus_letter', signingPhysicianId: c.assignedPhysicianId, payCents: resolveRateCents('nexus_letter') },
          });
          await tx.activityLog.create({ data: { actorUserId: user.sub, action: chartReadinessOverridden ? 'letter_finalized_import_chart_readiness_overridden' : 'letter_finalized_import', caseId, veteranId: c.veteranId, detailsJson: { version: meta.version, signOffId: row.id, signingPhysicianId: c.assignedPhysicianId, pdfS3Key: meta.pdfKey, signedContentSha256: pdf.sha256, ...(chartReadinessOverridden ? { chartReadinessOverrideReason: inlineOverrideReason, overriddenFiles: overrideFileSnapshot } : {}) } } });
          return row.id;
        });
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another change advanced the case; reload and re-finalize.', { reason: 'concurrent_save', caseId });
        throw e;
      }
      res.json({ data: { version: meta.version, status: 'delivered', signOffId, finalPdfKey: meta.pdfKey, source: 'external_import' } });
    }),
  );

  // ── POST decline — physician sends the letter back to the RN with a reason ──
  router.post(
    '/cases/:id/letter/decline',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const body = (req.body ?? {}) as { reason?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') throw new HttpError(400, 'bad_request', 'reason (non-empty string) is required', { caseId });

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      // Enforce assigned-physician ONLY when a physician IS assigned — mirrors the status-route carve-out
      // (cases.ts roleGuardForStatusTransition, Ryan 2026-06-06): an UNASSIGNED physician_review case
      // (legacy / claimed-from-queue) must stay actionable by the reviewing physician, else the letter is
      // stuck with nobody able to send it back. Without the `!== null` guard, send-back-WITH-a-note (which
      // now routes here) would 403 where the no-note path still succeeds (Dr. Kasky send-back note fix).
      if (user.role === 'physician' && c.assignedPhysicianId !== null) {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null || c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
      }
      if (!isValidCaseStatusTransition(c.status, 'correction_requested') || !canRolePerformCaseStatusTransition(user.role, c.status, 'correction_requested')) {
        throw new HttpError(409, 'conflict', `Cannot decline from status '${c.status}'.`, { reason: 'bad_transition', caseId, status: c.status });
      }

      // Bug (a) fix: the decline must also drop a case-linked StaffMessage TO the assigned RN so the
      // correction reason is a human-readable message the RN actually sees in their inbox (operatorMessage
      // alone is invisible to the RN). Resolve the RN's Cognito sub from the assigned AppUser id; if the
      // case has no assigned RN we still keep the back-compat writes (no message — there is no addressee).
      const reason = body.reason as string;
      const assignedRn = c.assignedRnId !== null ? await db.appUser.findUnique({ where: { id: c.assignedRnId } }) : null;
      const rnSub = (assignedRn as { cognitoSub?: string } | null)?.cognitoSub ?? null;
      // Append to the existing correction thread for this case if one exists; else start a new thread.
      const existingCorrection = await db.staffMessage.findFirst({ where: { caseId, subject: { not: null } }, orderBy: { createdAt: 'asc' } });
      const threadId = existingCorrection?.threadId ?? randomUUID();
      const isNewThread = existingCorrection === null;

      await db.$transaction(async (tx) => {
        // operatorMessage is the existing RN-facing channel (rendered in the ops UI) — kept for back-compat.
        await tx.case.update({ where: { id: caseId }, data: { status: 'correction_requested', operatorMessage: reason, version: { increment: 1 } } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_declined', caseId, veteranId: c.veteranId, detailsJson: { reason: reason.slice(0, 1000) } } });

        // The new human-readable source of truth: a case-linked StaffMessage to the RN.
        await tx.staffMessage.create({ data: { threadId, caseId, authorSub: user.sub, subject: isNewThread ? `Correction requested: ${c.claimedCondition}`.slice(0, 200) : null, body: reason } });
        if (rnSub !== null && rnSub !== user.sub) {
          // Ensure a recipient row for the RN (idempotent on the (threadId, recipientSub) unique key)
          // and re-flip it unread so the decline surfaces even on an existing correction thread.
          const existingRecip = await tx.staffMessageRecipient.findFirst({ where: { threadId, recipientSub: rnSub } });
          if (existingRecip === null) {
            await tx.staffMessageRecipient.create({ data: { threadId, recipientSub: rnSub, kind: 'to', addedBySub: user.sub, readAt: null } });
          } else {
            await tx.staffMessageRecipient.updateMany({ where: { threadId, recipientSub: rnSub }, data: { readAt: null, archivedAt: null } });
          }
          await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'staff_message_sent', caseId, veteranId: c.veteranId, detailsJson: { threadId, reason: 'letter_decline_to_rn', recipientSub: rnSub } } });
        }
      });
      res.json({ data: { status: 'correction_requested' } });
    }),
  );

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Citation Enricher (Feature B, 2026-06-24) — PHYSICIAN-ONLY. Add grounded, verified PubMed
  // citations to an existing letter. Two-phase like surgical-AI, but ASYNC (the grounded NCBI
  // retrieval is several serial round-trips that won't finish under the API Gateway 30s ceiling):
  //   1. POST  .../citations/enrich        → PROPOSE: create a job, run the retrieval, return 202 {jobId}
  //   2. GET   .../citations/enrich/:jobId  → POLL:    return {status, candidates?}
  //   3. POST  .../citations/apply          → APPLY:   re-verify each selected PMID SERVER-SIDE, then
  //                                            deterministically insert + persist a new version.
  // SAFETY: the apply re-verifies every selected PMID against NCBI (never a client flag) and the
  // citation-integrity guard is diffCitationsSanctioned(before, after, verifiedPmids) — a net-new
  // citation is allowed ONLY if its PMID is in the server-re-verified set; anything else is rejected.
  // ════════════════════════════════════════════════════════════════════════════════════════════

  // Physician-only gate shared by all three enricher routes. ops_staff (RN) → 403. (Mirrors the
  // §VII physician-only reasoning: adding citations to a signed-able medical opinion is the
  // physician's act.) Admin may act. Distinct from the surgical/guided edit parity (RN-allowed).
  function assertPhysicianOnly(role: string, caseId: string): void {
    if (role !== 'physician' && role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Citation enrichment is a physician action.', { reason: 'physician_only', caseId });
    }
  }

  // ── POST citations/enrich — PROPOSE (async): create a job + run grounded NCBI retrieval ──
  router.post(
    '/cases/:id/letter/citations/enrich',
    requireRole(['admin', 'physician', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      assertPhysicianOnly(user.role, caseId);
      const body = (req.body ?? {}) as { claim?: unknown; condition?: unknown; mechanismHints?: unknown; pmid?: unknown };

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);
      if (!EDITABLE_STATUSES.has(c.status)) throw new HttpError(409, 'conflict', `Letter is not editable in status '${c.status}'.`, { reason: 'not_editable', caseId, status: c.status });

      // ── DIRECT-PMID branch (2026-07-02): the physician typed an EXACT PubMed ID, not a claim/condition
      // to search. We resolve+verify that one paper against NCBI and store it as the (single) ready
      // candidate, then the SAME poll + apply + sanctioned-guard path handles preview → add. The by-PMID
      // job stores condition:'' — a NON-nullish sentinel so the apply-time `job.condition ?? claimedCondition`
      // resolves to '' and verifyPmidById SKIPS the on-topic gate (the physician's explicit PMID is the
      // relevance authority; anti-fabrication — real + non-retracted + grounded — still holds at apply). ──
      const pmidRaw = typeof body.pmid === 'string' ? body.pmid.trim() : '';
      if (pmidRaw !== '') {
        const directPmid = pmidRaw.replace(/\D/g, '').replace(/^0+/, '');
        if (directPmid === '') throw new HttpError(400, 'bad_request', 'Enter a numeric PubMed ID (digits only).', { reason: 'invalid_pmid', caseId });
        if (deps.enrichResolvePmid === undefined) throw new HttpError(503, 'internal_error', 'Citation enrichment is not configured in this environment.', { reason: 'enricher_not_configured', caseId });

        const job = await db.citationEnrichJob.create({
          data: { caseId, status: 'pending', claim: null, condition: '', mechanismHints: [], requestedBy: user.sub },
        });
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_citation_enrich_proposed', caseId, veteranId: c.veteranId, detailsJson: { jobId: job.id, byPmid: directPmid } } });
        res.status(202).json({ data: { jobId: job.id, status: 'pending' } });

        // ── Async resolve (best-effort; failure flips the job to 'error', never throws to the client). ──
        void (async () => {
          try {
            const resolved = await (deps.enrichResolvePmid as EnrichPmidResolver)(directPmid);
            if (resolved.status === 'ok') {
              await db.citationEnrichJob.update({
                where: { id: job.id },
                data: { status: 'ready', condition: '', candidatesJson: [resolved.candidate], errorMessage: null },
              });
            } else {
              const message =
                resolved.status === 'pmid_not_found'
                  ? `PubMed has no record for PMID ${directPmid}. Check the ID and try again — nothing was changed.`
                  : resolved.status === 'retracted'
                    ? `PMID ${directPmid} is a RETRACTED publication and cannot be added.`
                    : resolved.status === 'invalid_pmid'
                      ? 'That is not a valid PubMed ID. Enter the numeric PMID.'
                      : `PMID ${directPmid} could not be verified against PubMed right now (no readable abstract to ground it, or PubMed was unreachable). It was not added.`;
              await db.citationEnrichJob.update({
                where: { id: job.id },
                data: { status: 'error', candidatesJson: [], errorMessage: message },
              });
            }
          } catch (e: unknown) {
            await db.citationEnrichJob.update({
              where: { id: job.id },
              data: { status: 'error', errorMessage: e instanceof Error ? e.message.slice(0, 500) : 'resolution failed' },
            }).catch(() => { /* swallow — the poll will surface a stuck 'pending' row */ });
          }
        })();
        return;
      }

      if (deps.enrichRetrieve === undefined) throw new HttpError(503, 'internal_error', 'Citation enrichment is not configured in this environment.', { reason: 'enricher_not_configured', caseId });

      const claim = typeof body.claim === 'string' && body.claim.trim() !== '' ? body.claim.trim() : null;
      const explicitCondition = typeof body.condition === 'string' && body.condition.trim() !== '' ? body.condition.trim() : null;
      const explicitHints = Array.isArray(body.mechanismHints)
        ? body.mechanismHints.map((h) => String(h ?? '').trim()).filter((h) => h.length > 0).slice(0, 5)
        : [];
      if (claim === null && explicitCondition === null) {
        throw new HttpError(400, 'bad_request', 'Provide a claim sentence or a condition to search for.', { reason: 'no_query', caseId });
      }

      // Create the pending job row up front (the poll target). Condition resolves below.
      const job = await db.citationEnrichJob.create({
        data: {
          caseId,
          status: 'pending',
          claim,
          condition: explicitCondition,
          mechanismHints: explicitHints,
          requestedBy: user.sub,
        },
      });
      await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_citation_enrich_proposed', caseId, veteranId: c.veteranId, detailsJson: { jobId: job.id, hasClaim: claim !== null } } });

      // Return 202 immediately; the retrieval continues below (the handler awaits it, but the client
      // is expected to POLL — for very long retrievals the await may exceed the gateway timeout, in
      // which case the row is already 'pending' and the poll will catch the eventual 'ready'/'error').
      res.status(202).json({ data: { jobId: job.id, status: 'pending' } });

      // ── Async retrieval (best-effort; failure flips the job to 'error', never throws to the client). ──
      void (async () => {
        try {
          // Resolve the search condition: an explicit condition wins; else map the claim sentence to
          // SEARCH TERMS via the strict-schema Haiku call (no cite field → cannot invent a citation).
          let condition = explicitCondition ?? '';
          let mechanismHints = explicitHints;
          if (condition === '' && claim !== null) {
            if (deps.extractTerms !== undefined) {
              try {
                const terms = await deps.extractTerms(claim);
                condition = terms.condition;
                if (mechanismHints.length === 0) mechanismHints = terms.mechanismHints;
              } catch {
                // Term extraction failed — fall back to the raw claim as the search string (still
                // fully grounded by NCBI; we just lose the focused condition phrasing).
                condition = claim;
              }
            } else {
              condition = claim;
            }
          }
          const result = await (deps.enrichRetrieve as EnrichRetriever)(condition, mechanismHints);
          const candidates: EnrichCandidate[] = anchorsToCandidates(result.anchors);
          // BUG 3 FIX (Spring, 2026-06-25): a CLEAR, ACTIONABLE empty message instead of a bare
          // "no grounded citations found". The grounded retrieval distinguishes WHY nothing came back
          // (NCBI unreachable/rate-limited vs a genuinely empty/over-narrow search vs a blank
          // condition), so the physician knows whether to retry now or broaden/reword the search.
          const emptyMessage =
            result.status === 'network_error'
              ? 'PubMed could not be reached just now (network or rate limit). Wait a moment and try again — nothing was changed.'
              : result.status === 'invalid_condition'
                ? 'No searchable condition was found in that input. Enter a condition (e.g. "obstructive sleep apnea") or highlight a clearer claim sentence.'
                : `No grounded PubMed citations matched "${condition}". Try a broader condition, drop the mechanism hints, or reword the claim, then search again.`;
          await db.citationEnrichJob.update({
            where: { id: job.id },
            data: {
              status: result.status === 'grounded' && candidates.length > 0 ? 'ready' : 'error',
              condition,
              mechanismHints,
              candidatesJson: candidates,
              errorMessage: candidates.length === 0 ? emptyMessage : null,
            },
          });
        } catch (e: unknown) {
          await db.citationEnrichJob.update({
            where: { id: job.id },
            data: { status: 'error', errorMessage: e instanceof Error ? e.message.slice(0, 500) : 'retrieval failed' },
          }).catch(() => { /* swallow — the poll will surface a stuck 'pending' row */ });
        }
      })();
    }),
  );

  // ── GET citations/enrich/:jobId — POLL: return {status, candidates?} (preview-only, no write) ──
  router.get(
    '/cases/:id/letter/citations/enrich/:jobId',
    requireRole(['admin', 'physician', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      assertPhysicianOnly(user.role, caseId);
      const jobId = String(req.params.jobId);
      const job = await db.citationEnrichJob.findFirst({ where: { id: jobId, caseId } });
      if (job === null) throw new HttpError(404, 'not_found', 'Enrichment job not found for this case.', { caseId, jobId });
      const candidates = Array.isArray(job.candidatesJson) ? (job.candidatesJson as EnrichCandidate[]) : undefined;
      res.json({
        data: {
          status: job.status,
          ...(job.status === 'ready' && candidates ? { candidates } : {}),
          ...(job.status === 'error' ? { error: job.errorMessage ?? 'Citation retrieval failed.' } : {}),
        },
      });
    }),
  );

  // ── POST citations/apply — APPLY: re-verify selected PMIDs server-side, insert, persist v<N+1> ──
  router.post(
    '/cases/:id/letter/citations/apply',
    requireRole(['admin', 'physician', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      assertPhysicianOnly(user.role, caseId);
      // groundInSectionVi is accepted-but-ignored (Bug 2, Spring 2026-06-25): the generic §VI grounding
      // sentence was removed; older clients may still send the flag, so we tolerate it without using it.
      const body = (req.body ?? {}) as { jobId?: unknown; selectedPmids?: unknown };
      const jobId = typeof body.jobId === 'string' ? body.jobId : '';
      const selectedPmids = Array.isArray(body.selectedPmids)
        ? body.selectedPmids.map((p) => String(p ?? '').replace(/\D/g, '')).filter((p) => p.length > 0)
        : [];
      if (jobId === '') throw new HttpError(400, 'bad_request', 'jobId is required.', { caseId });
      if (selectedPmids.length === 0) throw new HttpError(400, 'bad_request', 'Select at least one citation to add.', { reason: 'no_selection', caseId });
      // Cap the apply set: each PMID is 2 serially-throttled NCBI round-trips on the shared egress IP,
      // so an oversized list would tie up the request and risk a 429 that degrades the drafter's whole
      // citation-fallback path. The UI only ever selects a few previewed candidates.
      if (selectedPmids.length > 12) throw new HttpError(400, 'bad_request', `Too many citations selected (${selectedPmids.length}). Add at most 12 at a time.`, { reason: 'too_many_pmids', caseId });
      if (deps.enrichVerify === undefined) throw new HttpError(503, 'internal_error', 'Citation enrichment is not configured in this environment.', { reason: 'enricher_not_configured', caseId });

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);
      if (!EDITABLE_STATUSES.has(c.status)) throw new HttpError(409, 'conflict', `Letter is not editable in status '${c.status}'.`, { reason: 'not_editable', caseId, status: c.status });

      const job = await db.citationEnrichJob.findFirst({ where: { id: jobId, caseId } });
      if (job === null) throw new HttpError(404, 'not_found', 'Enrichment job not found for this case.', { caseId, jobId });
      const condition = job.condition ?? c.claimedCondition;

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });
      const oldText = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });

      // ── SERVER-SIDE RE-VERIFY every selected PMID against NCBI (never trust the client/poll). ──
      // A PMID that is not real, retracted, off-topic, or has no extractable killer stat is REFUSED —
      // we never insert an unverified citation. The verified set becomes the SANCTIONED set the guard
      // checks the citation delta against.
      const verifiedCitations: VerifiedCitationForInsert[] = [];
      const rejected: Array<{ pmid: string; reason: string }> = [];
      for (const pmid of selectedPmids) {
        const v: VerifyResult = await (deps.enrichVerify as EnrichVerifier)(pmid, condition);
        if (v.verified) {
          verifiedCitations.push({ pmid: v.pmid, title: v.title, journal: v.journal, year: v.year, killer_finding: v.killer_finding, full_citation: v.full_citation });
        } else {
          rejected.push({ pmid, reason: v.reason ?? 'unverified' });
        }
      }
      // If ANY selected PMID failed re-verification, REFUSE the whole apply (bias to block — a
      // medico-legal letter must not ship a citation we could not confirm at apply time).
      if (rejected.length > 0) {
        throw new HttpError(422, 'conflict', `Citation apply rejected: ${rejected.length} selected citation(s) could not be re-verified against PubMed at apply time (${rejected.map((r) => `PMID ${r.pmid}: ${r.reason}`).join('; ')}). Nothing was changed.`, { reason: 'citation_unverified', caseId, rejected });
      }

      // ── DETERMINISTIC insertion (no LLM). Adds only the verified PMIDs (no embedded stats). ──
      // BUG 2 FIX (Spring, 2026-06-25): condition-search and passage-search now BOTH insert proper
      // numbered §VIII references in the house format; the generic §VI grounding sentence was removed.
      const { newText, insertedPmids } = insertVerifiedCitations(oldText, verifiedCitations);

      // ── SANCTIONED citation-integrity guard. The ONLY allowed net-new citations are the
      // server-re-verified PMIDs; ANY other added citation/stat is rejected. By construction the
      // deterministic insertion adds exactly the sanctioned PMIDs, so this proves that invariant
      // and fails closed if anything else slipped in (defense in depth on the string assembly).
      // Pass the verified citation strings so a legitimate %/ratio in a real paper's TITLE (part of an
      // NCBI-verified inserted reference line) is not false-flagged as an invented statistic. Only tokens
      // that literally appear in these verified strings are exempted; a stat anywhere else still rejects.
      const sanctionedDiff = diffCitationsSanctioned(oldText, newText, insertedPmids, verifiedCitations.map((v) => v.full_citation ?? ''));
      if (sanctionedDiff.added.length > 0) {
        throw new HttpError(422, 'conflict', `Citation apply rejected: the insertion would introduce ${sanctionedDiff.added.length} citation/statistic that is not in the server-verified set (${sanctionedDiff.added.map(describeToken).join(', ')}). Nothing was changed.`, { reason: 'citation_invented', caseId, added: sanctionedDiff.added });
      }

      // ── Persist via the EXISTING new-version path (render → assert artifacts → transactional row). ──
      const warnings: SanityFinding[] = sanityCheckLetterText(oldText, newText);
      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });
      const staleSignOff = (await db.signOff.findFirst({ where: { caseId, signedVersion: c.currentVersion } })) ?? null;
      const stale = staleSignOff !== null ? staleSignOffOutcome(c.status) : null;
      const newVersion = c.currentVersion + 1;
      const keys = {
        txtKey: buildLetterRevisionKey(caseId, newVersion, 'txt'),
        pdfKey: buildLetterRevisionKey(caseId, newVersion, 'pdf'),
        docxKey: buildLetterRevisionKey(caseId, newVersion, 'docx'),
      };
      const caseData = { id: caseId, veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(), veteran_last: veteran.lastName, claimed_condition: c.claimedCondition };
      const rendered = await deps.renderLetter({ caseData, letterText: newText, version: newVersion, draft: true, bucket: bucketName, keys });
      if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Render failed; nothing saved.', { reason: 'render_failed', caseId });
      assertTripleArtifacts(keys, { caseId, version: newVersion });
      try {
        await db.$transaction(async (tx) => {
          // source='surgical_ai' (the existing in-editor edit source; the enricher is an in-editor
          // physician edit). The activity log records the citation-specific action + the PMIDs.
          await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: c.currentVersion, source: 'surgical_ai', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: warnings } });
          await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 }, ...(stale?.returnToPhysicianReview ? { status: 'physician_review' } : {}) } });
          await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_citation_enrich_applied', caseId, veteranId: c.veteranId, detailsJson: { version: newVersion, jobId, insertedPmids } } });
          if (stale !== null) {
            await tx.activityLog.create({ data: { actorUserId: user.sub, action: stale.logAction, caseId, veteranId: c.veteranId, detailsJson: { staleSignedVersion: c.currentVersion, newVersion, fromStatus: c.status, source: 'citation_enrich' } } });
          }
        });
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another change advanced the version; reload and re-apply.', { reason: 'concurrent_save', caseId });
        throw e;
      }
      res.json({ data: { version: newVersion, txt: newText, insertedPmids, warnings, notice: stale?.notice ?? null } });
    }),
  );

  return router;
}
