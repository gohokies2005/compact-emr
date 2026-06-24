import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { letterFilename } from '../services/letterFilename.js';
import { isSignOffAffirmative } from '../services/sign-off-validation.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';
import { buildLetterRevisionKey } from '../services/s3-key-safety.js';
import { cleanProseForSave, sanityCheckLetterText, computeLockedRanges, type SanityFinding } from '../services/letter-sanity.js';
import { applyStructuredEdit, type EditProposal } from '../services/letter-edit-apply.js';
import { diffCitations, describeToken, type CitationDiff } from '../services/letter-citation-integrity.js';
import { holdingChanged } from '../services/letter-opinion-excerpt.js';
import { isValidCaseStatusTransition, canRolePerformCaseStatusTransition } from '../services/case-status-transitions.js';
import { resolveRateCents } from '../services/pay-earnings.js';
import { loadReconciledChartReadiness, buildChartNotReadyMessage } from '../services/chart-readiness.js';
import { findChartReadinessOverride, resolveOverrideReason } from '../services/chart-readiness-override.js';
import { readTxtFromS3 as readLetterTxtFromS3, type LetterTxtContext, resolveCurrentRevisionMeta, readPdfBytesWithHash, headObjectExists, resolveLatestS3DrafterArtifact } from '../services/letter-current.js';
import { detectLetterLeaks, blockingLeaks } from '../services/letter-leak-detector.js';
import { parseSignOffCreate } from '../services/sign-off-validation.js';
import {
  parseCredentialBlock,
  substituteSignerSentinels,
  findForeignSignerNames,
  signerNameAppears,
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

export interface LetterRouterDeps {
  renderLetter: RenderInvoker;
  proposeSurgicalEdit?: SurgicalProposer;
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
    const strict = await resolveCurrent(caseId, currentVersion);
    if (strict !== null && await headObjectExists(s3(), bucket() as string, strict.txtKey)) {
      return strict;
    }
    // currentVersion is unresolvable or its TXT is missing — recover the latest version that truly
    // has a letter. Re-read the winning row to carry its pdf/docx keys (the walk is txt-keyed).
    const latest = await resolveLatestResolvableTxt(caseId, currentVersion);
    // Nothing recoverable anywhere: return the STRICT row (if one exists). The normal read path then
    // runs readTxtFromS3 on it and yields the precise "letter_artifact_missing — re-draft" 404 (more
    // helpful than a generic no_letter). If strict is also null, the caller yields the generic 404.
    if (latest === null) {
      // S3-TRUTH FALLBACK: no DB row resolved to a present artifact. Discover the newest letter that
      // actually EXISTS in S3 (a good drafter letter whose DB row lost/offset its key — Hackworth v73,
      // where currentVersion points at the failed v97/v98 and no row carries a resolvable key).
      const s3hit = await resolveLatestS3DrafterArtifact(s3(), bucket() as string, caseId);
      if (s3hit !== null) {
        console.warn(`[letter] s3-truth-recovery: case ${caseId} currentVersion=${currentVersion} had no DB-resolvable artifact; served S3 drafter-artifact v${s3hit.version}`);
        return s3hit;
      }
      return strict;
    }
    const rev = await db.letterRevision.findFirst({ where: { caseId, version: latest.version } });
    if (rev !== null && rev.artifactTxtS3Key === latest.txtKey) {
      return { version: rev.version, txtKey: rev.artifactTxtS3Key, pdfKey: rev.artifactPdfS3Key, docxKey: rev.artifactDocxS3Key };
    }
    const job = await db.draftJob.findFirst({ where: { caseId, version: latest.version } });
    if (job !== null && job.artifactTxtS3Key === latest.txtKey) {
      return { version: job.version, txtKey: latest.txtKey, pdfKey: job.artifactPdfS3Key, docxKey: job.artifactDocxS3Key };
    }
    // The winning row's txt key changed underfoot (extremely unlikely) — return txt-only; the GET
    // path tolerates null pdf/docx (the editor opens the TXT; PDF/DOCX presign just go null).
    return { version: latest.version, txtKey: latest.txtKey, pdfKey: null, docxKey: null };
  }

  // Walk DB versions DESC across BOTH tables and return the newest whose TXT object is present in S3.
  // Inlined (not the shared lib resolveLatestResolvableLetter) so it reuses THIS router's db + s3()
  // exactly as the strict resolver does, and stays test-injectable through the same deps.
  async function resolveLatestResolvableTxt(caseId: string, _currentVersion: number): Promise<{ version: number; txtKey: string } | null> {
    const candidates = new Map<number, string>();
    const revs = await db.letterRevision.findMany({ where: { caseId }, orderBy: { version: 'desc' } });
    for (const r of revs) {
      if (typeof r.artifactTxtS3Key === 'string' && r.artifactTxtS3Key.length > 0 && !candidates.has(r.version)) {
        candidates.set(r.version, r.artifactTxtS3Key);
      }
    }
    const jobs = await db.draftJob.findMany({ where: { caseId }, orderBy: { version: 'desc' } });
    for (const j of jobs) {
      if (typeof j.artifactTxtS3Key === 'string' && j.artifactTxtS3Key.length > 0 && !candidates.has(j.version)) {
        candidates.set(j.version, j.artifactTxtS3Key);
      }
    }
    const versionsDesc = Array.from(candidates.keys()).sort((a, b) => b - a);
    for (const version of versionsDesc) {
      const txtKey = candidates.get(version) as string;
      if (await headObjectExists(s3(), bucket() as string, txtKey)) return { version, txtKey };
    }
    return null;
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
      if (cur === null) throw new HttpError(404, 'not_found', 'No letter has been drafted for this case yet.', { reason: 'no_letter', caseId });
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
      const baseName = letterFilename(vet?.lastName, vet?.firstName, c.claimedCondition, cur.version);
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
      // Optimistic concurrency: the editor must be saving against the version it loaded.
      if (baseVersion !== c.currentVersion) {
        throw new HttpError(409, 'conflict', `base_version ${baseVersion} is stale; current is v${c.currentVersion}. Reload and reapply your edits.`, { reason: 'stale_version', caseId, currentVersion: c.currentVersion });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });

      const oldText = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });
      const cleaned = cleanProseForSave(body.txt);
      const warnings: SanityFinding[] = sanityCheckLetterText(oldText, cleaned);

      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });

      // G4: does a SignOff bind to the version we are about to edit over? (signedVersion is null
      // on legacy sign-offs predating byte-binding — those carry no hash, nothing goes stale.)
      const staleSignOff = (await db.signOff.findFirst({ where: { caseId, signedVersion: c.currentVersion } })) ?? null;
      const stale = staleSignOff !== null ? staleSignOffOutcome(c.status) : null;

      const newVersion = c.currentVersion + 1;
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

      try {
        await db.$transaction(async (tx) => {
          await tx.letterRevision.create({
            data: {
              caseId,
              version: newVersion,
              parentVersion: c.currentVersion,
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
                detailsJson: { staleSignedVersion: c.currentVersion, newVersion, fromStatus: c.status, source: 'editor_save' },
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

      // Return the canonical saved text — cleanProseForSave may have altered it (em dashes →
      // commas, smart quotes, etc.), so the editor must re-sync to what was actually stored.
      // notice (G4): non-null when this save went over a signed version — the UI surfaces it so
      // the editor learns at save time (not delivery time) that the doctor must re-sign.
      res.json({ data: { version: newVersion, txt: cleaned, rendered: { pdf: rendered.ok, docx: rendered.ok }, warnings, notice: stale?.notice ?? null } });
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
      const body = (req.body ?? {}) as { instruction?: unknown; apply?: unknown; proposal?: EditProposal; mode?: unknown; passage?: unknown };
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
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });
      const oldText = await readTxtFromS3(bucketName, cur.txtKey, { caseId, version: cur.version });

      // ── APPLY a previewed proposal (deterministic, no LLM) ──
      if (body.apply === true) {
        if (body.proposal === undefined) throw new HttpError(400, 'bad_request', 'apply:true requires proposal', { caseId });
        const applied = applyStructuredEdit(oldText, body.proposal);
        if (!applied.ok) throw new HttpError(422, 'conflict', `surgical edit no longer applies: ${applied.error}`, { reason: 'edit_unappliable', caseId });
        // §VII HOLDING LOCK at APPLY (defense-in-depth, Guided Revision 2026-06-13): the holding can
        // never change through ANY structured-edit door, even a hand-crafted apply payload that
        // bypassed the propose-time guard. Cheap deterministic re-check on the would-be letter.
        if (holdingChanged(oldText, applied.newText)) {
          throw new HttpError(422, 'conflict', 'This edit would alter the Section VII opinion / legal holding, which is locked. Edit cannot be applied.', { reason: 'holding_changed', caseId });
        }
        const warnings: SanityFinding[] = sanityCheckLetterText(oldText, applied.newText);
        const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
        if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });
        // G4: same stale-signature detection as the PUT save — the surgical-AI door must not be
        // a way around the re-sign rule (the edit still creates version N+1 over signed version N).
        const staleSignOff = (await db.signOff.findFirst({ where: { caseId, signedVersion: c.currentVersion } })) ?? null;
        const stale = staleSignOff !== null ? staleSignOffOutcome(c.status) : null;
        const newVersion = c.currentVersion + 1;
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
        try {
          await db.$transaction(async (tx) => {
            await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: c.currentVersion, source: 'surgical_ai', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: warnings } });
            // G4: stale-signature edit on a delivered case returns it to physician_review in-transaction.
            await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 }, ...(stale?.returnToPhysicianReview ? { status: 'physician_review' } : {}) } });
            await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_surgical_ai_applied', caseId, veteranId: c.veteranId, detailsJson: { version: newVersion, anchor_fallback: applied.anchor_fallback, warnings: warnings.map((w) => w.rule) } } });
            if (stale !== null) {
              await tx.activityLog.create({ data: { actorUserId: user.sub, action: stale.logAction, caseId, veteranId: c.veteranId, detailsJson: { staleSignedVersion: c.currentVersion, newVersion, fromStatus: c.status, source: 'surgical_ai' } } });
            }
          });
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another save advanced the version; reload and re-propose.', { reason: 'concurrent_save', caseId });
          throw e;
        }
        res.json({ data: { version: newVersion, txt: applied.newText, warnings, notice: stale?.notice ?? null } });
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

        const out = await deps.proposeSurgicalEdit({ instruction: body.instruction, letterText: oldText, mode: 'guided_revision', passage });
        // The proposer pins anchor_text=passage + operation=replace; dry-run so we preview a
        // deterministically-appliable edit and so all downstream guards see the EXACT revised letter.
        const dry = applyStructuredEdit(oldText, out.proposal);

        // CITATION-INTEGRITY GUARD (the key new safety): diff the cited facts of the highlighted
        // passage (before) vs the model's revised passage (after = out.proposal.new_text). A NET-NEW
        // citation/stat => REJECT (the model invented a fact to prop up a reworded argument). A
        // DROPPED citation/stat => return WITH a warning the physician must see before accepting.
        const citationDiff: CitationDiff = diffCitations(passage, out.proposal.new_text);

        // §VII HOLDING LOCK: even if the highlighted passage overlaps Section VII, the legal holding
        // ("at least as likely as not" / CFR cite) can NEVER change. Computed on the would-be letter.
        const holdingWouldChange = dry.ok ? holdingChanged(oldText, dry.newText) : false;

        // Log the propose (cost recorded here — the spend happens at propose, like surgical).
        await db.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_guided_revision_proposed', caseId, veteranId: c.veteranId, detailsJson: { instruction: body.instruction.slice(0, 500), model: out.model, costUsd: out.costUsd, appliable: dry.ok, addedCitations: citationDiff.added.length, removedCitations: citationDiff.removed.length, holdingWouldChange } } });

        // REJECTIONS (medico-legal, bias to BLOCK) — never return an applyable proposal:
        //  1) the model invented a citation/stat;
        //  2) the revision would change the §VII holding;
        //  3) the edit does not deterministically apply.
        if (citationDiff.added.length > 0) {
          res.status(422).json({ error: { code: 'conflict', message: `Guided revision rejected: the revised passage introduces ${citationDiff.added.length} citation/statistic not present in the original (${citationDiff.added.map(describeToken).join(', ')}). A revision may reword prose around the cited facts but must never add a new citation or statistic.`, details: { reason: 'citation_invented', caseId, proposal: out.proposal, citationDiff, costUsd: out.costUsd } } });
          return;
        }
        if (holdingWouldChange) {
          res.status(422).json({ error: { code: 'conflict', message: 'Guided revision rejected: the revision would alter the Section VII opinion / legal holding. The holding is locked and cannot be changed by an edit.', details: { reason: 'holding_changed', caseId, proposal: out.proposal, costUsd: out.costUsd } } });
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
      const out = await deps.proposeSurgicalEdit({ instruction: body.instruction, letterText: oldText });
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
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to approve.', { reason: 'no_letter', caseId });
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

      const newVersion = c.currentVersion + 1;
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

      // Substitute any signer sentinels with the assigned signer's rendered blocks (no-op on the
      // legacy hardcoded-credential letters). Pronoun defaults to "their" (gender-neutral; no
      // veteran-pronoun field exists yet) and is irrelevant to no-sentinel letters.
      const finalText = substituteSignerSentinels(text, signerCreds, 'their');

      // Positive identity check: the assigned signer's credentialed name must appear (whole-name).
      if (!signerNameAppears(finalText, signerCreds.fullNameWithCredential)) {
        throw new HttpError(409, 'conflict', `Cannot approve: the letter does not name the assigned signing physician (${signerCreds.fullNameWithCredential}). Regenerate or correct the letter so it is authored under the assigned physician, then approve.`, { reason: 'signer_name_absent', caseId, physicianId: signer.id });
      }
      // Anti-fraud: no OTHER known physician's credentialed name may appear in the letter body.
      const roster = await db.physician.findMany({ where: { active: true } });
      const rosterNames = roster
        .map((p) => parseCredentialBlock(p.credentialBlockJson)?.fullNameWithCredential)
        .filter((n): n is string => typeof n === 'string');
      const foreign = findForeignSignerNames(finalText, rosterNames, signerCreds.fullNameWithCredential);
      if (foreign.length > 0) {
        throw new HttpError(409, 'conflict', `Cannot approve: the letter names ${foreign.join(', ')} but the assigned signing physician is ${signerCreds.fullNameWithCredential}. A letter must be signed by the physician it is authored under. Reassign the case to the named physician or regenerate the letter, then approve.`, { reason: 'foreign_signer_name', caseId, physicianId: signer.id, foreignNames: foreign });
      }
      // Fail closed: an unresolved signer sentinel must never reach the renderer / S3.
      if (finalText.includes('[[SIGNER_')) {
        throw new HttpError(502, 'internal_error', 'Refusing to render: an unresolved signer sentinel survived substitution.', { reason: 'signer_sentinel_unresolved', caseId });
      }

      // Render FINAL (no DRAFT watermark) at the new version.
      const rendered = await deps.renderLetter({ caseData: { ...caseData, signer_name: signerCreds.fullNameWithCredential, signature_image_s3_key: signatureKey }, letterText: finalText, version: newVersion, draft: false, bucket: bucketName, keys });
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
          await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: c.currentVersion, source: 'approved_final', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: null, letterType: 'nexus_letter', signingPhysicianId: signer.id, payCents: resolveRateCents('nexus_letter') } });
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
      if (user.role === 'physician') {
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

  return router;
}
