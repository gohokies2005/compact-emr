import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { currentActor } from '../services/request-actor.js';
import { IN_FLIGHT_CASE_STATUSES } from '../services/case-status-transitions.js';
import { composeCredentialBlock } from '../services/credential-block.js';
import { buildUserAvatarKey, isUserAvatarS3Key } from '../services/s3-key-safety.js';
import type { AppDb, AppUserRecord, Role } from '../services/db-types.js';
import type { CognitoAdmin, StaffCredential } from '../services/cognito-admin.js';
import { assertCognitoPasswordPolicy } from '../services/cognito-admin.js';

const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'ops_staff', 'physician'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NPI_PATTERN = /^\d{10}$/;

// P3 avatar upload (UI sweep 2026-06-11): png/jpg/webp, <= 2 MB, presign-PUT -> register ->
// presigned-GET — mirrors the physician-signature flow (physicians.ts). Extension is derived
// server-side from the validated contentType, never from a client-supplied filename.
const AVATAR_TTL_SECONDS = 5 * 60;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_CONTENT_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

interface UsersRouterDeps {
  cognito?: CognitoAdmin;
  s3?: S3Client;
  bucketName?: string;
}

interface ParsedAvatarPresign { contentType: string; ext: 'png' | 'jpg' | 'webp'; sizeBytes: number }

function parseAvatarPresign(body: unknown): ParsedAvatarPresign {
  if (!isRecord(body)) throw new HttpError(400, 'bad_request', 'Request body must be an object');
  const contentType = body.contentType;
  const ext = typeof contentType === 'string' ? AVATAR_CONTENT_TYPES[contentType] : undefined;
  if (typeof contentType !== 'string' || ext === undefined) {
    throw new HttpError(400, 'bad_request', 'Avatar must be a PNG, JPEG, or WebP image (image/png, image/jpeg, image/webp).', { field: 'contentType', value: contentType });
  }
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_AVATAR_BYTES) {
    throw new HttpError(400, 'bad_request', 'sizeBytes must be a positive integer up to 2 MB', { field: 'sizeBytes', maxBytes: MAX_AVATAR_BYTES });
  }
  return { contentType, ext, sizeBytes };
}

/**
 * Self-or-admin gate for the avatar endpoints: any staff member may set THEIR OWN avatar
 * (target row's cognitoSub === caller's sub); admins may set anyone's. Wider than the
 * admin-only signature route by design — the identity block is an all-roles surface.
 */
async function requireSelfOrAdmin(db: AppDb, req: Request, targetUserId: string): Promise<AppUserRecord> {
  const actor = currentActor(req);
  const target = await db.appUser.findUnique({ where: { id: targetUserId } });
  if (target === null) throw new HttpError(404, 'not_found', 'Staff user not found', { userId: targetUserId });
  if (target.cognitoSub !== actor.sub && !actor.roles.includes('admin')) {
    throw new HttpError(403, 'forbidden', 'You can only change your own avatar (admins may change any).', { userId: targetUserId });
  }
  return target;
}

interface PhysicianProfileInput {
  npi: string; specialty: string; medicalLicense: string;
  boardName: string; boardAbbreviation: string; licenseState: string; licenseNumber: string;
  phone: string | null;
}
interface ParsedStaffCreate {
  email: string; name: string; roles: Role[];
  credential: StaffCredential;
  physician: PhysicianProfileInput | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function reqStr(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
    throw new HttpError(400, 'bad_request', `${key} is required (non-empty string under ${max} chars)`, { field: key });
  }
  return v.trim();
}

/** Map a Prisma unique-constraint violation (P2002 on npi / cognito_sub) to a clear 409. */
function rethrowUnique(err: unknown): never {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e && e.code === 'P2002') {
    const target = JSON.stringify(e.meta?.target ?? '');
    if (target.includes('npi')) throw new HttpError(409, 'conflict', 'A physician with this NPI already exists.', { field: 'npi' });
    if (target.includes('cognito')) throw new HttpError(409, 'conflict', 'This Cognito user is already linked.', { field: 'cognitoSub' });
    throw new HttpError(409, 'conflict', 'A unique field already exists.', {});
  }
  throw err as Error;
}

function parseStaffCreate(body: unknown): ParsedStaffCreate {
  if (!isRecord(body)) throw new HttpError(400, 'bad_request', 'Request body must be an object');
  const email = reqStr(body, 'email', 200).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'bad_request', 'email must be a valid email address', { field: 'email' });
  const name = reqStr(body, 'name', 120);

  const rolesRaw = body.roles;
  if (!Array.isArray(rolesRaw) || rolesRaw.length === 0) throw new HttpError(400, 'bad_request', 'roles must be a non-empty array', { field: 'roles' });
  const roles: Role[] = [];
  for (const r of rolesRaw) {
    if (typeof r !== 'string' || !ASSIGNABLE_ROLES.includes(r as Role)) {
      throw new HttpError(400, 'bad_request', `each role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, { field: 'roles', value: r });
    }
    if (!roles.includes(r as Role)) roles.push(r as Role);
  }

  const credKind = body.credential;
  let credential: StaffCredential;
  if (credKind === 'invite') {
    credential = { kind: 'invite' };
  } else if (credKind === 'temp_password') {
    // Shared policy check (min 12 + upper + lower + number + symbol) so the staff-create and
    // temp-password-reset paths can't drift — fails with a clean 400 instead of a Cognito 502.
    const pw = assertCognitoPasswordPolicy(body.tempPassword);
    credential = { kind: 'temp_password', password: pw };
  } else {
    throw new HttpError(400, 'bad_request', "credential must be 'invite' or 'temp_password'", { field: 'credential' });
  }

  const wantsPhysician = roles.includes('physician');
  let physician: PhysicianProfileInput | null = null;
  if (wantsPhysician) {
    if (!isRecord(body.physician)) throw new HttpError(400, 'bad_request', 'physician block is required when roles includes physician', { field: 'physician' });
    const p = body.physician;
    const npi = reqStr(p, 'npi', 10);
    if (!NPI_PATTERN.test(npi)) throw new HttpError(400, 'bad_request', 'npi must be exactly 10 digits', { field: 'physician.npi' });
    const phoneRaw = p.phone;
    physician = {
      npi,
      specialty: reqStr(p, 'specialty', 120),
      medicalLicense: reqStr(p, 'medicalLicense', 60),
      boardName: reqStr(p, 'boardName', 160),
      boardAbbreviation: reqStr(p, 'boardAbbreviation', 24),
      licenseState: reqStr(p, 'licenseState', 60),
      licenseNumber: reqStr(p, 'licenseNumber', 60),
      phone: typeof phoneRaw === 'string' && phoneRaw.trim().length > 0 ? phoneRaw.trim() : null,
    };
  } else if (body.physician !== undefined) {
    throw new HttpError(400, 'bad_request', 'physician block is only allowed when roles includes physician', { field: 'physician' });
  }

  return { email, name, roles, credential, physician };
}

/**
 * Staff directory + provisioning. GET is the assignment-picker source (admin + ops_staff). POST +
 * PATCH are admin-only staff onboarding/offboarding. Cognito is injected (deps.cognito) so the
 * route is stub-testable; the concrete impl (makeCognitoAdmin) is wired at mount when
 * COGNITO_USER_POOL_ID is set. Provisioning is Cognito-FIRST, DB-SECOND, and idempotent on email:
 * a failed DB write after Cognito succeeds is repaired by re-submitting the same form.
 */
export function createUsersRouter(db: AppDb, deps: UsersRouterDeps = {}): Router {
  const router = Router();
  const s3 = (): S3Client => deps.s3 ?? new S3Client({});
  const bucket = (): string | undefined => deps.bucketName ?? process.env.PHI_BUCKET_NAME;

  // Presigned GET for an avatar key, or null when unset/unconfigured. NEVER throws — the
  // identity block must render (silhouette fallback) even if S3 presigning is unavailable.
  async function avatarUrlFor(avatarS3Key: string | null): Promise<string | null> {
    const bucketName = bucket();
    if (avatarS3Key === null || bucketName === undefined) return null;
    try {
      return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucketName, Key: avatarS3Key }), { expiresIn: AVATAR_TTL_SECONDS });
    } catch {
      return null;
    }
  }

  router.get(
    '/users',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const roleParam = req.query.role;
      // Pickers see active staff only (a deactivated login can't authenticate); the admin staff
      // page passes includeInactive=true to also see/reactivate deactivated accounts.
      const where: Record<string, unknown> = {};
      if (req.query.includeInactive !== 'true') where.active = true;
      if (roleParam !== undefined) {
        if (typeof roleParam !== 'string' || !ASSIGNABLE_ROLES.includes(roleParam as Role)) {
          throw new HttpError(400, 'bad_request', `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, { role: roleParam });
        }
        where.roles = { some: { role: roleParam } };
      }
      const users = await db.appUser.findMany({ where, include: { roles: true }, orderBy: { email: 'asc' } });
      res.json({ data: users.map((u) => ({ id: u.id, email: u.email, name: u.name, active: u.active, roles: u.roles.map((r) => r.role), version: u.version })) });
    }),
  );

  // Messaging directory — the type-ahead source for the staff-message recipient picker. Readable by
  // EVERY staff role (physicians included): a physician could previously only pick the role aliases
  // because GET /users is admin/ops_staff-only, so they 403'd and saw no individuals (Ryan 2026-06-13).
  // Returns ONLY { sub, name, role } — minimal PII (no email/version) — and crucially keys each row by
  // the COGNITO SUB, which is the id the staff-message recipient rows match on (recipientSub). The old
  // picker addressed staff by AppUser.id, which never matched a JWT sub → individual messages were
  // misrouted for everyone. Rows without a cognitoSub are omitted (they can't receive a message).
  router.get(
    '/users/directory',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (_req: Request, res: Response) => {
      const staff = await db.appUser.findMany({ where: { active: true }, include: { roles: true } });
      const physicians = await db.physician.findMany({ where: { active: true } });
      const out: { sub: string; name: string; role: Role }[] = [];
      const seen = new Set<string>();
      for (const u of staff) {
        if (!u.cognitoSub) continue;
        const roles = u.roles.map((r) => r.role);
        // Classify by the ops/admin roles only. A physician-role AppUser (if one exists) is sourced
        // from the Physician table below — skip it here so it isn't mislabeled or duplicated.
        const role: Role | null = roles.includes('admin') ? 'admin' : roles.includes('ops_staff') ? 'ops_staff' : null;
        if (role === null) continue;
        out.push({ sub: u.cognitoSub, name: u.name ?? u.email, role });
        seen.add(u.cognitoSub);
      }
      for (const p of physicians) {
        if (!p.cognitoSub || seen.has(p.cognitoSub)) continue;
        out.push({ sub: p.cognitoSub, name: p.fullName, role: 'physician' });
        seen.add(p.cognitoSub);
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ data: out });
    }),
  );

  // Who am I? Resolves the CALLER's AppUser row from the JWT's cognito sub — the client needs its
  // own AppUser.id (assignedRnId etc. key on it, NOT the Cognito sub) for "my cases" filters. Open
  // to any authenticated staff role: it only ever returns the caller's own row. 404 (not 500) when
  // the login has no AppUser mapping (e.g. a Cognito-only admin) so the UI can degrade gracefully.
  router.get(
    '/users/me',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const me = await db.appUser.findUnique({ where: { cognitoSub: actor.sub }, include: { roles: true } });
      if (me === null) {
        throw new HttpError(404, 'not_found', 'No staff profile maps to this login (the Cognito user has no AppUser row). Ask an admin to provision your staff account.', { cognitoSub: actor.sub });
      }
      res.json({ data: { id: me.id, email: me.email, name: me.name, roles: me.roles.map((r) => r.role), avatarUrl: await avatarUrlFor(me.avatarS3Key ?? null) } });
    }),
  );

  // Avatar upload: presign -> client PUTs the image -> register the key (mirrors the physician
  // signature trio, scoped self-or-admin instead of admin-only). Display is the freshly-presigned
  // avatarUrl on /users/me — no separate download endpoint needed for the nav identity block.
  router.post(
    '/users/:id/avatar/presign',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const bucketName = bucket();
      if (bucketName === undefined) throw new HttpError(503, 'internal_error', 'PHI_BUCKET_NAME not configured');
      const id = String(req.params.id);
      await requireSelfOrAdmin(db, req, id);
      const { contentType, ext, sizeBytes } = parseAvatarPresign(req.body);
      const s3Key = buildUserAvatarKey(id, randomUUID(), ext);
      const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({
        Bucket: bucketName, Key: s3Key, ContentType: contentType, ContentLength: sizeBytes, ServerSideEncryption: 'aws:kms',
      }), { expiresIn: AVATAR_TTL_SECONDS });
      res.json({ data: { uploadUrl, s3Key, expiresInSeconds: AVATAR_TTL_SECONDS, requiredHeaders: { 'content-type': contentType, 'x-amz-server-side-encryption': 'aws:kms' } } });
    }),
  );

  router.post(
    '/users/:id/avatar',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const target = await requireSelfOrAdmin(db, req, id);
      const s3Key = typeof (req.body as Record<string, unknown> | undefined)?.s3Key === 'string' ? (req.body as Record<string, string>).s3Key : '';
      // The echoed key must match the safe pattern AND this user's own prefix — a leaked token
      // can't register a row pointing at another user's (or any other) phiBucket key.
      if (!isUserAvatarS3Key(s3Key) || !s3Key.startsWith(`avatars/${id}/`)) {
        throw new HttpError(400, 'bad_request', 's3Key does not match the safe avatars/<userId>/<uuid>.<ext> pattern for this user.', { field: 's3Key' });
      }
      const updated = await db.appUser.update({ where: { id: target.id }, data: { avatarS3Key: s3Key, version: { increment: 1 } } });
      res.json({ data: { id: updated.id, email: updated.email, name: updated.name, version: updated.version, avatarUrl: await avatarUrlFor(s3Key) } });
    }),
  );

  router.post(
    '/users',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      // Diagnostic (temporary): confirm the request reaches the Lambda + whether Cognito is wired.
      console.log(JSON.stringify({ msg: 'staff_provision_attempt', cognitoConfigured: cognito !== undefined }));
      if (cognito === undefined) throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      const actor = currentActor(req);
      const parsed = parseStaffCreate(req.body);

      // Pre-check by email (unique). A live user is a 409; an inactive one is a reactivation.
      const existing = await db.appUser.findUnique({ where: { email: parsed.email }, include: { roles: true } });
      if (existing !== null && existing.active) {
        throw new HttpError(409, 'conflict', 'A staff user with this email already exists.', { field: 'email' });
      }

      // Cognito FIRST (idempotent): create-or-find, add groups, set temp password if requested.
      let sub: string;
      try {
        ({ sub } = await cognito.provisionUser({ email: parsed.email, groups: parsed.roles, credential: parsed.credential }));
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        console.error(JSON.stringify({ msg: 'staff_provision_cognito_error', name: err?.name, message: (err?.message ?? '').slice(0, 300) }));
        throw new HttpError(502, 'internal_error', `Cognito provisioning failed: ${err?.name ?? 'error'}`, { reason: 'cognito_error' });
      }

      // DB SECOND (upserts → re-runnable). AppUser keyed on cognitoSub (the natural idempotency key).
      const user = await db.appUser.upsert({
        where: { cognitoSub: sub },
        update: { email: parsed.email, name: parsed.name, active: true },
        create: { cognitoSub: sub, email: parsed.email, name: parsed.name, active: true },
      });
      for (const role of parsed.roles) {
        await db.appUserRole.upsert({
          where: { userId_role: { userId: user.id, role } },
          update: {},
          create: { userId: user.id, role },
        });
      }

      let physicianId: string | null = null;
      let physicianReadyToSign = false;
      if (parsed.physician !== null) {
        const block = composeCredentialBlock({
          fullNameWithCredential: parsed.name,
          specialty: parsed.physician.specialty,
          npi: parsed.physician.npi,
          boardName: parsed.physician.boardName,
          boardAbbreviation: parsed.physician.boardAbbreviation,
          licenseState: parsed.physician.licenseState,
          licenseNumber: parsed.physician.licenseNumber,
        });
        const physician = await db.physician.create({
          data: {
            id: randomUUID(),
            cognitoSub: sub,
            fullName: parsed.name,
            npi: parsed.physician.npi,
            specialty: parsed.physician.specialty,
            medicalLicense: parsed.physician.medicalLicense,
            email: parsed.email,
            phone: parsed.physician.phone,
            credentialBlockJson: block,
          },
        }).catch(rethrowUnique);
        physicianId = physician.id;
        physicianReadyToSign = physician.signatureImageS3Key !== null; // false at create; signature uploaded separately
      }

      await db.activityLog.create({
        data: {
          actorUserId: actor.id,
          action: 'staff_provisioned',
          detailsJson: { targetSub: sub, email: parsed.email, roles: parsed.roles, credential: parsed.credential.kind, grantsAdmin: parsed.roles.includes('admin'), reactivated: existing !== null },
        },
      });

      res.status(201).json({ data: {
        id: user.id, cognitoSub: sub, email: user.email, name: user.name, roles: parsed.roles, active: true,
        credential: parsed.credential.kind, physicianId, physicianReadyToSign,
      } });
    }),
  );

  // PATCH: edit a staff member's display NAME and/or ACTIVE status (admin-only, optimistic-concurrency
  // via version). At least one of {name, active} must be supplied.
  //   - `active` toggles the login: Cognito enable/disable (the real access gate) + the DB flag (pickers).
  //   - `name` renames the display name across the staff directory / assignment pickers / actor-name
  //     resolver / staff messages. For a physician-linked row we ALSO sync Physician.fullName so the
  //     physician picker (which reads fullName, not AppUser.name) stays consistent — but we deliberately
  //     do NOT touch the LETTER credential block (credentialBlockJson): a signed-letter credential is a
  //     deliberate physician-profile edit, never a quick typo-fix. Name lives in the DB, so a name-only
  //     edit needs no Cognito call (works even where Cognito is unconfigured).
  // Added 2026-07-17 (Ryan: a staff last name was misspelled at onboarding and needed a correction path).
  router.patch(
    '/users/:id',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      const id = String(req.params.id);
      const body = isRecord(req.body) ? req.body : {};
      const version = body.version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new HttpError(400, 'bad_request', 'version is required and must be a positive integer', { field: 'version' });
      }

      const hasActive = body.active !== undefined;
      const hasName = body.name !== undefined;
      if (!hasActive && !hasName) {
        throw new HttpError(400, 'bad_request', 'Provide at least one of: name (non-empty string) or active (boolean)', { fields: ['name', 'active'] });
      }
      if (hasActive && typeof body.active !== 'boolean') {
        throw new HttpError(400, 'bad_request', 'active must be a boolean', { field: 'active' });
      }
      // reqStr trims + rejects empty / >120 (same rule as staff-create), so a whitespace-only rename 400s.
      const newName = hasName ? reqStr(body, 'name', 120) : undefined;

      // Toggling the login is the only path that needs Cognito; a rename is DB-only.
      if (hasActive && cognito === undefined) {
        throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      }

      const current = await db.appUser.findUnique({ where: { id }, include: { roles: true } });
      if (current === null) throw new HttpError(404, 'not_found', 'Staff user not found', { userId: id });
      if (current.version !== version) {
        throw new HttpError(409, 'conflict', 'Staff user version is stale', { userId: id, expectedVersion: current.version, receivedVersion: version });
      }

      // Don't strand in-flight work: refuse to deactivate an RN assigned to an active case.
      if (hasActive && body.active === false && current.active === true) {
        const inFlight = await db.case.count({ where: { assignedRnId: id, status: { in: [...IN_FLIGHT_CASE_STATUSES] } } });
        if (inFlight > 0) {
          throw new HttpError(409, 'conflict', `Cannot deactivate: this user is the RN liaison on ${inFlight} in-flight case(s). Reassign them first.`, { userId: id, inFlightCount: inFlight });
        }
      }

      // Cognito is the real access gate (disabling stops the JWT); the DB flag removes them from pickers.
      if (hasActive) await cognito!.setUserEnabled(current.email, body.active as boolean);

      const data: { active?: boolean; name?: string; version: { increment: number } } = { version: { increment: 1 } };
      if (hasActive) data.active = body.active as boolean;
      if (hasName) data.name = newName;
      const updated = await db.appUser.update({ where: { id }, data });

      // Sync the linked physician's DISPLAY name only (credential block untouched — see header).
      let physicianNameSynced = false;
      if (hasName && current.cognitoSub) {
        const linkedPhysician = await db.physician.findUnique({ where: { cognitoSub: current.cognitoSub } });
        if (linkedPhysician !== null && linkedPhysician.fullName !== newName) {
          await db.physician.update({ where: { id: linkedPhysician.id }, data: { fullName: newName as string } });
          physicianNameSynced = true;
        }
      }

      // Distinct audit actions so the log reads cleanly; a combined edit logs both.
      if (hasName && newName !== current.name) {
        await db.activityLog.create({
          data: { actorUserId: currentActor(req).id, action: 'staff_name_edited', detailsJson: { userId: id, email: current.email, oldName: current.name, newName, physicianNameSynced } },
        });
      }
      if (hasActive && body.active !== current.active) {
        await db.activityLog.create({
          data: { actorUserId: currentActor(req).id, action: body.active ? 'staff_reactivated' : 'staff_deactivated', detailsJson: { userId: id, email: current.email } },
        });
      }

      res.json({ data: { id: updated.id, email: updated.email, name: updated.name, active: updated.active, roles: current.roles.map((r) => r.role), version: updated.version } });
    }),
  );

  // Reset a staff member's password. Default = Cognito emails a reset code (no plaintext ever
  // leaves the server). Opt-in {mode:'temp_password', tempPassword} sets a known one-login temp
  // password (FORCE_CHANGE_PASSWORD). The password is NEVER echoed in the response.
  router.post(
    '/users/:id/reset-password',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      if (cognito === undefined) throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      const id = String(req.params.id);
      const user = await db.appUser.findUnique({ where: { id }, include: { roles: true } });
      if (user === null) throw new HttpError(404, 'not_found', 'Staff user not found', { userId: id });

      const body = isRecord(req.body) ? req.body : {};
      const mode = body.mode === 'temp_password' ? 'temp_password' : 'email_code';
      if (mode === 'temp_password') {
        const pw = assertCognitoPasswordPolicy(body.tempPassword);
        await cognito.setTempPassword(user.email, pw);
      } else {
        await cognito.resetPasswordEmail(user.email);
      }

      // Audit AFTER the Cognito call succeeds, BEFORE responding (matches POST /users ordering).
      await db.activityLog.create({
        data: { actorUserId: currentActor(req).id, action: 'staff_password_reset', detailsJson: { userId: id, email: user.email, mode } },
      });
      res.json({ data: { id: user.id, email: user.email, mode } });
    }),
  );

  // Unlock a staff member locked out of MFA (lost authenticator/phone): clear both MFA factors and
  // re-enable the login in one call. targetIsAdmin is recorded for audit visibility of admin resets.
  router.post(
    '/users/:id/unlock',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      if (cognito === undefined) throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      const id = String(req.params.id);
      const user = await db.appUser.findUnique({ where: { id }, include: { roles: true } });
      if (user === null) throw new HttpError(404, 'not_found', 'Staff user not found', { userId: id });
      const targetIsAdmin = user.roles.some((r) => r.role === 'admin');

      await cognito.clearMfa(user.email);

      await db.activityLog.create({
        data: { actorUserId: currentActor(req).id, action: 'staff_mfa_cleared', detailsJson: { userId: id, email: user.email, targetIsAdmin } },
      });
      res.json({ data: { id: user.id, email: user.email, targetIsAdmin } });
    }),
  );

  // Link an existing (orphaned) physician credential profile to a Cognito login. The profile was
  // created credential-only (cognitoSub null) so nobody can log into it. This create-or-finds the
  // Cognito user, mints an AppUser so the login carries the physician role (not a role-less login),
  // and stamps cognitoSub onto the EXISTING Physician row — preserving its NPI/signature/credential
  // block, which avoids the duplicate-NPI 409 that re-creating via POST /users would hit.
  router.post(
    '/physicians/:id/link-login',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      if (cognito === undefined) throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      const id = String(req.params.id);
      const physician = await db.physician.findUnique({ where: { id } });
      if (physician === null) throw new HttpError(404, 'not_found', 'Physician profile not found', { physicianId: id });
      if (physician.cognitoSub !== null) {
        throw new HttpError(409, 'conflict', 'This physician profile is already linked to a login.', { physicianId: id });
      }

      const body = isRecord(req.body) ? req.body : {};
      let credential: StaffCredential;
      if (body.credential === 'temp_password') {
        credential = { kind: 'temp_password', password: assertCognitoPasswordPolicy(body.tempPassword) };
      } else {
        credential = { kind: 'invite' };
      }

      // Cognito FIRST (idempotent create-or-find), then DB.
      let sub: string;
      try {
        ({ sub } = await cognito.provisionUser({ email: physician.email, groups: ['physician'], credential }));
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        console.error(JSON.stringify({ msg: 'physician_link_cognito_error', name: err?.name, message: (err?.message ?? '').slice(0, 300) }));
        throw new HttpError(502, 'internal_error', `Cognito provisioning failed: ${err?.name ?? 'error'}`, { reason: 'cognito_error' });
      }

      // AppUser keyed on the sub so the login carries the physician role.
      const role: Role = 'physician';
      const user = await db.appUser.upsert({
        where: { cognitoSub: sub },
        update: { email: physician.email, name: physician.fullName, active: true },
        create: { cognitoSub: sub, email: physician.email, name: physician.fullName, active: true },
      });
      await db.appUserRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        update: {},
        create: { userId: user.id, role },
      });

      // Stamp the login onto the EXISTING physician row (preserves NPI/signature/credential block).
      await db.physician.update({ where: { id }, data: { cognitoSub: sub } }).catch(rethrowUnique);

      await db.activityLog.create({
        data: { actorUserId: currentActor(req).id, action: 'physician_login_linked', detailsJson: { physicianId: id, email: physician.email, targetSub: sub, credential: credential.kind } },
      });
      res.json({ data: { physicianId: id, cognitoSub: sub, email: physician.email, appUserId: user.id, credential: credential.kind } });
    }),
  );

  return router;
}
