import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, CaseStatus, Role } from '../services/db-types.js';
import {
  parseAssignPhysician,
  parseAssignRn,
  parseCaseCreate,
  parseCasePatch,
  parseStatusTransition,
} from '../services/case-validation.js';
import {
  canRolePerformCaseStatusTransition,
  isCaseStatus,
  isValidCaseStatusTransition,
  requiredRolesForCaseStatusTransition,
} from '../services/case-status-transitions.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';
import { currentActor, type RequestActor } from '../services/request-actor.js';
import { computeApproveBlockers, type ApproveBlocker, type ApproveBlockerDeps } from '../services/approve-blockers.js';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';

const CASE_LITE_SELECT = {
  id: true,
  veteranId: true,
  claimedCondition: true,
  claimType: true,
  status: true,
  version: true,
  currentVersion: true,
  assignedPhysicianId: true,
  assignedRnId: true,
  refundEligible: true,
  quickNote: true,
  quickNoteBy: true,
  quickNoteAt: true,
  createdAt: true,
  updatedAt: true,
  veteran: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  assignedPhysician: {
    select: {
      id: true,
      fullName: true,
      email: true,
    },
  },
  assignedRn: {
    select: {
      id: true,
      email: true,
      name: true, // friendly display name for the Cases RN column (falls back to email client-side)
    },
  },
  // RECORDS signal (binary): does the case have >=1 veteran-UPLOADED document, EXCLUDING the
  // two auto-generated docs? A filtered relation count (Prisma >=4.3; installed 6.19.x) is the
  // cleanest + EXACT read — it adds no rows to the payload and is NOT bounded by a take:N window,
  // so the yes/no is reliable regardless of how many docs a case has. We exclude:
  //   - the generated intake summary — s3Key ENDS with 'Intake_Summary.pdf' (canonical generated
  //     key `cases/<id>/<uuid>-Intake_Summary.pdf`; mirrors isIntakeSummaryPath's `intake_summary\.pdf$`)
  //   - the auto-assembled physician Doctor Pack — s3Key CONTAINS 'Doctor_Pack' or 'DoctorPack'
  // recordsUploaded (below) = recordCount > 0.
  _count: {
    select: {
      documents: {
        where: {
          NOT: [
            { s3Key: { endsWith: 'Intake_Summary.pdf' } },
            { s3Key: { contains: 'Doctor_Pack' } },
            { s3Key: { contains: 'DoctorPack' } },
          ],
        },
      },
    },
  },
};

/**
 * Map a CASE_LITE_SELECT row to the list-item DTO: lift the filtered real-record count (the
 * `_count.documents` from the filtered relation count) to a top-level `recordCount` and a binary
 * `recordsUploaded`, and drop the internal `_count` from the wire shape. So a list item is exactly
 * { ...case, recordCount, recordsUploaded }. Accepts the loosely-typed Prisma-select result.
 */
function withRecordsSignal(row: Record<string, unknown>): Record<string, unknown> {
  const { _count, ...rest } = row;
  const count = (_count as { documents?: number } | undefined)?.documents;
  const recordCount = typeof count === 'number' ? count : 0;
  return { ...rest, recordCount, recordsUploaded: recordCount > 0 };
}

/**
 * Phase 5.1: extracted to `services/request-actor.ts`. Local alias preserved so call sites
 * inside this file (`const user = currentUser(req)`) stay readable.
 */
const currentUser: (req: Request) => RequestActor = currentActor;

function parsePositiveQueryInt(value: unknown, defaultValue: number, maxValue: number): number {
  if (typeof value !== 'string') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseOptionalCaseStatus(value: unknown): CaseStatus | undefined {
  if (typeof value !== 'string') return undefined;
  // Validate against the canonical CASE_STATUSES list. A hand-copied allow-list here silently
  // drifted from the enum (missing rn_review + the two Gate-2 halt statuses), so the Cases
  // dropdown 400'd on options it offered.
  if (!isCaseStatus(value)) {
    throw new HttpError(400, 'bad_request', 'status filter is invalid', { field: 'status' });
  }
  return value;
}

function optionalStringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildCaseListWhere(query: Request['query']): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const status = parseOptionalCaseStatus(query.status);
  const claimType = optionalStringQuery(query.claimType);
  const veteranId = optionalStringQuery(query.veteranId);
  const assignedPhysicianId = optionalStringQuery(query.assignedPhysicianId);
  const assignedRnId = optionalStringQuery(query.assignedRnId);

  if (status !== undefined) where.status = status;
  if (claimType !== undefined) where.claimType = claimType;
  if (veteranId !== undefined) where.veteranId = veteranId;
  // '__none__' is the admin-triage sentinel for "unassigned" — a shippable-but-unassigned case
  // must never silently vanish from every queue (RN-self-service: always reachable).
  if (assignedPhysicianId === '__none__') where.assignedPhysicianId = null;
  else if (assignedPhysicianId !== undefined) where.assignedPhysicianId = assignedPhysicianId;
  // assignedRnId accepts a single AppUser id (legacy callers — unchanged equality), the '__none__'
  // sentinel (unassigned), or a COMMA-SEPARATED mix of ids and/or '__none__' (the Cases-page RN
  // multi-select). Combining stays inside this ONE where so the list query + count remain a single
  // server-paginated pair — a client-side union would make `total`/page counts lie.
  if (assignedRnId !== undefined) {
    const tokens = assignedRnId.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    const wantsUnassigned = tokens.includes('__none__');
    const ids = tokens.filter((t) => t !== '__none__');
    if (wantsUnassigned && ids.length > 0) where.OR = [{ assignedRnId: { in: ids } }, { assignedRnId: null }];
    else if (wantsUnassigned) where.assignedRnId = null;
    else if (ids.length === 1) where.assignedRnId = ids[0];
    else if (ids.length > 1) where.assignedRnId = { in: ids };
  }

  // Soft-archive: default views EXCLUDE archived cases; `?archived=true` shows only the archive.
  if (optionalStringQuery(query.archived) === 'true') where.archivedAt = { not: null };
  else where.archivedAt = null;

  // NOTE (Ryan 2026-06-04): the old ship/runComplete read-filter on physician_review was removed.
  // Completed drafts no longer auto-route to the doctor — they land in 'rn_review' and reach
  // physician_review ONLY when the RN explicitly clicks "Send to doctor for review". That deliberate
  // human send is the gate, so a case in physician_review is legitimately the RN's choice even if
  // the grader flagged it 'revise' (the RN may have edited it). Filtering those out would hide
  // RN-sent letters from the doctor's queue, so the physician inbox now shows ALL physician_review.

  return where;
}

/**
 * Allow access when the caller has one of `staffRoles` (admin / ops_staff)
 * OR is a physician resolving to the Physician row assigned to the URL case.
 *
 * Wired Phase 5 (2026-05-25): physicians get self-access to their assigned cases
 * for read/patch/draft-jobs/corrections. Status transitions stay under
 * `roleGuardForStatusTransition` which adds its own assigned-physician check.
 */
function requireStaffOrAssignedPhysician(db: AppDb, staffRoles: readonly Role[]) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if ((staffRoles as readonly Role[]).includes(user.role)) return next();
    if (user.role !== 'physician') {
      throw new HttpError(403, 'forbidden', 'This route is not available for your role.', {
        requiredRoles: [...staffRoles, 'physician (assigned)'],
      });
    }

    const id = String(req.params.id);
    const c = await db.case.findFirst({ where: { id }, select: { id: true, assignedPhysicianId: true } });
    if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

    const ok = await isAssignedPhysicianForCase(db, user.sub, c.assignedPhysicianId);
    if (!ok) {
      throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId: id });
    }

    next();
  });
}

function roleGuardForStatusTransition(db: AppDb) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const user = currentUser(req);
    const parsed = parseStatusTransition(req.body);

    const current = await db.case.findFirst({
      where: { id },
      select: { id: true, status: true, assignedPhysicianId: true },
    });
    if (current === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

    const allowed = canRolePerformCaseStatusTransition(user.role, current.status, parsed.to);
    if (!allowed) {
      throw new HttpError(403, 'forbidden', 'Role cannot perform this case status transition', {
        requiredRoles: requiredRolesForCaseStatusTransition(current.status, parsed.to),
      });
    }

    // Enforce assigned-physician ONLY when a physician IS assigned. An UNASSIGNED case in
    // physician_review (legacy, or claimed from the queue) must still be actionable by the reviewing
    // physician — otherwise the letter is stuck with nobody able to send it back. (Ryan 2026-06-06.)
    if (user.role === 'physician' && current.assignedPhysicianId) {
      const isAssigned = await isAssignedPhysicianForCase(db, user.sub, current.assignedPhysicianId);
      if (!isAssigned) {
        throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId: id });
      }
    }

    // Don't send a letter "to the doctor" when no doctor is assigned (Ryan 2026-06-06). The
    // rn_review -> physician_review hand-off requires an assigned physician on the case.
    if (current.status === 'rn_review' && parsed.to === 'physician_review' && !current.assignedPhysicianId) {
      throw new HttpError(409, 'conflict', 'Assign a physician to this case before sending it for review.', { caseId: id, reason: 'no_physician_assigned' });
    }

    next();
  });
}

// deps carries S3 (+ bucket) ONLY for the advisory approve-blocker pre-flight on GET /cases/:id
// (the signer-name check reads the current letter TXT). Optional: when absent the text-dependent
// checks are skipped and everything else still works (fail-open).
export function createCasesRouter(db: AppDb, deps: ApproveBlockerDeps = {}): Router {
  const router = Router();


  router.get(
    '/cases',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const page = parsePositiveQueryInt(req.query.page, 1, 100000);
      const pageSize = parsePositiveQueryInt(req.query.pageSize, 25, 100);
      const skip = (page - 1) * pageSize;
      const where = buildCaseListWhere(req.query);

      if (user.role === 'physician') {
        const physician = await resolveCurrentPhysician(db, user.sub);
        if (physician === null) {
          // Physician account exists in Cognito but has no Physician row mapping yet.
          res.json({ data: [], page, pageSize, total: 0 });
          return;
        }
        where.assignedPhysicianId = physician.id;
      }

      const [total, cases] = await db.$transaction(async (tx) => {
        const count = await tx.case.count({ where });
        const rows = await tx.case.findMany({
          where,
          select: CASE_LITE_SELECT,
          orderBy: { updatedAt: 'desc' },
          skip,
          take: pageSize,
        });
        return [count, rows] as const;
      });

      res.json({ data: cases.map((c) => withRecordsSignal(c as unknown as Record<string, unknown>)), page, pageSize, total });
    }),
  );

  router.get(
    '/cases/:id',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const found = await db.case.findFirst({
        where: { id },
        include: {
          veteran: { select: { id: true, firstName: true, lastName: true, email: true, dob: true, phone: true, address: true, branch: true, serviceStartYear: true, serviceEndYear: true, heightIn: true, weightLb: true, combatVeteran: true } },
          assignedPhysician: { select: { id: true, fullName: true, email: true } },
          assignedRn: { select: { id: true, email: true, name: true } },
          documents: { orderBy: { uploadedAt: 'desc' }, take: 5 },
          draftJobs: { orderBy: { enqueuedAt: 'desc' }, take: 5 },
          corrections: { orderBy: { requestedAt: 'desc' }, take: 5 },
          // Order by createdAt (always non-null) — NOT sentAt: inbound emails (Feature B) leave sentAt
          // NULL and Postgres NULLS-FIRST on DESC would float them above all outbound. createdAt ≈ when
          // we recorded the message and is the single effective-timestamp sort used by the email log. (C1)
          emails: { orderBy: { createdAt: 'desc' }, take: 5 },
          payments: { orderBy: { createdAt: 'desc' } },
          _count: { select: { documents: true, draftJobs: true, corrections: true, emails: true, payments: true } },
        },
      });
      if (found === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

      // Authoritative per-case drafting cost over ALL DraftJobs — NOT just the take:5 above.
      // The cost-bearing completed runs are often older than the latest 5 redraft rows, so summing
      // `found.draftJobs` misses them and the UI showed "—" (Ryan 2026-06-04). Select only costUsd
      // (cheap) and reduce here. costUsd is a Prisma Decimal? → may serialize as a string/Decimal;
      // `Number(v)` coerces it and null/undefined rows are skipped (treated as 0). When NO job
      // carries a cost we leave draftingCostUsd null so the UI can honestly show "—".
      // Mirrors the proven reduction in routes/reports.ts (avoids the un-typed aggregate delegate).
      const costRows = (await db.draftJob.findMany({
        where: { caseId: id },
        select: { costUsd: true },
      })) as unknown as Array<{ costUsd?: unknown }>;
      let hasCost = false;
      let costTotal = 0;
      for (const r of costRows) {
        const v = r.costUsd;
        if (v === null || v === undefined) continue;
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        hasCost = true;
        costTotal += n;
      }
      const draftingCostUsd = hasCost ? Math.round((costTotal + Number.EPSILON) * 100) / 100 : null;

      // Pre-flight approve blockers (sign-off incident 2026-06-09): the physician must see WHY
      // approve will 409 BEFORE attesting, not after. Advisory mirror of the POST /letter/approve
      // gates (which stay authoritative); computed ONLY in physician_review — the one status where
      // the review page shows the Approve button. FAIL-OPEN: any failure omits the field (the page
      // shows no banner) but logs one structured non-PHI line so the failure itself is never silent.
      let approveBlockers: ApproveBlocker[] | undefined;
      if (found.status === 'physician_review') {
        try {
          approveBlockers = await computeApproveBlockers(db, found, deps);
        } catch (error: unknown) {
          console.warn(JSON.stringify({
            msg: 'approve_blockers_unavailable',
            method: req.method,
            path: req.originalUrl,
            caseId: id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      res.json({ data: { ...found, draftingCostUsd, ...(approveBlockers !== undefined ? { approveBlockers } : {}) } });
    }),
  );

  router.post(
    '/veterans/:veteranId/cases',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const veteranId = String(req.params.veteranId);
      const parsed = parseCaseCreate(req.body);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.findUnique({ where: { id: veteranId }, select: { id: true } });
        if (veteran === null) throw new HttpError(404, 'not_found', 'Veteran not found', { veteranId });

        const row = await tx.case.create({
          data: {
            ...parsed,
            // Provenance (keystone pkg 5): framing values typed into the create form are
            // staff-set → 'manual' (immutable to the post-merge restamp hook).
            ...(parsed.framingChoice !== undefined || parsed.upstreamScCondition !== undefined
              ? { framingStampSource: 'manual' }
              : {}),
            veteranId,
            status: 'intake',
          },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_created',
            caseId: row.id,
            veteranId,
            detailsJson: { caseId: row.id, veteranId, fields: ['id', 'claimedCondition', 'claimedConditions', 'claimType'] },
          },
        });

        return row;
      });

      res.status(201).json({ data: withRecordsSignal(created as unknown as Record<string, unknown>) });
    }),
  );

  router.patch(
    '/cases/:id',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseCasePatch(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({ where: { id }, select: { id: true, veteranId: true, version: true, claimedConditions: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case version is stale', {
            caseId: id,
            expectedVersion: existing.version,
            receivedVersion: parsed.version,
          });
        }

        // Keep claimedConditions[] in sync when the primary claimedCondition is edited on a
        // SINGLE-condition claim. The CDS + drafter pipeline read claimedConditions[] when it's
        // non-empty (cds.ts) and fall back to claimedCondition only when empty — so editing just the
        // primary would leave a stale array and the run would use the OLD condition. Clustered claims
        // (len > 1) are NOT touched here; re-editing a multi-condition cluster is a separate flow.
        // (Ryan 2026-06-06 — changing Warren's dx "other joint" → "left shoulder osteoarthritis".)
        const newPrimary = parsed.fields.claimedCondition;
        const syncConditions =
          typeof newPrimary === 'string' && newPrimary.length > 0 && existing.claimedConditions.length <= 1
            ? { claimedConditions: [newPrimary] }
            : {};

        // Provenance (keystone pkg 5): a PATCH that touches the framing pair is an RN/staff edit →
        // stamp 'manual' so the post-merge restamp hook never auto-overwrites it. (Clearing the
        // fields to null is ALSO a deliberate staff action — still 'manual'.)
        const touchesFraming = parsed.changedFields.includes('framingChoice') || parsed.changedFields.includes('upstreamScCondition');

        const row = await tx.case.update({
          where: { id },
          data: {
            ...parsed.fields,
            ...(touchesFraming ? { framingStampSource: 'manual' } : {}),
            ...syncConditions,
            version: { increment: 1 },
          },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_updated',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, fields: parsed.changedFields },
          },
        });

        return row;
      });

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  // PUT /cases/:id/quick-note — Feature A (Ryan 2026-06-06). An overwrite scratchpad shown in the
  // claims list for at-a-glance status ("waiting on records"). Multi-user (RN + assigned physician);
  // last-writer-wins with an author+time stamp (stored as the editor's EMAIL, never a uuid). It does
  // NOT touch case.version — a scratch note must not collide with the editor/assignment optimistic
  // concurrency. An empty/whitespace note clears the field.
  // PATCH (not PUT): the API Gateway CORS allowMethods is [GET,POST,PATCH,DELETE,OPTIONS] — a PUT's
  // preflight is rejected by the browser ("Network Error") before it ever reaches the Lambda. PATCH is
  // also the right verb for a partial field update. (Caught in live testing 2026-06-06.)
  router.patch(
    '/cases/:id/quick-note',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as { note?: unknown };
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        throw new HttpError(400, 'bad_request', 'note must be a string', { field: 'note' });
      }
      const raw = typeof body.note === 'string' ? body.note.trim() : '';
      if (raw.length > 2000) throw new HttpError(400, 'bad_request', 'note exceeds 2000 chars', { field: 'note', max: 2000 });
      const cleared = raw.length === 0;

      const existing = await db.case.findFirst({ where: { id }, select: { id: true, veteranId: true } });
      if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

      const row = await db.case.update({
        where: { id },
        data: cleared
          ? { quickNote: null, quickNoteBy: null, quickNoteAt: null }
          : { quickNote: raw, quickNoteBy: user.email ?? user.id, quickNoteAt: new Date() },
        select: { id: true, quickNote: true, quickNoteBy: true, quickNoteAt: true },
      });
      await db.activityLog.create({
        data: {
          actorUserId: user.id,
          action: cleared ? 'quick_note_cleared' : 'quick_note_set',
          caseId: id,
          veteranId: existing.veteranId,
          detailsJson: { caseId: id },
        },
      });
      res.json({ data: row });
    }),
  );

  // DELETE /cases/:id — ARCHIVE a claim (soft-delete, reversible). Used to clean up a mis-assigned /
  // duplicate claim. Sets archived_at so it drops out of default views but its files/drafts/audit are
  // preserved and it can be Restored. No status guard — archiving is reversible, so it's safe on any
  // case. (Replaces the old permanent cascade delete; a true purge is admin-only below.) Ryan 2026-06-05.
  router.delete(
    '/cases/:id',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({ where: { id }, select: { id: true, veteranId: true, status: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        await tx.case.update({ where: { id }, data: { archivedAt: new Date() } as never });
        await tx.activityLog.create({ data: { actorUserId: user.id, action: 'case_archived', caseId: id, veteranId: existing.veteranId, detailsJson: { caseId: id, previousStatus: existing.status } } });
      });
      res.status(204).send();
    }),
  );

  // POST /cases/:id/restore — un-archive (archived_at = null).
  router.post(
    '/cases/:id/restore',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const existing = await db.case.findFirst({ where: { id }, select: { id: true, veteranId: true } });
      if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
      await db.case.update({ where: { id }, data: { archivedAt: null } as never });
      await db.activityLog.create({ data: { actorUserId: user.id, action: 'case_restored', caseId: id, veteranId: existing.veteranId, detailsJson: { caseId: id } } });
      res.json({ data: { ok: true } });
    }),
  );

  // DELETE /cases/:id/purge — TRUE permanent delete (admin only), for genuine spam/junk. Cascade
  // removes children; activity_log is SetNull so the audit survives. Only an already-ARCHIVED case.
  router.delete(
    '/cases/:id/purge',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({ where: { id }, select: { id: true, veteranId: true, archivedAt: true } as never }) as { id: string; veteranId: string; archivedAt: Date | null } | null;
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.archivedAt === null) throw new HttpError(409, 'conflict', 'Archive the claim first, then purge — prevents an accidental permanent delete.', { caseId: id });
        await tx.activityLog.create({ data: { actorUserId: user.id, action: 'case_purged', caseId: id, veteranId: existing.veteranId, detailsJson: { caseId: id } } });
        await (tx as unknown as { case: { delete: (a: { where: { id: string } }) => Promise<unknown> } }).case.delete({ where: { id } });
      });
      res.status(204).send();
    }),
  );

  router.post(
    '/cases/:id/status',
    roleGuardForStatusTransition(db),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseStatusTransition(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, status: true, version: true },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.status !== parsed.from || existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case status or version is stale', {
            caseId: id,
            currentStatus: existing.status,
            currentVersion: existing.version,
            receivedFrom: parsed.from,
            receivedVersion: parsed.version,
          });
        }
        if (!isValidCaseStatusTransition(parsed.from, parsed.to)) {
          throw new HttpError(400, 'bad_request', 'Invalid case status transition', {
            from: parsed.from,
            to: parsed.to,
          });
        }

        const row = await tx.case.update({
          where: { id },
          data: { status: parsed.to, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_status_changed',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: {
              caseId: id,
              from: existing.status,
              to: parsed.to,
              ...(parsed.transitionReason !== undefined && { transitionReason: parsed.transitionReason }),
            },
          },
        });

        return row;
      });

      // Package 7 (2026-06-11): auto-generate the Doctor Pack whenever a case LANDS
      // physician_review. Both landing edges flow through THIS route — rn_review ->
      // physician_review (the RN's "Send to doctor", the canonical path) and drafting ->
      // physician_review (legacy/manual back-compat); no other code path writes
      // status='physician_review' (drafter /complete lands rn_review, /halt lands needs_*).
      // Fired AFTER the transaction commits in a log-only try/catch (mirrors
      // maybeEnqueueChartExtract's post-commit pattern, chart-extract-trigger.ts) so a pack
      // failure can NEVER roll back or fail the status transition. Awaited (not fire-and-
      // forget): this runs on Lambda, which freezes after the response — detached promises die.
      // Idempotency lives in the service ('auto_send_to_doctor' mode): it skips when a
      // queued/generating/ready pack exists at the post-transition version OR the
      // pre-transition version (the bump between them IS this status flip, so a pack the RN
      // generated just before clicking Send reflects the identical chart). On failure the send
      // still succeeds; the Doctor Pack panel's null/failed state with its "Generate now" /
      // Regenerate affordance is the recovery surface, and the stuck-pack watcher backstops.
      if (parsed.to === 'physician_review') {
        try {
          const gen = await generateDoctorPackForCase(db, {
            caseId: id,
            actorSub: user.id,
            trigger: 'auto_send_to_doctor',
            priorCaseVersion: parsed.version,
          });
          console.log(JSON.stringify({
            event: gen.outcome === 'queued' ? 'doctor_pack_autogen_queued' : 'doctor_pack_autogen_skipped',
            caseId: id,
            from: parsed.from,
            ...(gen.outcome === 'queued'
              ? { doctorPackId: gen.pack.id, caseVersion: gen.pack.caseVersion }
              : { existingPackId: gen.existingPackId, existingState: gen.existingState, existingCaseVersion: gen.existingCaseVersion }),
          }));
        } catch (err) {
          console.warn(JSON.stringify({
            event: 'doctor_pack_autogen_failed',
            caseId: id,
            from: parsed.from,
            to: parsed.to,
            message: err instanceof Error ? err.message : String(err),
          }));
        }
      }

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  router.get(
    '/cases/:id/draft-jobs',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const rows = await db.draftJob.findMany({ where: { caseId: id }, orderBy: { version: 'desc' } });
      res.json({ data: rows });
    }),
  );

  router.get(
    '/cases/:id/corrections',
    requireStaffOrAssignedPhysician(db, ['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const rows = await db.correction.findMany({ where: { caseId: id }, orderBy: { requestedAt: 'desc' } });
      res.json({ data: rows });
    }),
  );

  router.post(
    '/cases/:id/assign-physician',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseAssignPhysician(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, version: true, assignedPhysicianId: true },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case version is stale', {
            caseId: id,
            expectedVersion: existing.version,
            receivedVersion: parsed.version,
          });
        }

        const row = await tx.case.update({
          where: { id },
          data: { assignedPhysicianId: parsed.physicianId, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_physician_assigned',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, fields: ['assignedPhysicianId'] },
          },
        });

        return row;
      });

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  

  router.post(
    '/cases/:id/assign-rn',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const parsed = parseAssignRn(req.body);

      // Validate the target is a real ops_staff/admin user — don't assign a physician-only
      // account as the RN liaison. appUser isn't on the tx delegate, so resolve before the tx.
      const rn = await db.appUser.findUnique({ where: { id: parsed.rnUserId }, include: { roles: true } });
      if (rn === null) throw new HttpError(404, 'not_found', 'RN user not found', { rnUserId: parsed.rnUserId });
      const rnRoles = rn.roles.map((r) => r.role);
      if (!rnRoles.includes('ops_staff') && !rnRoles.includes('admin')) {
        throw new HttpError(422, 'bad_request', 'Assigned RN must be an ops_staff or admin user.', { rnUserId: parsed.rnUserId });
      }

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({ where: { id }, select: { id: true, veteranId: true, version: true, assignedRnId: true } });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (existing.version !== parsed.version) {
          throw new HttpError(409, 'conflict', 'Case version is stale', { caseId: id, expectedVersion: existing.version, receivedVersion: parsed.version });
        }
        const row = await tx.case.update({
          where: { id },
          data: { assignedRnId: parsed.rnUserId, version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });
        await tx.activityLog.create({
          data: { actorUserId: user.id, action: 'case_rn_assigned', caseId: id, veteranId: existing.veteranId, detailsJson: { caseId: id, fields: ['assignedRnId'] } },
        });
        return row;
      });

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  return router;
}
