import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, CaseStatus, Role } from '../services/db-types.js';
import { SCREENING_SUMMARY_KEY_MARKER } from '../services/chart-build-state.js';
import { resolveGroundedFraming } from '../services/grounded-framing.js';
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
import { resolveCurrentRefStrict, resolveViewableCurrentTxtKey, readTxtFromS3, resolveCurrentRevisionMeta, type CurrentRef } from '../services/letter-current.js';
import {
  parseCredentialBlock,
  substituteSignerSentinels,
  substituteHardcodedSection1Credentials,
  buildRendererCredentialLines,
  KASKY_CREDENTIALS,
} from '../services/credential-block.js';
import { EDITABLE_STATUSES, type RenderInvoker } from './letter.js';
import { assertDeliveryEligible } from '../services/delivery-eligibility.js';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { fireRecomputeViability } from '../services/recompute-viability-trigger.js';
import * as quoClient from '../services/quoClient.js';

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
  // NOTE: the old overwritable scratchpad columns (quick_note / quick_note_by / quick_note_at,
  // "Feature A") are RETIRED 2026-06-21. They are no longer selected, written, or shown — the DB
  // columns remain (deprecated, nullable) but the at-a-glance note now comes from the most-recent
  // PERSISTENT quick note in the chart-notes stream, batch-attached as `latestQuickNote` below.
  createdAt: true,
  updatedAt: true,
  // archivedAt (soft-delete timestamp) rides on the list row so the client can label an archived
  // case in the "Closed" view's status grouping (C5 lifecycle, 2026-06-13). Null = active.
  archivedAt: true,
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
      // "Invoiced" list signal (Ryan 2026-06-11): the RN sent the invoice email → a letter_500
      // Payment row sits at status='invoiced' (delivery.ts POST /send). Derived chip ONLY — we
      // deliberately do NOT invent a new case status (reconciliation to 'paid' stays the
      // admin transition). >1 row possible (idempotent re-use guards); count>0 is the signal.
      payments: { where: { kind: 'letter_500', status: 'invoiced' } },
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
  const counts = _count as { documents?: number; payments?: number } | undefined;
  const recordCount = typeof counts?.documents === 'number' ? counts.documents : 0;
  const invoicedCount = typeof counts?.payments === 'number' ? counts.payments : 0;
  return { ...rest, recordCount, recordsUploaded: recordCount > 0, invoiced: invoicedCount > 0 };
}

// Source statuses a finalized letter can be recalled FROM via /cases/:id/return-to-physician (2026-06-28).
// 'delivered' covers Ready-for-delivery + Invoiced (both display overlays of status='delivered'); 'paid' is
// the billed/closed case the physician/owner can still recall (admin/physician-only — gated in the handler).
const RETURNABLE_TO_PHYSICIAN: ReadonlySet<CaseStatus> = new Set<CaseStatus>(['delivered', 'paid']);

// "Return to physician" body (Item 1, 2026-06-28): { version, message }. The message is MANDATORY here
// (unlike the optional send-to-doctor note) — the actor must explain WHY a finalized letter is coming back.
function parseReturnToPhysician(body: unknown): { version: number; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const version = b.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new HttpError(400, 'bad_request', 'version is required', { field: 'version' });
  }
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length === 0) {
    throw new HttpError(400, 'bad_request', 'A message explaining why the letter is returned is required.', { field: 'message' });
  }
  if (message.length > 4000) {
    throw new HttpError(400, 'bad_request', 'The return message is too long (4000 character max).', { field: 'message' });
  }
  return { version, message };
}

/** Shape of the latest-quick-note signal attached to each list row. Null when the case's veteran has no quick note. */
export interface LatestQuickNoteSignal {
  readonly id: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

/**
 * Batch-fetch the MOST-RECENT persistent quick note per veteran for a page of cases, in ONE query
 * (NOT N+1). Quick notes live in the chart-notes stream keyed by veteran_id (the retired Feature-A
 * scratchpad lived on the Case row); the Cases list now surfaces this stream entry per row.
 *
 * `distinct: ['veteranId']` + `orderBy: [veteranId, createdAt desc]` is Postgres DISTINCT ON: it
 * returns exactly one row per veteran — the newest quick note — so a page of N cases costs ONE
 * extra query regardless of N. Returns a veteranId -> latest-quick map. Empty input → no query.
 *
 * Author NAME resolution is intentionally skipped here (the list row shows the note + relative time,
 * not the author); the case-detail / chart latest-quick endpoint resolves the name when needed.
 */
async function loadLatestQuickNotesByVeteran(
  db: AppDb,
  veteranIds: readonly string[],
): Promise<Map<string, LatestQuickNoteSignal>> {
  const out = new Map<string, LatestQuickNoteSignal>();
  const ids = [...new Set(veteranIds)];
  if (ids.length === 0) return out;
  const rows = await db.chartNote.findMany({
    where: { veteranId: { in: ids }, isQuickNote: true },
    distinct: ['veteranId'],
    orderBy: [{ veteranId: 'asc' }, { createdAt: 'desc' }],
    select: { id: true, veteranId: true, body: true, createdAt: true, createdBy: true },
  });
  for (const r of rows as ReadonlyArray<{ id: string; veteranId: string; body: string; createdAt: Date; createdBy: string }>) {
    out.set(r.veteranId, { id: r.id, body: r.body, createdAt: r.createdAt, createdBy: r.createdBy });
  }
  return out;
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

// `statuses` (comma-separated, or a repeated query param Express collapses into an array) → a
// multi-status filter (where.status.in). The dashboard GROUP tiles (D2, 2026-06-13) emit a
// `statuses[]` filter (e.g. the RN-queue group = rn_review,needs_rn_decision,correction_requested,
// correction_review) and deep-link to this list to reproduce their count, so the list must accept
// the same set in ONE query (keeps the findMany+count pair a single server-paginated pair). Each
// value is validated against the canonical CASE_STATUSES list — an unknown one 400s, same as
// ?status=. Empty/blank tokens are dropped; an all-blank param yields undefined (no filter).
function parseOptionalCaseStatuses(value: unknown): readonly CaseStatus[] | undefined {
  const raw: string[] = Array.isArray(value)
    ? value.flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const tokens = raw.map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  for (const t of tokens) {
    if (!isCaseStatus(t)) {
      throw new HttpError(400, 'bad_request', 'statuses filter is invalid', { field: 'statuses', value: t });
    }
  }
  // De-dupe so the IN list is clean; preserve first-seen order for stable, testable output.
  return [...new Set(tokens)] as CaseStatus[];
}

function optionalStringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildCaseListWhere(query: Request['query']): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const status = parseOptionalCaseStatus(query.status);
  const statuses = parseOptionalCaseStatuses(query.statuses);
  const claimType = optionalStringQuery(query.claimType);
  const veteranId = optionalStringQuery(query.veteranId);
  const assignedPhysicianId = optionalStringQuery(query.assignedPhysicianId);
  const assignedRnId = optionalStringQuery(query.assignedRnId);

  // `statuses` (multi) takes precedence over single `status` when BOTH are present — a group tile
  // deep-link carries `statuses`, and an `in` over a set is the more general filter. Single `status`
  // stays fully back-compatible (the Cases dropdown + every legacy caller send `status`).
  if (statuses !== undefined) where.status = { in: statuses };
  else if (status !== undefined) where.status = status;
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

  // Soft-archive (C5 lifecycle, 2026-06-13 — extended): default views EXCLUDE archived cases;
  //   ?archived=true → archived ONLY (the legacy "Show archived" semantics, unchanged);
  //   ?archived=all  → BOTH active and archived (no archivedAt filter) — the Closed toggle needs
  //                    this so "paid + rejected (active) + archived (any status)" come back in ONE
  //                    server-paginated query rather than two unmergeable pages;
  //   anything else  → active ONLY (archivedAt = null), the default.
  const archivedParam = optionalStringQuery(query.archived);
  if (archivedParam === 'true') where.archivedAt = { not: null };
  else if (archivedParam === 'all') { /* no archivedAt constraint — include active + archived */ }
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

    // Don't send a letter "to the doctor" when no doctor is assigned (Ryan 2026-06-06). EVERY edge into
    // physician_review carries this guard — a physician's queue is hard-filtered to their own assigned
    // cases, so an unassigned case in physician_review is invisible to every doctor (a dead-end). Covered
    // landing edges: rn_review (the canonical RN send), needs_rn_decision (2026-06-22 body-quality-park
    // forward hop), and drafting (2026-06-23 "Send to doctor" on a produced-but-didn't-finish letter —
    // the OpsHeldPanel forward path). Gate on parsed.to === 'physician_review', not the source, so any
    // future source edge is covered automatically.
    if (
      parsed.to === 'physician_review' &&
      !current.assignedPhysicianId
    ) {
      throw new HttpError(409, 'conflict', 'Assign a physician to this case before sending it for review.', { caseId: id, reason: 'no_physician_assigned' });
    }

    next();
  });
}

/**
 * BEST-EFFORT, FAIL-OPEN draft re-render after a physician is assigned (2026-07-21).
 *
 * When a case that already has a drafted (unsigned) letter is assigned to a NON-Kasky signer, the
 * interim draft PDF/DOCX still shows the drafter's hardcoded "Ryan J. Kasky, DO" Section I — only the
 * editor TXT (GET /letter) and the final SIGNED letter (approve) reflected the assigned signer before
 * this feature. This step overwrites the CURRENT draft version's pdf/docx IN PLACE so the "Open PDF"
 * preview on an unsigned draft matches the assigned signer, MIRRORING the approve path's signer +
 * co-signer resolution (routes/letter.ts). It does NOT touch the approve route, the PUT save, the GET
 * display block, or the drafter.
 *
 * ISOLATION CONTRACT — this must NEVER break the assign response, the approve/sign path, the letter
 * save, or the drafter:
 *   - Wrapped entirely in try/catch; every failure (resolution, S3 read, render) is logged + SWALLOWED.
 *     It NEVER throws. The assign endpoint returns its normal 200 regardless.
 *   - SKIPPED whole when renderLetter / s3 / bucket are not wired (unit tests, local) — no behavior change.
 *   - No-op for Kasky (NPI identity): the canonical draft is already Kasky, so renderLetter is not called.
 *   - Does NOT create a new version, does NOT move Case.currentVersion, does NOT write a LetterRevision,
 *     and does NOT rewrite the canonical TXT.
 *
 * CANONICAL-TXT PRESERVATION (load-bearing — the re-assignment correctness guard): the render Lambda
 * PutObjects ALL THREE keys it is handed, INCLUDING keys.txtKey (render-lambda-handler.js writes
 * letterText to txtKey unconditionally). Handing it the REAL current txtKey would clobber the drafter's
 * Kasky-anchored canonical TXT with the substituted signer text — so a LATER re-assignment (Kevin→Jane)
 * would find no Kasky anchor left to substitute and would freeze on the first signer. To keep the
 * canonical TXT immutable we hand the renderer a THROWAWAY sidecar txt key and point ONLY pdf/docx at
 * the real current keys: the pdf/docx bytes change in place, the canonical TXT does not. Every
 * assignment always re-substitutes the current signer's Section I from the same canonical Kasky text.
 */
async function reRenderCurrentDraftForAssignedSigner(
  db: AppDb,
  deps: CasesRouterDeps,
  caseId: string,
): Promise<void> {
  try {
    const { renderLetter, s3, bucketName } = deps;
    // Fail-open: the re-render needs the render Lambda + S3 wired. Absent → skip (no behavior change).
    if (renderLetter === undefined || s3 === undefined || bucketName === undefined) return;

    // Fresh case row (post-commit): the assigned signer + the current draft pointer + status.
    const c = await db.case.findFirst({
      where: { id: caseId },
      select: { id: true, veteranId: true, currentVersion: true, claimedCondition: true, assignedPhysicianId: true, status: true },
    });
    if (c === null || c.assignedPhysicianId === null) return;

    // ── SIGNED-ARTIFACT PROTECTION (deploy-blocker fix, 2026-07-21) ──────────────────────────────────
    // assign-physician is allowed on ANY status (admin/ops reassignment), but this in-place overwrite is
    // ONLY safe for an editable DRAFT. On a delivered/paid/approved case, resolveViewableCurrentTxtKey
    // resolves the SIGNED version's real pdf/docx keys, and overwriting them with a draft-watermarked
    // (possibly different-signer) render would CORRUPT the veteran-facing signed artifact — and the
    // normal-path delivery gate hashes the TXT (which we preserve), so it would NOT catch it. Three
    // independent fail-open guards, all logged, all before any render:
    //   1) Only re-render an EDITABLE status (delivered/paid/approved/rejected are OUT — the SSOT set
    //      lives in routes/letter.ts so this can never drift from what the editor treats as mutable).
    if (!EDITABLE_STATUSES.has(c.status)) return;
    //   2) Never touch an externally-imported letter: its PDF is the authoritative signed artifact and
    //      has no re-renderable canonical TXT. EXPLICIT, not reliant on the docx key happening to be null.
    const revMeta = await resolveCurrentRevisionMeta(db, caseId, c.currentVersion);
    if (revMeta !== null && revMeta.source === 'external_import') return;
    //   3) Belt-and-suspenders: never overwrite the exact bytes a physician has already signed off on
    //      (a SignOff bound to the current version). The G4 re-sign lifecycle should have moved status
    //      already, but this guarantees we never rewrite a signed version's artifacts even if it didn't.
    const signOffs = await db.signOff.findMany({ where: { caseId } });
    if (signOffs.some((s) => s.signedVersion === c.currentVersion)) return;

    // Resolve the assigned signer + creds (mirror approve). Inactive / missing / incomplete-credential /
    // no-signature → SKIP (fail-open): an unsignable signer is the approve route's authoritative gate,
    // never something the assign endpoint should surface or fail on.
    const signer = await db.physician.findFirst({ where: { id: c.assignedPhysicianId } });
    if (signer === null || !signer.active) return;
    const signerCreds = parseCredentialBlock(signer.credentialBlockJson);
    if (signerCreds === null) return;
    // No-op for Kasky (NPI identity) — the canonical draft PDF is already Kasky. renderLetter not called.
    if (signerCreds.npi.trim() === KASKY_CREDENTIALS.npi.trim()) return;
    const signatureKey = signer.signatureImageS3Key;
    if (signatureKey === null || signatureKey.trim() === '') return;

    // Co-signer (mirror approve). If a co-sign is configured but not fully renderable, SKIP the whole
    // re-render (fail-open) — co-signer completeness is enforced at approve, not here.
    let cosignerFields: { cosigner_name: string; cosigner_signature_image_s3_key: string } | undefined;
    let coSignerName: string | null = null;
    if (signer.coSignedByPhysicianId != null) {
      const coSigner = await db.physician.findFirst({ where: { id: signer.coSignedByPhysicianId } });
      if (coSigner === null || !coSigner.active) return;
      const coSignerCreds = parseCredentialBlock(coSigner.credentialBlockJson);
      if (coSignerCreds === null) return;
      const coSignatureKey = coSigner.signatureImageS3Key;
      if (coSignatureKey === null || coSignatureKey.trim() === '') return;
      cosignerFields = { cosigner_name: buildRendererCredentialLines(coSignerCreds), cosigner_signature_image_s3_key: coSignatureKey };
      coSignerName = coSignerCreds.fullNameWithCredential;
    }

    // Resolve the CURRENT letter (txt + pdf/docx keys) via the SAME recovery-capable resolver the
    // editor/read path uses. No current letter (currentVersion 0 / nothing resolvable), or missing
    // pdf/docx to overwrite → SKIP.
    const ref = await resolveViewableCurrentTxtKey(db, s3, bucketName, caseId, c.currentVersion);
    if (ref === null || ref.pdfKey === null || ref.docxKey === null) return;

    // Read the CANONICAL txt (drafter Kasky-anchored) and substitute the assigned signer's Section I —
    // mirror approve: sentinel substitution (no-op on legacy letters) then the hardcoded-Kasky rewrite.
    const canonicalTxt = await readTxtFromS3(s3, bucketName, ref.txtKey, { caseId, version: ref.version });
    const sentinelText = substituteSignerSentinels(canonicalTxt, signerCreds, 'their');
    const substituted = substituteHardcodedSection1Credentials(sentinelText, signerCreds, coSignerName);

    const veteran = await db.veteran.findUnique({ where: { id: c.veteranId } });
    if (veteran === null) return;
    const caseData = {
      id: caseId,
      veteran_name: `${veteran.firstName} ${veteran.lastName}`.trim(),
      veteran_last: veteran.lastName,
      claimed_condition: c.claimedCondition,
      // Multi-line NPI-only credential block (name + board-cert + NPI) — same builder approve uses.
      signer_name: buildRendererCredentialLines(signerCreds),
      signature_image_s3_key: signatureKey,
      ...(cosignerFields ?? {}),
    };

    // Overwrite the CURRENT version's pdf/docx IN PLACE (same version, draft watermark). The txt is
    // routed to a THROWAWAY sidecar key so the canonical Kasky TXT is preserved (see doc above). No new
    // version, no currentVersion change, no LetterRevision row.
    const previewTxtKey = `${ref.txtKey}.assigned-signer-preview.txt`;
    await renderLetter({
      caseData,
      letterText: substituted,
      version: ref.version,
      draft: true,
      bucket: bucketName,
      keys: { txtKey: previewTxtKey, pdfKey: ref.pdfKey, docxKey: ref.docxKey },
    });
  } catch (err) {
    // FAIL-OPEN: the assign endpoint must return its normal 200 regardless — log structured + swallow.
    console.warn(JSON.stringify({
      msg: 'assign_physician_rerender_failed',
      caseId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// deps carries S3 (+ bucket) for the advisory approve-blocker pre-flight on GET /cases/:id (the
// signer-name check reads the current letter TXT) AND — optionally — renderLetter for the best-effort
// assign-physician draft re-render (below). All optional: when absent the text-dependent checks and
// the re-render are skipped and everything else still works (fail-open).
export interface CasesRouterDeps extends ApproveBlockerDeps {
  // The SAME render-Lambda invoker the letter editor uses (server.ts). Present in prod, ABSENT in unit
  // tests / local / render-less envs — in which case the assign-physician draft re-render is skipped
  // entirely (zero behavior change). Never required for any existing cases-route behavior.
  readonly renderLetter?: RenderInvoker;
}

export function createCasesRouter(db: AppDb, deps: CasesRouterDeps = {}): Router {
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

      // Batch-attach the latest PERSISTENT quick note per row (one query for the whole page; replaces
      // the retired Feature-A scratchpad column). Keyed by veteranId since quick notes live in the
      // veteran-scoped chart-notes stream.
      const latestQuickByVeteran = await loadLatestQuickNotesByVeteran(
        db,
        cases.map((c) => (c as unknown as { veteranId: string }).veteranId),
      );
      const data = cases.map((c) => {
        const row = withRecordsSignal(c as unknown as Record<string, unknown>);
        const veteranId = (c as unknown as { veteranId: string }).veteranId;
        return { ...row, latestQuickNote: latestQuickByVeteran.get(veteranId) ?? null };
      });

      res.json({ data, page, pageSize, total });
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

      // "Date submitted" (Item 2, 2026-06-28): the STAGE-2 records-received moment — when the case's
      // records first arrived and the turnaround clock starts. NOT the intake date. STATIC: the EARLIEST
      // veteran-uploaded record's uploadedAt, EXCLUDING the two auto-generated docs (the generated intake
      // summary + the physician Doctor Pack) — the SAME filter CASE_LITE_SELECT.recordCount uses. MIN never
      // moves when MORE records arrive later (uploads only go forward in time), so it reflects the
      // records-received moment and does NOT change as later records/updates are submitted. Null until the
      // first real record lands (e.g. a Stage-1-only case). Surfaced on the case detail for the physician
      // review header.
      // FAIL-OPEN: the "Date submitted" line is non-critical decoration — a lookup failure must NEVER 500
      // the whole case detail. On any error we omit the date (null) and log one structured line, exactly
      // like the approveBlockers fail-open above.
      let recordsReceivedAt: Date | null = null;
      try {
        const firstRecordRows = (await db.document.findMany({
          where: {
            caseId: id,
            NOT: [
              // exclude the auto-generated screening-summary OUTPUT (not a veteran-uploaded record) —
              // same exclusion every other per-case doc-set consumer uses (SCREENING_SUMMARY_KEY_MARKER)
              { s3Key: { endsWith: SCREENING_SUMMARY_KEY_MARKER } },
              { s3Key: { endsWith: 'Intake_Summary.pdf' } },
              { s3Key: { contains: 'Doctor_Pack' } },
              { s3Key: { contains: 'DoctorPack' } },
            ],
          },
          orderBy: { uploadedAt: 'asc' },
          take: 1,
          select: { uploadedAt: true },
        })) as unknown as ReadonlyArray<{ uploadedAt: Date }>;
        recordsReceivedAt = firstRecordRows[0]?.uploadedAt ?? null;
      } catch (error: unknown) {
        console.warn(JSON.stringify({
          msg: 'records_received_at_unavailable',
          caseId: id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }

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

      // Grounded framing for DISPLAY (Ryan 2026-07-11, CLM-47FAC163B8 "ANKLE nowhere"): a stale,
      // mechanism-blind `upstreamScCondition` ("Ankle" while the plan/letter argue depression) must never
      // reach any chart surface. `resolveGroundedFraming` returns the value SAFE to display (the
      // route-picker's grounded anchor, or suppressed). ADDITIVE on the RESPONSE ONLY — NEVER a DB write,
      // NEVER in CASE_LITE_SELECT or PATCH data, so the drafter (which reads the raw column via
      // drafter-bundle) is untouched. FAIL-OPEN: any failure omits the field (surfaces fall back to raw).
      let groundedFraming: Awaited<ReturnType<typeof resolveGroundedFraming>> | undefined;
      try {
        groundedFraming = await resolveGroundedFraming(db, id, found);
      } catch (error: unknown) {
        console.warn(JSON.stringify({ msg: 'grounded_framing_unavailable', caseId: id, error: error instanceof Error ? error.message : String(error) }));
      }

      res.json({ data: { ...found, draftingCostUsd, recordsReceivedAt, ...(approveBlockers !== undefined ? { approveBlockers } : {}), ...(groundedFraming !== undefined ? { groundedFraming } : {}) } });
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
            // claimedCondition provenance (2026-07-04): a staff-typed create value is 'intake'-tier — the
            // AI-narrow step MAY still refine a generic "Other …" label from here (source != 'manual'). An
            // RN who edits it later via PATCH bumps it to 'manual' (immutable).
            claimedConditionSource: 'intake',
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

      // ── ADDITIVE Quo contact sync (2026-07-02) ───────────────────────────────────────────────────
      // Best-effort: create a Quo contact keyed by the case id so a later inbound call/text from the
      // veteran is identifiable to the RNs. The case is ALREADY committed above; this block is fully
      // isolated and SWALLOWS everything — a Quo failure, a missing veteran, or an activity-log failure
      // MUST NOT block case creation or change the 201 response. No customFields (the Quo workspace
      // custom fields aren't defined yet; passing them 400s). createContact itself never throws.
      try {
        const vet = await db.veteran.findUnique({
          where: { id: veteranId },
          select: { firstName: true, lastName: true, phone: true, email: true },
        });
        if (vet !== null) {
          const contact = await quoClient.createContact({
            firstName: vet.firstName,
            lastName: vet.lastName,
            phone: vet.phone,
            email: vet.email,
            externalId: created.id,
          });
          try {
            await db.activityLog.create({
              data: {
                actorUserId: user.id,
                action: 'quo_contact_synced',
                caseId: created.id,
                veteranId,
                detailsJson: { ok: contact.ok, ...(contact.reason !== undefined ? { reason: contact.reason } : {}) },
              },
            });
          } catch { /* audit is best-effort */ }
        }
      } catch { /* Quo contact sync is best-effort — never blocks case creation */ }

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

      // Invalidate the persisted AI route-picker plan when an input-affecting field is edited, so Ask
      // Aegis never narrates a stale plan as the "anticipated drafter framing" (QA 2026-06-19 blocker).
      // Computed OUTSIDE the transaction (pure over changedFields) so the post-commit recompute dispatch
      // below can key on the same decision. (The reader also has a claimed-condition staleness guard.)
      const PLAN_INPUT_FIELDS = ['claimedCondition', 'framingChoice', 'upstreamScCondition', 'inServiceEvent', 'veteranStatement'];
      const invalidatesPlan = parsed.changedFields.some((f) => PLAN_INPUT_FIELDS.includes(f));

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
        // claimedCondition provenance (2026-07-04): a PATCH that edits the claim is an RN/physician action →
        // stamp 'manual' so the AI-narrow step (and any automated writer) can NEVER overwrite it afterwards.
        const touchesClaim = parsed.changedFields.includes('claimedCondition');

        const row = await tx.case.update({
          where: { id },
          data: {
            ...parsed.fields,
            ...(touchesFraming ? { framingStampSource: 'manual' } : {}),
            ...(touchesClaim ? { claimedConditionSource: 'manual' } : {}),
            ...(invalidatesPlan ? ({ aiViabilityPlanJson: null, aiViabilityPlanHash: null } as object) : {}),
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

      // PROPAGATE THE EDIT WITHOUT A HARD REFRESH (Ryan 2026-07-14). The transaction above NULLED the
      // persisted plan when a PLAN_INPUT_FIELD changed, but nothing regenerated it — it only happened lazily
      // on the next card open, so the RN's edit never propagated to the SOAP/chip until a manual reload.
      // Fire the SAME off-request recompute the card's open path uses (fire-and-forget, log-only failure —
      // the PATCH response never blocks/fails on it). DRAFTING FREEZE KEPT: while status='drafting' the
      // drafter mutates the Case row constantly; auto-fired recomputes then are the documented chip-wobble
      // storm, so we skip (the next open after drafting recomputes normally).
      if (invalidatesPlan && (updated as { status?: string }).status !== 'drafting') {
        try {
          void fireRecomputeViability(id).catch((e: unknown) => {
            console.warn(JSON.stringify({ msg: 'case-patch: recompute dispatch failed open', caseId: id, error: e instanceof Error ? e.message : String(e) }));
          });
        } catch (e) {
          console.warn(JSON.stringify({ msg: 'case-patch: recompute dispatch failed open', caseId: id, error: e instanceof Error ? e.message : String(e) }));
        }
      }

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  // RETIRED 2026-06-21 — PATCH /cases/:id/quick-note ("Feature A" overwritable scratchpad). Quick notes
  // are now PERSISTENT, chronological entries in the chart-notes stream (ChartNote.isQuickNote), written
  // via POST /veterans/:id/chart-notes { isQuickNote: true }. The at-a-glance note shown on the Cases
  // list + case header is the most-recent such entry (see loadLatestQuickNotesByVeteran). This route is
  // kept registered and returns 410 Gone (not 404) so any stale client gets an explicit, debuggable
  // signal instead of silently writing the now-dead case.quick_note column. The DB columns remain
  // (deprecated, nullable) — no destructive migration. Remove this stub once no client references it.
  router.patch(
    '/cases/:id/quick-note',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (_req: Request, _res: Response) => {
      throw new HttpError(
        410,
        'gone',
        'The case quick-note scratchpad is retired. Add a quick note from the chart Staff Notes panel (it persists in the chart-notes stream).',
      );
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

      // ── DELIVERY-ELIGIBILITY GATE (correction-round SSOT, audit 2026-06-13) ── Any HUMAN status
      // move whose target is 'delivered' must pass the same sign/byte contract the RN delivery panel
      // and the Stripe egress enforce — a signed nexus letter may not reach 'delivered' (the
      // pre-payment egress gate) unless an AFFIRMATIVE sign-off is bound to the CURRENT letter bytes.
      // This closes the bare-flip (correction_review->delivered, or any ->delivered) BEYOND the
      // role-gating: even an admin cannot flip a case to delivered with a missing/non-affirmative
      // sign-off or post-sign edited bytes. assertDeliveryEligible NEVER throws — it returns a verdict
      // we translate to a 409 (matching delivery.ts:226 codes). Byte step fails open exactly where
      // delivery.ts does (legacy/no-hash sign-off, or S3/bucket unconfigured). The exists +
      // affirmative checks do NOT fail open. (The drafter /complete + internal routes do not pass
      // through this client route, so this gate only governs human moves, as intended.) Runs ONLY for
      // a VALID ->delivered transition — an invalid from->delivered must still surface as the 400 the
      // transaction raises below (isValidCaseStatusTransition), not get pre-empted by this gate.
      if (parsed.to === 'delivered' && isValidCaseStatusTransition(parsed.from, parsed.to)) {
        const cForGate = await db.case.findFirst({ where: { id }, select: { id: true, currentVersion: true } });
        if (cForGate !== null) {
          const verdict = await assertDeliveryEligible(db, id, cForGate.currentVersion, deps);
          if (!verdict.eligible) {
            // code is the wire ErrorCode (signed_bytes_changed mirrors delivery.ts:226; the sign-off
            // cases use the generic 'conflict' code with the specific reason in details — matching
            // sign-offs.ts:47, which 409s 'conflict' + reason:'sign_off_not_affirmative').
            const code = verdict.reason === 'signed_bytes_changed' ? 'signed_bytes_changed' : 'conflict';
            const message =
              verdict.reason === 'signed_bytes_changed'
                ? 'The letter changed after it was signed. Re-sign before delivering.'
                : verdict.reason === 'no_signoff'
                  ? 'Cannot deliver: the case has no physician sign-off. Send it to the doctor for sign-off first.'
                  : 'Cannot deliver: the physician sign-off is not affirmative (a "No" attestation). Resolve it and re-sign before delivering.';
            throw new HttpError(409, code, message, { caseId: id, reason: verdict.reason, ...(verdict.details ?? {}) });
          }
        }
      }

      // FORWARD RE-PIN — STRANDED-POINTER SELF-HEAL AT THE SOURCE (CLM-8EC828F1D7, Hildreth, 2026-07-01):
      // when a halted render-parity draft was hand-edited + forwarded, Case.currentVersion can point at a
      // dead version while a present letter is recoverable. The approve gate + blocker advisory resolve
      // strictly by currentVersion, so without re-pinning the physician sees "No current letter to approve"
      // over a present letter. On a forward → physician_review whose STRICT pointer does NOT resolve but a
      // letter IS recoverable, materialize a LetterRevision for the recovered letter and re-pin
      // Case.currentVersion to it — so every strict consumer converges. HeadObject probes run BEFORE the
      // transaction (mirrors the delivery gate above); the DB writes stay inside it. Fail-open: recovery
      // needs s3/bucket — with them unwired (local/test) resolveViewableCurrentTxtKey degrades to strict,
      // so strandedRepin stays null and nothing changes.
      let forwardRepin: CurrentRef | null = null;
      if (parsed.to === 'physician_review' && isValidCaseStatusTransition(parsed.from, parsed.to)) {
        const cForRepin = await db.case.findFirst({ where: { id }, select: { id: true, currentVersion: true } });
        if (cForRepin !== null) {
          const strict = await resolveCurrentRefStrict(db, id, cForRepin.currentVersion);
          if (strict === null) {
            forwardRepin = await resolveViewableCurrentTxtKey(db, deps.s3, deps.bucketName, id, cForRepin.currentVersion);
          }
        }
      }

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: { id: true, veteranId: true, status: true, version: true, currentVersion: true },
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
          data: {
            status: parsed.to,
            version: { increment: 1 },
            // Re-pin onto the recovered letter so the strict approve gate + blocker resolve it.
            ...(forwardRepin !== null ? { currentVersion: forwardRepin.version } : {}),
          },
          select: CASE_LITE_SELECT,
        });

        // HANDOFF NOTE rides WITH the send-to-doctor transition (Ryan 2026-07-09). Previously the note
        // was a SEPARATE best-effort POST /cases/:id/messages hitting the strict participant gate (admin
        // OR the case's assigned physician/RN) — so a note sent from any other account 403'd and was
        // silently DROPPED while the case still moved. Writing it HERE, inside the same transaction, means
        // it is persisted under the SAME auth that just authorized the move (roleGuardForStatusTransition):
        // if you can send the case, your note goes with it. Only on a forward INTO physician_review; the
        // parser truncates (never rejects) so it can never BLOCK the send (no-block rule).
        if (parsed.to === 'physician_review' && parsed.handoffMessage) {
          await tx.caseMessage.create({
            data: { caseId: id, senderSub: user.sub, senderRole: user.role, body: parsed.handoffMessage },
          });
        }

        // Materialize a LetterRevision for the recovered letter (idempotent — the DESC-walk may land on a
        // DraftJob row or an S3-only artifact that has no LetterRevision yet). editedBy = the forwarding
        // human; source='drafter_run' (it IS a drafter-produced letter). Skipped when a revision already
        // exists at that version (recovery landed on an existing LetterRevision).
        if (forwardRepin !== null) {
          const existingRev = await tx.letterRevision.findFirst({ where: { caseId: id, version: forwardRepin.version } });
          if (existingRev === null) {
            await tx.letterRevision.create({
              data: {
                caseId: id,
                version: forwardRepin.version,
                parentVersion: forwardRepin.version,
                source: 'drafter_run',
                artifactTxtS3Key: forwardRepin.txtKey,
                artifactPdfS3Key: forwardRepin.pdfKey,
                artifactDocxS3Key: forwardRepin.docxKey,
                editedBy: user.sub,
                editorRole: user.role,
                sanityJson: null,
              },
            });
          }
          await tx.activityLog.create({
            data: {
              actorUserId: user.id,
              action: 'letter_stranded_recovery',
              caseId: id,
              veteranId: existing.veteranId,
              detailsJson: { strandedCurrentVersion: existing.currentVersion, recoveredVersion: forwardRepin.version, path: 'forward_to_physician' },
            },
          });
        }

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

  // "Return to physician" (Item 1, 2026-06-28; widened 2026-06-28 for the physician/owner + paid recall):
  // an error is caught on a FINALIZED, physician-signed letter and it is sent BACK to the assigned
  // physician's review queue so the doctor can re-review, edit, and re-sign. Distinct from the generic
  // /status route's delivered/paid -> physician_review edge — those stay ADMIN-ONLY bare flips (the G4
  // stale-signature lifecycle + the paid recall guard). This dedicated door is the human path and does its
  // OWN in-handler role gating; the explanatory message is MANDATORY: the status flip and the message are
  // written in ONE transaction, so the physician ALWAYS sees WHY the letter came back (PhysicianHandoffNotes
  // renders case_messages on the review page). The signed letter stays the CURRENT version — returning only
  // re-opens the review gate (no re-draft, no byte change), honoring the no-block-draft rule; when the
  // physician edits + re-signs, the existing approve/sign byte gates + the G4 lifecycle govern the new
  // version. RETURNABLE SOURCE STATUSES = {delivered, paid} ('delivered' already covers Ready-for-delivery
  // + Invoiced — both are display overlays of status='delivered'). ROLE POLICY: from 'delivered' →
  // {admin, ops_staff, physician}; from 'paid' → {admin, physician} ONLY — ops_staff CANNOT reopen a
  // billed/closed case (paid is the sensitive one). BILLING SAFETY: returning does NOT auto-un-invoice,
  // un-charge, or refund — the source status (+ wasPaid/wasInvoiced flags) is recorded in the activity log;
  // billing is handled separately. The Doctor Pack is NOT regenerated: it already exists from the first
  // send-to-doctor, and the review page reads it as-is.
  router.post(
    '/cases/:id/return-to-physician',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const { version, message } = parseReturnToPhysician(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: {
            id: true,
            veteranId: true,
            status: true,
            version: true,
            assignedPhysicianId: true,
            // wasInvoiced flag (billing-safety audit trail): a letter_500 Payment row at status='invoiced'
            // means the invoice email was sent. Same filter CASE_LITE_SELECT.invoiced uses. Count>0 = invoiced.
            _count: { select: { payments: { where: { kind: 'letter_500', status: 'invoiced' } } } },
          },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (!RETURNABLE_TO_PHYSICIAN.has(existing.status)) {
          throw new HttpError(409, 'conflict', 'Only a finalized (Ready for delivery) or paid letter can be returned to the physician.', {
            caseId: id,
            currentStatus: existing.status,
          });
        }
        // Source-status role gate (in-handler, on top of the requireRole gate above): a 'paid' (billed/
        // closed) case can ONLY be recalled by an admin or a physician — an RN (ops_staff) cannot reopen a
        // closed case. A 'delivered' case is returnable by all three roles (requireRole already allows them).
        if (existing.status === 'paid' && user.role !== 'admin' && user.role !== 'physician') {
          throw new HttpError(403, 'forbidden', 'A paid (closed) case can only be returned to the physician by an admin or a physician.', {
            caseId: id,
            currentStatus: existing.status,
          });
        }
        if (existing.version !== version) {
          throw new HttpError(409, 'conflict', 'Case status or version is stale', {
            caseId: id,
            currentStatus: existing.status,
            currentVersion: existing.version,
            receivedVersion: version,
          });
        }
        if (existing.assignedPhysicianId === null) {
          throw new HttpError(409, 'conflict', 'No physician is assigned to this case to return it to.', { caseId: id });
        }
        // NOTE: this guards that AN assigned physician exists, not that the CALLER is that physician. With a
        // single physician/owner that is sufficient. Before a second physician account is added, add the
        // caller-is-assigned check (mirror cases.ts:331 isAssignedPhysicianForCase) + its test-mock — tracked.

        const row = await tx.case.update({
          where: { id },
          data: { status: 'physician_review', version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        // Mandatory return note → the assigned physician sees it on their review page (PhysicianHandoffNotes
        // renders case_messages). Written IN-TRANSACTION with the flip so a returned case is never silent.
        // senderSub = the actor's cognito sub (the same id resolveActorNames maps to a display name).
        await tx.caseMessage.create({
          data: { caseId: id, senderSub: user.sub, senderRole: user.role, body: message },
        });

        // BILLING-SAFETY audit trail (2026-06-28): record the SOURCE status + whether the letter was
        // already paid / invoiced when it was recalled. Returning does NOT auto-un-invoice/refund/un-charge
        // — these flags make the manual billing follow-up legible in the activity log.
        const wasPaid = existing.status === 'paid';
        const wasInvoiced = (((existing as { _count?: { payments?: number } })._count?.payments) ?? 0) > 0;
        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_returned_to_physician',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, from: existing.status, to: 'physician_review', returned: true, wasPaid, wasInvoiced },
          },
        });

        return row;
      });

      res.json({ data: withRecordsSignal(updated as unknown as Record<string, unknown>) });
    }),
  );

  // ── RN "Revise & resend" (Ryan 2026-07-03) ────────────────────────────────────────────────────────
  // A delivered/paid letter needs a couple details added (e.g. reference a buddy statement) — a SURGICAL
  // edit, NOT a full redraft (the money-waster). This dedicated door reopens a delivered OR paid letter
  // straight into 'correction_requested', the RN-EDITABLE state — unlike /return-to-physician, which lands
  // in physician_review where the RN is locked out and the physician would have to decline first. The RN
  // then edits the letter (surgical-ai / PUT, non-§VII) and sends it back to the doctor
  // (correction_requested→physician_review) for a fresh sign-off + approve.
  //
  // ROLE POLICY (Ryan 2026-07-03, Gibbs paid-case): ops_staff MAY reopen BOTH delivered AND paid here — a
  // deliberate loosening of the "RN can't reopen a billed case" guard, made SAFE by being transparent, not
  // silent: a MANDATORY note + activity-log audit trail (wasPaid/wasInvoiced), NO billing change / NO
  // un-charge, and the physician still re-signs + re-approves before anything re-delivers. The signed letter
  // stays the CURRENT version until the RN actually edits it (no re-draft, no byte change on reopen).
  router.post(
    '/cases/:id/revise-letter',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const { version, message } = parseReturnToPhysician(req.body);

      const updated = await db.$transaction(async (tx) => {
        const existing = await tx.case.findFirst({
          where: { id },
          select: {
            id: true,
            veteranId: true,
            status: true,
            version: true,
            assignedPhysicianId: true,
            _count: { select: { payments: { where: { kind: 'letter_500', status: 'invoiced' } } } },
          },
        });
        if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
        if (!RETURNABLE_TO_PHYSICIAN.has(existing.status)) {
          throw new HttpError(409, 'conflict', 'Only a finalized (Ready for delivery) or paid letter can be reopened for revision.', {
            caseId: id,
            currentStatus: existing.status,
          });
        }
        if (existing.version !== version) {
          throw new HttpError(409, 'conflict', 'Case status or version is stale', {
            caseId: id,
            currentStatus: existing.status,
            currentVersion: existing.version,
            receivedVersion: version,
          });
        }
        if (existing.assignedPhysicianId === null) {
          throw new HttpError(409, 'conflict', 'No physician is assigned to this case to send the revised letter back to.', { caseId: id });
        }

        const row = await tx.case.update({
          where: { id },
          data: { status: 'correction_requested', version: { increment: 1 } },
          select: CASE_LITE_SELECT,
        });

        // Mandatory revision note → recorded on the case so reopening a delivered/paid (possibly billed)
        // letter is never silent; the physician also sees it when the corrected letter returns for sign-off.
        await tx.caseMessage.create({
          data: { caseId: id, senderSub: user.sub, senderRole: user.role, body: message },
        });

        const wasPaid = existing.status === 'paid';
        const wasInvoiced = (((existing as { _count?: { payments?: number } })._count?.payments) ?? 0) > 0;
        await tx.activityLog.create({
          data: {
            actorUserId: user.id,
            action: 'case_opened_for_revision',
            caseId: id,
            veteranId: existing.veteranId,
            detailsJson: { caseId: id, from: existing.status, to: 'correction_requested', wasPaid, wasInvoiced },
          },
        });

        return row;
      });

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

  // ── "Text: email waiting" nudge (Dr. Kasky 2026-07-16) ──────────────────────────────────────────────
  // One-tap RN/admin/physician button on the case page texts the veteran ONE SMS asking them to go read the
  // email we already sent (invoice link, a question, the delivered letter — the RN picks the moment). The
  // send rides the existing fire-and-forget Quo transport (quoClient.sendSms NEVER throws — it degrades to
  // {sent:false,reason}); this handler turns a failure into an actionable 4xx/5xx instead so the RN sees a
  // real reason. Every attempt (success OR failure) is logged to activity_log with the phone last-4. A
  // 2-minute server-side cooldown backs up the client's button-disable so a double-click or two RNs on the
  // same case can't spam the veteran. Strictly a notification — touches no case status, letter, or payment.
  router.post(
    '/cases/:id/notify-email-waiting',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const id = String(req.params.id);
      const EMAIL_WAITING_SMS_COOLDOWN_MS = 2 * 60 * 1000;

      const existing = await db.case.findFirst({
        where: { id },
        select: { id: true, veteranId: true },
      });
      if (existing === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

      // Phone lives on the Veteran (nullable, prefilled from the Jotform intake's submittedPhone). Fetch it
      // separately — the typed AppDb.case delegate doesn't expose the veteran relation (same idiom delivery.ts
      // uses to read the phone for the Tier-1 letter-ready SMS).
      const veteran = await db.veteran.findUnique({ where: { id: existing.veteranId } });
      const phone = (veteran as { phone?: string | null } | null)?.phone ?? null;
      if (phone === null || phone.trim() === '') {
        throw new HttpError(422, 'bad_request', 'No phone number is on file for this veteran — add one to the chart before texting.', { caseId: id });
      }

      // Server-side double-send guard (the button also disables while pending): refuse if this case was
      // texted the "email waiting" nudge SUCCESSFULLY within the cooldown window. Reads the activity log via a
      // JSON-path filter (detailsJson.sent === true) rather than a dedicated column — a low-frequency manual
      // action. A prior FAILED attempt does NOT lock a retry (only sent===true counts).
      const since = new Date(Date.now() - EMAIL_WAITING_SMS_COOLDOWN_MS);
      const recentSuccess = await db.activityLog.findFirst({
        where: {
          caseId: id,
          action: 'sms_email_waiting_sent',
          ts: { gt: since },
          detailsJson: { path: ['sent'], equals: true },
        },
      });
      if (recentSuccess !== null) {
        throw new HttpError(429, 'conflict', 'This veteran was already texted in the last couple of minutes. Please wait before sending again.', { caseId: id });
      }

      const smsResult = await quoClient.sendSms(phone, quoClient.emailWaitingText());
      const phoneLast4 = phone.replace(/[^\d]/g, '').slice(-4);

      // Audit EVERY attempt (success and failure), with the phone last-4 for a legible trail.
      await db.activityLog.create({
        data: {
          actorUserId: user.id,
          action: 'sms_email_waiting_sent',
          caseId: id,
          veteranId: existing.veteranId,
          detailsJson: {
            sent: smsResult.sent,
            phoneLast4,
            ...(smsResult.reason !== undefined ? { reason: smsResult.reason } : {}),
            ...(smsResult.code !== undefined ? { code: smsResult.code } : {}),
          },
        },
      });

      if (!smsResult.sent) {
        const reason = smsResult.reason ?? 'unknown';
        const msg =
          reason === 'invalid_number' ? 'The phone number on file isn’t a valid US mobile number.'
          : reason === 'no_api_key' ? 'The SMS service isn’t configured yet — please flag Dr. Ryan.'
          : (reason.startsWith('http_') || reason === 'network' || reason === 'exception') ? 'The SMS service could not send the text right now. Please try again shortly.'
          : 'The text could not be sent.';
        throw new HttpError(502, 'provider_unavailable', msg, { caseId: id, reason });
      }

      res.json({ data: { sent: true, phoneLast4 } });
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

      // BEST-EFFORT, FAIL-OPEN (2026-07-21): now that the assignment has COMMITTED, refresh the current
      // draft's pdf/docx to the newly-assigned signer's Section I so the "Open PDF" preview on an
      // unsigned draft matches the signer. NEVER throws (fully try/catch-wrapped internally) and is a
      // no-op when the render Lambda / S3 are unwired or the signer is Kasky. The assign response is
      // returned regardless — this can never break assign, approve/sign, save, or the drafter.
      await reRenderCurrentDraftForAssignedSigner(db, deps, id);

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
