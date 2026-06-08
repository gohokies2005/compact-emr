import { Router, type Request, type Response } from 'express';
import { type S3Client } from '@aws-sdk/client-s3';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { parseSignOffCreate, isSignOffAffirmative } from '../services/sign-off-validation.js';
import { resolveCurrentPhysician } from '../services/physician-resolver.js';
import { currentActor } from '../services/request-actor.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import { resolveCurrentTxtWithHash } from '../services/letter-current.js';
import type { AppDb } from '../services/db-types.js';

export interface SignOffsRouterDeps {
  s3?: S3Client;
  bucketName?: string;
}

export function createSignOffsRouter(db: AppDb, deps: SignOffsRouterDeps = {}): Router {
  const router = Router();
  const s3 = (): S3Client | undefined => deps.s3;
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  /**
   * POST /api/v1/cases/:id/sign-off
   *
   * Only an assigned physician (or admin acting in their stead) can sign off a case. Records
   * the physician's answers + signature timestamp. Multiple sign-offs per case are allowed —
   * the latest by signedAt is the active sign-off. Each sign-off writes an activity row.
   *
   * Status transition (e.g. physician_review -> delivered) is a SEPARATE call; this endpoint
   * records the sign-off act itself, not the workflow advancement.
   */
  router.post(
    '/cases/:id/sign-off',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);
      const parsed = parseSignOffCreate(req.body);

      const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, veteranId: true, assignedPhysicianId: true, currentVersion: true } });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // Affirmativeness gate (audit 2026-06-07): a sign-off ATTESTS the letter is ready — every item must
      // be "Yes". A "No" means resolve it or send the case back to the RN; you cannot sign off against it.
      if (!isSignOffAffirmative(parsed.answers)) {
        throw new HttpError(409, 'conflict', 'Sign-off requires every item to be "Yes". Resolve the flagged item, or send the case back to the RN instead.', { reason: 'sign_off_not_affirmative', caseId });
      }

      // OCR HARD-STOP gate (Phase 5.2): no sign-off until every uploaded file is read or has
      // a manual summary. Unbypassable — no admin override per Ryan's HARD RULE.
      const fileRows = await db.fileReadStatus.findMany({ where: { caseId } });
      const readiness = evaluateChartReadiness(fileRows);
      if (!readiness.ready) {
        throw new HttpError(409, 'chart_not_ready', 'Sign-off blocked: chart-readiness gate failed.', {
          caseId,
          totalFiles: readiness.totalFiles,
          blockingFiles: readiness.blockingFiles,
          gateVersion: readiness.gateVersion,
        });
      }

      // Resolve the physician issuing the sign-off. Admin can sign on behalf when no physician
      // is assigned (rare) — otherwise the resolver must produce a real physician identity.
      let physicianId: string;
      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null) {
          throw new HttpError(403, 'forbidden', 'Physician has no active Physician record mapping.', { caseId });
        }
        if (c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
        physicianId = physician.id;
      } else {
        // admin: case must have an assigned physician to attribute the sign-off to
        if (c.assignedPhysicianId === null) {
          throw new HttpError(409, 'conflict', 'Case has no assigned physician; assign one before sign-off.', { caseId });
        }
        physicianId = c.assignedPhysicianId;
      }

      // Byte-binding (#9 Fix 3): resolve the CURRENT version's TXT (the deterministic source of
      // truth) and bind this sign-off to sha256(TXT) + the version. The delivery gate re-hashes the
      // current TXT and 409s if it changed after sign-off, so any later edit/approve blocks delivery
      // until the letter is re-signed. Best-effort: if S3 isn't configured (local dev) or no letter is
      // resolvable, store nulls — the delivery gate treats a null hash as "no byte check" (back-compat).
      let signedVersion: number | null = null;
      let signedContentSha256: string | null = null;
      const bucketName = bucket();
      const s3Client = s3();
      if (s3Client !== undefined && bucketName !== undefined) {
        const cur = await resolveCurrentTxtWithHash(db, s3Client, bucketName, caseId, c.currentVersion);
        if (cur !== null) {
          signedVersion = cur.version;
          signedContentSha256 = cur.sha256;
        }
      }

      const created = await db.$transaction(async (tx) => {
        const row = await tx.signOff.create({
          data: {
            caseId,
            physicianId,
            answersJson: parsed.answers,
            notes: parsed.notes,
            signedVersion,
            signedContentSha256,
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: user.sub,
            action: 'case_signed_off',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: { caseId, physicianId, signOffId: row.id, answerKeys: Object.keys(parsed.answers) },
          },
        });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  /**
   * GET /api/v1/cases/:id/sign-offs
   *
   * Lists sign-off events for a case, newest first. Read access mirrors the existing
   * staff/assigned-physician contract used by other case-scoped reads.
   */
  router.get(
    '/cases/:id/sign-offs',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const caseId = String(req.params.id);

      // For physicians, gate on assignment to match the rest of /cases/:id-style endpoints.
      if (user.role === 'physician') {
        const c = await db.case.findFirst({ where: { id: caseId }, select: { id: true, assignedPhysicianId: true } });
        if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null || c.assignedPhysicianId !== physician.id) {
          throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId });
        }
      }

      const rows = await db.signOff.findMany({ where: { caseId }, orderBy: { signedAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  return router;
}
