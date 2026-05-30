import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { isAssignedPhysicianForCase } from '../services/physician-resolver.js';
import { buildLetterRevisionKey } from '../services/s3-key-safety.js';
import { cleanProseForSave, sanityCheckLetterText, computeLockedRanges, type SanityFinding } from '../services/letter-sanity.js';
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
  caseData: { id: string; veteran_name: string; veteran_last: string; claimed_condition: string };
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

export interface LetterRouterDeps {
  renderLetter: RenderInvoker;
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

      res.json({ data: { version: newVersion, rendered: { pdf: rendered.ok, docx: rendered.ok }, warnings } });
    }),
  );

  return router;
}
