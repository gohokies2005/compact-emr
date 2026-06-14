import { Router, type Request, type Response } from 'express';
import { type S3Client } from '@aws-sdk/client-s3';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { parseSignOffCreate, isSignOffAffirmative } from '../services/sign-off-validation.js';
import { resolveCurrentPhysician } from '../services/physician-resolver.js';
import { currentActor } from '../services/request-actor.js';
import { loadReconciledChartReadiness, buildChartNotReadyMessage, originalFileName } from '../services/chart-readiness.js';
import { resolveOverrideReason } from '../services/chart-readiness-override.js';
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

      // Chart-readiness machine-read gate (Phase 5.2): no sign-off until every uploaded file is
      // read or has a manual summary — UNLESS a physician/admin explicitly overrides because they
      // have personally reviewed the unread records (CLM-4DACAF4A80, 2026-06-14; "everything must be
      // overridable" HARD RULE). The override is scoped to THIS machine-read gate only; the
      // affirmative-attestation gate above (all five answers "Yes") is the separate legal gate and is
      // NOT weakened — the physician still attests "I reviewed all uploaded records and the chart"=Yes,
      // which is the legal predicate for overriding.
      // RECONCILED readiness (CLM-4DACAF4A80, 2026-06-14): drop orphaned rows (a readiness row whose
      // file is no longer in the chart's documents) so the gate matches what GET /chart-readiness shows
      // the UI — an invisible orphan must never hard-block sign-off. Shared single source of truth.
      const readiness = await loadReconciledChartReadiness(db, caseId);
      const overrideReason = resolveOverrideReason(
        req.body?.overrideChartReadiness as boolean | undefined,
        req.body?.chartReadinessOverrideReason as string | undefined,
        user.role,
      );
      const chartReadinessOverridden = !readiness.ready && overrideReason !== null;
      if (!readiness.ready && !chartReadinessOverridden) {
        // No valid override (not requested, blank reason, or non-signing role) → keep the gate closed,
        // but DESCRIPTIVE: name each blocking file + the machine-read reason so the physician knows
        // what to review/summarize. The structured blockingFiles stay in details (the frontend renders
        // the override control from them).
        throw new HttpError(409, 'chart_not_ready', buildChartNotReadyMessage(readiness.blockingFiles, 'Sign-off'), {
          caseId,
          totalFiles: readiness.totalFiles,
          blockingFiles: readiness.blockingFiles,
          gateVersion: readiness.gateVersion,
          overridable: true,
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

      // Audit snapshot of the blocking files AS THEY WERE at override time (display name + reason) —
      // stored on the row + logged, never recomputed. Empty/null when not overriding.
      const overrideFileSnapshot = chartReadinessOverridden
        ? readiness.blockingFiles.map((b) => ({ filePath: b.filePath, terminalStatus: b.terminalStatus, note: b.lastAttempt?.note ?? null }))
        : null;

      const created = await db.$transaction(async (tx) => {
        const row = await tx.signOff.create({
          data: {
            caseId,
            physicianId,
            answersJson: parsed.answers,
            notes: parsed.notes,
            signedVersion,
            signedContentSha256,
            chartReadinessOverridden,
            chartReadinessOverrideReason: chartReadinessOverridden ? overrideReason : null,
            chartReadinessOverrideFiles: overrideFileSnapshot,
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: user.sub,
            // A chart-readiness override is a distinct, audit-significant act — log it under its own
            // action with the file names, notes, and the physician's reason so the override is fully
            // traceable (who overrode the machine-read gate on which unread files, and why).
            action: chartReadinessOverridden ? 'case_signed_off_chart_readiness_overridden' : 'case_signed_off',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: chartReadinessOverridden
              ? {
                  caseId,
                  physicianId,
                  signOffId: row.id,
                  answerKeys: Object.keys(parsed.answers),
                  chartReadinessOverride: {
                    reason: overrideReason,
                    files: (overrideFileSnapshot ?? []).map((f) => ({ name: originalFileName(f.filePath), note: f.note })),
                  },
                }
              : { caseId, physicianId, signOffId: row.id, answerKeys: Object.keys(parsed.answers) },
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
