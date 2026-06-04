import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';
import { buildLetterRevisionKey } from '../services/s3-key-safety.js';
import { cleanProseForSave, sanityCheckLetterText, computeLockedRanges, type SanityFinding } from '../services/letter-sanity.js';
import { applyStructuredEdit, type EditProposal } from '../services/letter-edit-apply.js';
import { isValidCaseStatusTransition, canRolePerformCaseStatusTransition } from '../services/case-status-transitions.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
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
// the editor is read-only.
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['drafting', 'physician_review', 'correction_review']);

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
export interface SurgicalProposeInput { instruction: string; letterText: string; }
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

export function createLetterRouter(db: AppDb, deps: LetterRouterDeps): Router {
  const router = Router();
  const s3 = (): S3Client => deps.s3 ?? new S3Client({});
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // Resolve the current letter's artifacts strictly by Case.currentVersion (the single
  // source of truth). Prefer the unified LetterRevision row; fall back to the DraftJob row
  // for drafted-but-pre-mirror cases. Both are keyed to the SAME version.
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

  async function enforcePhysicianAssignment(caseId: string, role: string, sub: string, assignedPhysicianId: string | null): Promise<void> {
    if (role === 'physician' && !(await isAssignedPhysicianForCase(db, sub, assignedPhysicianId))) {
      throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
    }
  }

  async function readTxtFromS3(bucketName: string, key: string): Promise<string> {
    const obj = await s3().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (obj.Body === undefined) throw new HttpError(502, 'internal_error', 'Letter TXT object had no body.', { reason: 'read_failed', key });
    return obj.Body.transformToString('utf-8');
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

      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(404, 'not_found', 'No letter has been drafted for this case yet.', { reason: 'no_letter', caseId });

      const txt = await readTxtFromS3(bucketName, cur.txtKey);
      const client = s3();
      const pdfUrl = cur.pdfKey !== null
        ? await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName, Key: cur.pdfKey }), { expiresIn: PRESIGN_TTL_SECONDS })
        : null;
      const docxUrl = cur.docxKey !== null
        ? await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName, Key: cur.docxKey }), { expiresIn: PRESIGN_TTL_SECONDS })
        : null;

      res.json({
        data: {
          version: cur.version,
          txt,
          locked_ranges: computeLockedRanges(txt),
          rendered: { pdfUrl, docxUrl },
          role: user.role,
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
      // Optimistic concurrency: the editor must be saving against the version it loaded.
      if (baseVersion !== c.currentVersion) {
        throw new HttpError(409, 'conflict', `base_version ${baseVersion} is stale; current is v${c.currentVersion}. Reload and reapply your edits.`, { reason: 'stale_version', caseId, currentVersion: c.currentVersion });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });

      const oldText = await readTxtFromS3(bucketName, cur.txtKey);
      const cleaned = cleanProseForSave(body.txt);
      const warnings: SanityFinding[] = sanityCheckLetterText(oldText, cleaned);

      const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
      if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });

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
          await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 } } });
          await tx.activityLog.create({
            data: {
              actorUserId: user.sub,
              action: 'letter_saved',
              caseId,
              veteranId: c.veteranId,
              detailsJson: { version: newVersion, source: 'editor_save', warnings: warnings.map((w) => w.rule) },
            },
          });
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
      res.json({ data: { version: newVersion, txt: cleaned, rendered: { pdf: rendered.ok, docx: rendered.ok }, warnings } });
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
      const body = (req.body ?? {}) as { instruction?: unknown; apply?: unknown; proposal?: EditProposal };

      const c = await db.case.findFirst({ where: { id: caseId } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      await enforcePhysicianAssignment(caseId, user.role, user.sub, c.assignedPhysicianId);
      if (!EDITABLE_STATUSES.has(c.status)) throw new HttpError(409, 'conflict', `Letter is not editable in status '${c.status}'.`, { reason: 'not_editable', caseId, status: c.status });

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to edit.', { reason: 'no_letter', caseId });
      const oldText = await readTxtFromS3(bucketName, cur.txtKey);

      // ── APPLY a previewed proposal (deterministic, no LLM) ──
      if (body.apply === true) {
        if (body.proposal === undefined) throw new HttpError(400, 'bad_request', 'apply:true requires proposal', { caseId });
        const applied = applyStructuredEdit(oldText, body.proposal);
        if (!applied.ok) throw new HttpError(422, 'conflict', `surgical edit no longer applies: ${applied.error}`, { reason: 'edit_unappliable', caseId });
        const warnings: SanityFinding[] = sanityCheckLetterText(oldText, applied.newText);
        const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
        if (veteran === null) throw new HttpError(409, 'conflict', 'Veteran not found for case.', { caseId });
        const newVersion = c.currentVersion + 1;
        const keys = {
          txtKey: buildLetterRevisionKey(caseId, newVersion, 'txt'),
          pdfKey: buildLetterRevisionKey(caseId, newVersion, 'pdf'),
          docxKey: buildLetterRevisionKey(caseId, newVersion, 'docx'),
        };
        const caseData = { id: caseId, veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(), veteran_last: veteran.lastName, claimed_condition: c.claimedCondition };
        const rendered = await deps.renderLetter({ caseData, letterText: applied.newText, version: newVersion, draft: true, bucket: bucketName, keys });
        if (!rendered.ok) throw new HttpError(502, 'internal_error', 'Render failed; nothing saved.', { reason: 'render_failed', caseId });
        try {
          await db.$transaction(async (tx) => {
            await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: c.currentVersion, source: 'surgical_ai', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: warnings } });
            await tx.case.update({ where: { id: caseId }, data: { currentVersion: newVersion, version: { increment: 1 } } });
            await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_surgical_ai_applied', caseId, veteranId: c.veteranId, detailsJson: { version: newVersion, anchor_fallback: applied.anchor_fallback, warnings: warnings.map((w) => w.rule) } } });
          });
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'conflict', 'Another save advanced the version; reload and re-propose.', { reason: 'concurrent_save', caseId });
          throw e;
        }
        res.json({ data: { version: newVersion, txt: applied.newText, warnings } });
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
      // Chart-readiness gate (unbypassable — mirrors sign-offs.ts).
      const readiness = evaluateChartReadiness(await db.fileReadStatus.findMany({ where: { caseId } }));
      if (!readiness.ready) throw new HttpError(409, 'chart_not_ready', 'Approve blocked: chart-readiness gate failed.', { caseId, blockingFiles: readiness.blockingFiles });
      // A formal sign-off must already exist (recorded via POST /cases/:id/sign-off). Approve
      // finalizes; it does not replace the sign-off questionnaire.
      const signOffs = await db.signOff.findMany({ where: { caseId } });
      if (signOffs.length === 0) throw new HttpError(409, 'conflict', 'Record the physician sign-off before approving.', { reason: 'sign_off_required', caseId });
      // Status transition must be legal + role-permitted (physician_review → delivered).
      if (!isValidCaseStatusTransition(c.status, 'delivered') || !canRolePerformCaseStatusTransition(user.role, c.status, 'delivered')) {
        throw new HttpError(409, 'conflict', `Cannot approve from status '${c.status}'.`, { reason: 'bad_transition', caseId, status: c.status });
      }

      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured', { caseId });
      const cur = await resolveCurrent(caseId, c.currentVersion);
      if (cur === null) throw new HttpError(409, 'conflict', 'No current letter to approve.', { reason: 'no_letter', caseId });
      const text = await readTxtFromS3(bucketName, cur.txtKey);

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

      try {
        await db.$transaction(async (tx) => {
          await tx.letterRevision.create({ data: { caseId, version: newVersion, parentVersion: c.currentVersion, source: 'approved_final', artifactTxtS3Key: keys.txtKey, artifactPdfS3Key: keys.pdfKey, artifactDocxS3Key: keys.docxKey, editedBy: user.sub, editorRole: user.role, sanityJson: null } });
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

      await db.$transaction(async (tx) => {
        // operatorMessage is the existing RN-facing channel (rendered in the ops UI).
        await tx.case.update({ where: { id: caseId }, data: { status: 'correction_requested', operatorMessage: body.reason as string, version: { increment: 1 } } });
        await tx.activityLog.create({ data: { actorUserId: user.sub, action: 'letter_declined', caseId, veteranId: c.veteranId, detailsJson: { reason: (body.reason as string).slice(0, 1000) } } });
      });
      res.json({ data: { status: 'correction_requested' } });
    }),
  );

  return router;
}
