import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { currentActor } from '../services/request-actor.js';
import { composeCredentialBlock } from '../services/credential-block.js';
import type { AppDb, Role } from '../services/db-types.js';
import type { CognitoAdmin, StaffCredential } from '../services/cognito-admin.js';

const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'ops_staff', 'physician'];
// Setting a user inactive while they hold in-flight work would strand it (mirrors physicians.ts).
const IN_FLIGHT_STATUSES = ['drafting', 'physician_review', 'correction_requested', 'correction_review'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NPI_PATTERN = /^\d{10}$/;

interface UsersRouterDeps {
  cognito?: CognitoAdmin;
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
    const pw = body.tempPassword;
    if (typeof pw !== 'string' || pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) {
      throw new HttpError(400, 'bad_request', 'tempPassword must be >=8 chars with a letter, number, and symbol', { field: 'tempPassword' });
    }
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

  router.patch(
    '/users/:id',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const cognito = deps.cognito;
      if (cognito === undefined) throw new HttpError(503, 'internal_error', 'Staff provisioning is not configured in this environment.', { reason: 'cognito_unconfigured' });
      const id = String(req.params.id);
      const body = isRecord(req.body) ? req.body : {};
      const version = body.version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new HttpError(400, 'bad_request', 'version is required and must be a positive integer', { field: 'version' });
      }
      if (typeof body.active !== 'boolean') throw new HttpError(400, 'bad_request', 'active (boolean) is required', { field: 'active' });

      const current = await db.appUser.findUnique({ where: { id }, include: { roles: true } });
      if (current === null) throw new HttpError(404, 'not_found', 'Staff user not found', { userId: id });
      if (current.version !== version) {
        throw new HttpError(409, 'conflict', 'Staff user version is stale', { userId: id, expectedVersion: current.version, receivedVersion: version });
      }

      // Don't strand in-flight work: refuse to deactivate an RN assigned to an active case.
      if (body.active === false && current.active === true) {
        const inFlight = await db.case.count({ where: { assignedRnId: id, status: { in: IN_FLIGHT_STATUSES } } });
        if (inFlight > 0) {
          throw new HttpError(409, 'conflict', `Cannot deactivate: this user is the RN liaison on ${inFlight} in-flight case(s). Reassign them first.`, { userId: id, inFlightCount: inFlight });
        }
      }

      // Cognito is the real access gate (disabling stops the JWT); the DB flag removes them from pickers.
      await cognito.setUserEnabled(current.email, body.active);
      const updated = await db.appUser.update({ where: { id }, data: { active: body.active, version: { increment: 1 } } });
      await db.activityLog.create({
        data: { actorUserId: currentActor(req).id, action: body.active ? 'staff_reactivated' : 'staff_deactivated', detailsJson: { userId: id, email: current.email } },
      });
      res.json({ data: { id: updated.id, email: updated.email, name: updated.name, active: updated.active, roles: current.roles.map((r) => r.role), version: updated.version } });
    }),
  );

  return router;
}
