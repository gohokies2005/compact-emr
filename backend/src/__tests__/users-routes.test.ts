import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsersRouter } from '../routes/users.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, AppUserRecord, Role } from '../services/db-types.js';
import type { CognitoAdmin } from '../services/cognito-admin.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'auth' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'no' } }); return; }
      next();
    },
}));
// currentActor reads req.user (set below); stub to a stable actor.
vi.mock('../services/request-actor.js', () => ({
  currentActor: (req: express.Request) => {
    const u = (req as express.Request & { user?: MockUser }).user;
    const sub = u?.sub ?? 'anon';
    return { sub, email: undefined, roles: u?.roles ?? [], role: u?.roles?.[0] ?? 'admin', id: sub };
  },
}));

function u(over: Partial<AppUserRecord> = {}): AppUserRecord {
  return { id: 'U-1', cognitoSub: 'sub-1', email: 'a@x.test', name: 'A', active: true, roles: [{ role: 'ops_staff' }], version: 1, ...over };
}

const RN = u({ id: 'U-RN', cognitoSub: 'rn-sub', email: 'rn@x.test', name: 'RN', roles: [{ role: 'ops_staff' }] });
const ADMIN = u({ id: 'U-ADMIN', cognitoSub: 'a-sub', email: 'admin@x.test', name: 'Adm', roles: [{ role: 'admin' }, { role: 'ops_staff' }] });
const DOC = u({ id: 'U-DOC', cognitoSub: 'd-sub', email: 'doc@x.test', name: 'Doc', roles: [{ role: 'physician' }] });
const ALL = [ADMIN, DOC, RN];

function makeCognito(over: Partial<CognitoAdmin> = {}): CognitoAdmin {
  return {
    provisionUser: vi.fn(async () => ({ sub: 'new-sub-123' })),
    setUserEnabled: vi.fn(async () => undefined),
    resetPasswordEmail: vi.fn(async () => undefined),
    setTempPassword: vi.fn(async () => undefined),
    clearMfa: vi.fn(async () => undefined),
    ...over,
  };
}

function makeDb(opts: { existingByEmail?: AppUserRecord | null; byId?: AppUserRecord | null; inFlight?: number } = {}) {
  const findMany = vi.fn(async (a: { where?: { active?: boolean; roles?: { some?: { role?: string } } } }) => {
    const role = a.where?.roles?.some?.role;
    return (role === undefined ? ALL : ALL.filter((x) => x.roles.some((r) => r.role === role)));
  });
  const findUnique = vi.fn(async (a: { where?: { email?: string; id?: string; cognitoSub?: string } }) => {
    if (a.where?.email !== undefined) return opts.existingByEmail ?? null;
    if (a.where?.id !== undefined) return opts.byId ?? null;
    if (a.where?.cognitoSub !== undefined) return ALL.find((x) => x.cognitoSub === a.where?.cognitoSub) ?? null;
    return null;
  });
  const appUser = {
    findUnique, findMany,
    upsert: vi.fn(async () => u({ id: 'U-NEW', cognitoSub: 'new-sub-123', email: 'zzz@x.test', name: 'ZZZ', roles: [], version: 1 })),
    update: vi.fn(async (a: { data: { active?: boolean } }) => u({ id: 'U-NEW', active: a.data.active ?? true, version: 2 })),
  };
  const appUserRole = { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) };
  const physician = { create: vi.fn(async () => ({ id: 'PH-1', signatureImageS3Key: null })), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() };
  const caseDelegate = { count: vi.fn(async () => opts.inFlight ?? 0) };
  const activityLog = { create: vi.fn(async () => ({})) };
  const db = { appUser, appUserRole, physician, case: caseDelegate, activityLog } as unknown as AppDb;
  return { db, appUser, appUserRole, physician, activityLog };
}

function appFor(db: AppDb, cognito?: CognitoAdmin) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createUsersRouter(db, cognito ? { cognito } : {}));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'unexpected');
  });
  return app;
}

const VALID_RN = { email: 'zzz.nurse@x.test', name: 'ZZZ Nurse', roles: ['ops_staff'], credential: 'invite' };
const VALID_DOC = {
  email: 'zzz.doc@x.test', name: 'ZZZ Physician, DO', roles: ['physician'], credential: 'temp_password', tempPassword: 'Frn-Test-2026!',
  physician: { npi: '1234567890', specialty: 'Family Medicine', medicalLicense: 'NV-1', boardName: 'American Board of Family Medicine', boardAbbreviation: 'ABFM', licenseState: 'Nevada', licenseNumber: '12345' },
};

describe('GET /users — directory', () => {
  beforeEach(() => { mockUser = { sub: 'rn-sub', roles: ['ops_staff'] }; });

  it('filters to active ops_staff and returns id/email/name/active/roles', async () => {
    const { db, appUser } = makeDb();
    const res = await request(appFor(db, makeCognito())).get('/api/v1/users?role=ops_staff');
    expect(res.status).toBe(200);
    expect(appUser.findMany.mock.calls[0][0].where).toEqual({ active: true, roles: { some: { role: 'ops_staff' } } });
    expect(res.body.data[0]).toHaveProperty('active');
    expect(res.body.data[0]).not.toHaveProperty('cognitoSub');
  });

  it('rejects an invalid role with 400', async () => {
    const res = await request(appFor(makeDb().db, makeCognito())).get('/api/v1/users?role=superuser');
    expect(res.status).toBe(400);
  });

  it('CO-SIGN: surfaces coSigned:true for a co-signed physician-linked row (edit-form pre-fill)', async () => {
    mockUser = { sub: 'a-sub', roles: ['admin'] };
    const { db, physician } = makeDb();
    // DOC (cognitoSub d-sub) is co-signed; the others are not physician-linked here.
    physician.findMany.mockResolvedValue([{ cognitoSub: 'd-sub', coSignedByPhysicianId: 'PH-OWNER' }]);
    const res = await request(appFor(db, makeCognito())).get('/api/v1/users');
    expect(res.status).toBe(200);
    const doc = (res.body.data as { id: string; coSigned: boolean }[]).find((r) => r.id === 'U-DOC');
    expect(doc?.coSigned).toBe(true);
    // A non-physician row is coSigned:false.
    expect((res.body.data as { id: string; coSigned: boolean }[]).find((r) => r.id === 'U-RN')?.coSigned).toBe(false);
  });

  it('CO-SIGN: GET stays up (fail-open) when the physician lookup throws — coSigned:false, list still served', async () => {
    mockUser = { sub: 'a-sub', roles: ['admin'] };
    const { db, physician } = makeDb();
    physician.findMany.mockRejectedValue(new Error('relation "physicians" does not exist'));
    const res = await request(appFor(db, makeCognito())).get('/api/v1/users');
    expect(res.status).toBe(200);
    expect((res.body.data as { coSigned: boolean }[]).every((r) => r.coSigned === false)).toBe(true);
  });
});

describe('GET /users/directory — messaging recipient picker (physician-readable, keyed by cognito sub)', () => {
  it('open to physicians; returns staff + physicians as { sub, name, role } with minimal PII', async () => {
    const { db, physician } = makeDb();
    physician.findMany.mockResolvedValue([{ cognitoSub: 'ph-sub', fullName: 'House, Gregory MD', active: true }]);
    mockUser = { sub: 'd-sub', roles: ['physician'] }; // physician was 403 on /users — must NOT be here
    const res = await request(appFor(db, makeCognito())).get('/api/v1/users/directory');
    expect(res.status).toBe(200);
    // Minimal PII: sub + name + role only — never email/version (those are on the admin /users list).
    expect(res.body.data.every((r: Record<string, unknown>) => 'sub' in r && 'name' in r && 'role' in r && !('email' in r) && !('version' in r))).toBe(true);
    // Each staff row is keyed by the COGNITO SUB (the id recipient rows match on), not the AppUser id.
    const rn = res.body.data.find((r: { sub: string }) => r.sub === 'rn-sub');
    expect(rn).toMatchObject({ name: 'RN', role: 'ops_staff' });
    // The physician from the Physician table is present and labeled physician.
    expect(res.body.data.find((r: { sub: string }) => r.sub === 'ph-sub')).toMatchObject({ name: 'House, Gregory MD', role: 'physician' });
    // A physician-ROLE AppUser (DOC, cognito d-sub) is NOT emitted as ops_staff (no mislabel).
    expect(res.body.data.find((r: { sub: string }) => r.sub === 'd-sub')).toBeUndefined();
  });
});

describe('GET /users/me — caller identity (AppUser id, not the Cognito sub)', () => {
  it('200 with { id, email, name, roles } when an AppUser row maps to the caller sub', async () => {
    mockUser = { sub: 'rn-sub', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db, makeCognito())).get('/api/v1/users/me');
    expect(res.status).toBe(200);
    // avatarUrl is null here: the row has no avatarS3Key (presigned-GET coverage lives in users-avatar.test.ts).
    expect(res.body.data).toEqual({ id: 'U-RN', email: 'rn@x.test', name: 'RN', roles: ['ops_staff'], avatarUrl: null });
    expect(res.body.data).not.toHaveProperty('cognitoSub');
  });

  it('is open to physicians too (any authenticated staff role)', async () => {
    mockUser = { sub: 'd-sub', roles: ['physician'] };
    const res = await request(appFor(makeDb().db, makeCognito())).get('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('U-DOC');
  });

  it('404 with a clear message when the login has no AppUser row (degrade signal, not a 500)', async () => {
    mockUser = { sub: 'ghost-sub', roles: ['admin'] };
    const res = await request(appFor(makeDb().db, makeCognito())).get('/api/v1/users/me');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/no AppUser row/i);
  });

  it('401 unauthenticated', async () => {
    mockUser = undefined;
    const res = await request(appFor(makeDb().db, makeCognito())).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /users — staff provisioning', () => {
  beforeEach(() => { mockUser = { sub: 'a-sub', roles: ['admin'] }; });

  it('forbids a non-admin (403)', async () => {
    mockUser = { sub: 'rn-sub', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(403);
  });

  it('503 when Cognito is not configured', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(503);
  });

  it('provisions an ops_staff (invite) -> 201, no physician profile', async () => {
    const { db, appUser, appUserRole, physician } = makeDb();
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(201);
    expect(cognito.provisionUser).toHaveBeenCalledWith({ email: 'zzz.nurse@x.test', groups: ['ops_staff'], credential: { kind: 'invite' } });
    expect(((appUser.upsert as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { where: unknown }).where).toEqual({ cognitoSub: 'new-sub-123' });
    expect(appUserRole.upsert).toHaveBeenCalled();
    expect(physician.create).not.toHaveBeenCalled();
    expect(res.body.data.physicianId).toBeNull();
  });

  it('provisions a physician (temp_password) -> 201, creates profile w/ composed block', async () => {
    const { db, physician } = makeDb();
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send(VALID_DOC);
    expect(res.status).toBe(201);
    expect(((cognito.provisionUser as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { credential: unknown }).credential).toEqual({ kind: 'temp_password', password: 'Frn-Test-2026!' });
    const physCreate = ((physician.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { data: { cognitoSub: string; credentialBlockJson: { fullNameWithCredential: string } } }).data;
    expect(physCreate.cognitoSub).toBe('new-sub-123');
    expect(physCreate.credentialBlockJson.fullNameWithCredential).toBe('ZZZ Physician, DO');
    expect(res.body.data.physicianId).toBe('PH-1');
    expect(res.body.data.physicianReadyToSign).toBe(false);
  });

  it('400 when physician role but no physician block', async () => {
    const { physician, ...rest } = VALID_DOC; void physician;
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send(rest);
    expect(res.status).toBe(400);
  });

  it('400 when physician block present without physician role', async () => {
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send({ ...VALID_RN, physician: VALID_DOC.physician });
    expect(res.status).toBe(400);
  });

  it('400 on weak / missing tempPassword', async () => {
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send({ ...VALID_RN, credential: 'temp_password', tempPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('409 when an active user with that email exists', async () => {
    const res = await request(appFor(makeDb({ existingByEmail: RN }).db, makeCognito())).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(409);
  });

  it('reactivates an INACTIVE existing email (201, not 409) and re-provisions Cognito', async () => {
    const inactive = u({ id: 'U-RN', email: 'zzz.nurse@x.test', active: false, roles: [{ role: 'ops_staff' }] });
    const cognito = makeCognito();
    const res = await request(appFor(makeDb({ existingByEmail: inactive }).db, cognito)).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(201);
    expect(cognito.provisionUser).toHaveBeenCalled(); // re-provision (which now AdminEnableUsers the login)
  });

  it('400 on an invalid role value', async () => {
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send({ ...VALID_RN, roles: ['superuser'] });
    expect(res.status).toBe(400);
  });

  it('surfaces a sub-less Cognito failure as 502/internal (no AppUser written)', async () => {
    const { db, appUser } = makeDb();
    const cognito = makeCognito({ provisionUser: vi.fn(async () => { throw new Error('Cognito user has no sub attribute'); }) });
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(502);
    expect(appUser.upsert).not.toHaveBeenCalled();
  });
});

describe('PATCH /users/:id — deactivate', () => {
  beforeEach(() => { mockUser = { sub: 'a-sub', roles: ['admin'] }; });

  it('deactivates -> 200, disables the Cognito login', async () => {
    const { db, appUser } = makeDb({ byId: u({ id: 'U-RN', email: 'rn@x.test', active: true, version: 3 }) });
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).patch('/api/v1/users/U-RN').send({ version: 3, active: false });
    expect(res.status).toBe(200);
    expect(cognito.setUserEnabled).toHaveBeenCalledWith('rn@x.test', false);
    expect(appUser.update).toHaveBeenCalled();
  });

  it('409 deactivating an RN with in-flight cases', async () => {
    const { db } = makeDb({ byId: u({ id: 'U-RN', active: true, version: 3 }), inFlight: 2 });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-RN').send({ version: 3, active: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details.inFlightCount).toBe(2);
  });

  it('409 on a stale version', async () => {
    const { db } = makeDb({ byId: u({ id: 'U-RN', active: true, version: 5 }) });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-RN').send({ version: 3, active: false });
    expect(res.status).toBe(409);
  });

  it('404 when the user does not exist', async () => {
    const res = await request(appFor(makeDb({ byId: null }).db, makeCognito())).patch('/api/v1/users/NOPE').send({ version: 1, active: false });
    expect(res.status).toBe(404);
  });

  it('renames an RN -> 200, updates name + version, audits staff_name_edited, NO Cognito call', async () => {
    const { db, appUser, physician, activityLog } = makeDb({ byId: u({ id: 'U-RN', cognitoSub: 'rn-sub', email: 'rn@x.test', name: 'Kim Maribo', active: true, version: 4 }) });
    physician.findUnique.mockResolvedValue(null); // an RN has no physician credential row
    appUser.update.mockResolvedValue(u({ id: 'U-RN', email: 'rn@x.test', name: 'Kim Maribao', active: true, version: 5 }));
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).patch('/api/v1/users/U-RN').send({ version: 4, name: 'Kim Maribao' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Kim Maribao');
    expect(appUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'Kim Maribao', version: { increment: 1 } }) }));
    expect(cognito.setUserEnabled).not.toHaveBeenCalled(); // a rename is DB-only, never touches the login
    expect(activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'staff_name_edited' }) }));
  });

  it('renaming a physician-linked user syncs Physician.fullName but NOT the credential block', async () => {
    const { db, appUser, physician } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', email: 'doc@x.test', name: 'Old Name, DO', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    physician.findUnique.mockResolvedValue({ id: 'PH-9', cognitoSub: 'd-sub', fullName: 'Old Name, DO' });
    physician.update.mockResolvedValue({ id: 'PH-9' });
    appUser.update.mockResolvedValue(u({ id: 'U-DOC', name: 'New Name, DO', version: 3 }));
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-DOC').send({ version: 2, name: 'New Name, DO' });
    expect(res.status).toBe(200);
    expect(physician.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'PH-9' }, data: { fullName: 'New Name, DO' } }));
    expect(physician.update.mock.calls[0][0].data).not.toHaveProperty('credentialBlockJson');
  });

  it('name-only rename works even when Cognito is unconfigured', async () => {
    const { db, appUser, physician } = makeDb({ byId: u({ id: 'U-RN', cognitoSub: 'rn-sub', name: 'Typo', active: true, version: 1 }) });
    physician.findUnique.mockResolvedValue(null);
    appUser.update.mockResolvedValue(u({ id: 'U-RN', name: 'Fixed', version: 2 }));
    const res = await request(appFor(db)).patch('/api/v1/users/U-RN').send({ version: 1, name: 'Fixed' }); // no cognito dep
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Fixed');
  });

  it('400 when neither name nor active is provided', async () => {
    const { db } = makeDb({ byId: u({ id: 'U-RN', version: 1 }) });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-RN').send({ version: 1 });
    expect(res.status).toBe(400);
  });

  it('400 on a whitespace-only name', async () => {
    const { db } = makeDb({ byId: u({ id: 'U-RN', version: 1 }) });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-RN').send({ version: 1, name: '   ' });
    expect(res.status).toBe(400);
  });

  it('combined {name, active} edit: renames, toggles the login, syncs the physician, writes BOTH audit rows', async () => {
    const { db, appUser, physician, activityLog } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', email: 'doc@x.test', name: 'Old, DO', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    physician.findUnique.mockResolvedValue({ id: 'PH-9', cognitoSub: 'd-sub', fullName: 'Old, DO' });
    physician.update.mockResolvedValue({ id: 'PH-9' });
    appUser.update.mockResolvedValue(u({ id: 'U-DOC', name: 'New, DO', active: false, version: 3 }));
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).patch('/api/v1/users/U-DOC').send({ version: 2, name: 'New, DO', active: false });
    expect(res.status).toBe(200);
    expect(cognito.setUserEnabled).toHaveBeenCalledWith('doc@x.test', false);
    expect(physician.update).toHaveBeenCalledWith(expect.objectContaining({ data: { fullName: 'New, DO' } }));
    const actions = activityLog.create.mock.calls.map((c) => ((c as unknown[])[0] as { data: { action: string } }).data.action);
    expect(actions).toContain('staff_name_edited');
    expect(actions).toContain('staff_deactivated');
  });
});

describe('CO-SIGN (DPT docket 2026-07-19) — create + edit provider co-sign', () => {
  // The requesting admin (a-sub) is also the account-owner physician who co-signs.
  const OWNER = { id: 'PH-OWNER', cognitoSub: 'a-sub', fullName: 'Ryan J. Kasky, DO', active: true, signatureImageS3Key: 'sig/kasky.png' };
  const physCreateData = (physician: { create: ReturnType<typeof vi.fn> }) =>
    (physician.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

  beforeEach(() => { mockUser = { sub: 'a-sub', roles: ['admin'] }; });

  it('CREATE: coSignByOwner resolves the owner + stamps coSignedByPhysicianId on the new physician', async () => {
    const { db, physician } = makeDb();
    physician.findUnique.mockResolvedValue(OWNER); // owner (a-sub) is a signing physician w/ a signature
    const res = await request(appFor(db, makeCognito())).post('/api/v1/users').send({ ...VALID_DOC, coSignByOwner: true });
    expect(res.status).toBe(201);
    expect(physCreateData(physician).coSignedByPhysicianId).toBe('PH-OWNER');
    expect(res.body.data.coSigned).toBe(true);
  });

  it('CREATE: no coSignByOwner => coSignedByPhysicianId null (byte-identical solo path)', async () => {
    const { db, physician } = makeDb();
    const res = await request(appFor(db, makeCognito())).post('/api/v1/users').send(VALID_DOC);
    expect(res.status).toBe(201);
    expect(physCreateData(physician).coSignedByPhysicianId).toBeNull();
    expect(res.body.data.coSigned).toBe(false);
  });

  it('CREATE 400: coSignByOwner on a NON-physician row (validation, before any provisioning)', async () => {
    const { db, physician } = makeDb();
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send({ ...VALID_RN, coSignByOwner: true });
    expect(res.status).toBe(400);
    expect(cognito.provisionUser).not.toHaveBeenCalled();
    expect(physician.create).not.toHaveBeenCalled();
  });

  it('CREATE 400: the requesting login has NO physician profile (cannot co-sign)', async () => {
    const { db, physician } = makeDb();
    physician.findUnique.mockResolvedValue(null);
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send({ ...VALID_DOC, coSignByOwner: true });
    expect(res.status).toBe(400);
    // Resolved + rejected BEFORE any Cognito/DB provisioning side-effects.
    expect(cognito.provisionUser).not.toHaveBeenCalled();
    expect(physician.create).not.toHaveBeenCalled();
  });

  it('CREATE 400: the co-signer (owner) has NO signature image on file', async () => {
    const { db, physician } = makeDb();
    physician.findUnique.mockResolvedValue({ ...OWNER, signatureImageS3Key: null });
    const res = await request(appFor(db, makeCognito())).post('/api/v1/users').send({ ...VALID_DOC, coSignByOwner: true });
    expect(res.status).toBe(400);
    expect(physician.create).not.toHaveBeenCalled();
  });

  it('EDIT: coSignByOwner=true sets coSignedByPhysicianId on the linked physician + audits', async () => {
    const { db, appUser, physician, activityLog } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', email: 'doc@x.test', name: 'DPT Provider', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    // The provider being edited resolves by cognitoSub d-sub; the owner resolves by a-sub.
    physician.findUnique.mockImplementation(async (a: { where?: { cognitoSub?: string } }) => {
      if (a.where?.cognitoSub === 'd-sub') return { id: 'PH-DPT', cognitoSub: 'd-sub', fullName: 'DPT Provider', active: true, signatureImageS3Key: 'sig/dpt.png' };
      if (a.where?.cognitoSub === 'a-sub') return OWNER;
      return null;
    });
    appUser.update.mockResolvedValue(u({ id: 'U-DOC', name: 'DPT Provider', version: 3 }));
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-DOC').send({ version: 2, coSignByOwner: true });
    expect(res.status).toBe(200);
    expect(physician.update).toHaveBeenCalledWith({ where: { id: 'PH-DPT' }, data: { coSignedByPhysicianId: 'PH-OWNER' } });
    expect(res.body.data.coSigned).toBe(true);
    const actions = activityLog.create.mock.calls.map((c) => ((c as unknown[])[0] as { data: { action: string } }).data.action);
    expect(actions).toContain('staff_cosign_edited');
  });

  it('EDIT: coSignByOwner=false CLEARS the co-signer (no owner lookup)', async () => {
    const { db, appUser, physician } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    physician.findUnique.mockResolvedValue({ id: 'PH-DPT', cognitoSub: 'd-sub', fullName: 'DPT', active: true, signatureImageS3Key: 'sig/dpt.png' });
    appUser.update.mockResolvedValue(u({ id: 'U-DOC', version: 3 }));
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-DOC').send({ version: 2, coSignByOwner: false });
    expect(res.status).toBe(200);
    expect(physician.update).toHaveBeenCalledWith({ where: { id: 'PH-DPT' }, data: { coSignedByPhysicianId: null } });
    expect(res.body.data.coSigned).toBe(false);
  });

  it('EDIT 400: a physician cannot be their OWN co-signer (self-cosign)', async () => {
    mockUser = { sub: 'd-sub', roles: ['admin', 'physician'] }; // the owner IS the provider being edited
    const { db, physician } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    physician.findUnique.mockResolvedValue({ id: 'PH-DPT', cognitoSub: 'd-sub', fullName: 'Doc', active: true, signatureImageS3Key: 'sig/dpt.png' });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-DOC').send({ version: 2, coSignByOwner: true });
    expect(res.status).toBe(400);
    expect(physician.update).not.toHaveBeenCalled();
  });

  it('EDIT 400: the co-signer (owner) has NO signature on file', async () => {
    const { db, physician } = makeDb({ byId: u({ id: 'U-DOC', cognitoSub: 'd-sub', active: true, version: 2, roles: [{ role: 'physician' }] }) });
    physician.findUnique.mockImplementation(async (a: { where?: { cognitoSub?: string } }) => {
      if (a.where?.cognitoSub === 'd-sub') return { id: 'PH-DPT', cognitoSub: 'd-sub', fullName: 'DPT', active: true, signatureImageS3Key: 'sig/dpt.png' };
      if (a.where?.cognitoSub === 'a-sub') return { ...OWNER, signatureImageS3Key: null };
      return null;
    });
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-DOC').send({ version: 2, coSignByOwner: true });
    expect(res.status).toBe(400);
    expect(physician.update).not.toHaveBeenCalled();
  });

  it('EDIT 400: co-sign on a NON-physician-linked account', async () => {
    const { db, physician } = makeDb({ byId: u({ id: 'U-RN', cognitoSub: 'rn-sub', active: true, version: 1, roles: [{ role: 'ops_staff' }] }) });
    physician.findUnique.mockResolvedValue(null); // an RN has no physician row
    const res = await request(appFor(db, makeCognito())).patch('/api/v1/users/U-RN').send({ version: 1, coSignByOwner: true });
    expect(res.status).toBe(400);
    expect(physician.update).not.toHaveBeenCalled();
  });
});

describe('POST /physicians/:id/link-login — link an orphaned credential profile to a login', () => {
  beforeEach(() => { mockUser = { sub: 'a-sub', roles: ['admin'] }; });

  it('links an orphan (cognitoSub null): provisions Cognito, mints AppUser role, stamps cognitoSub, preserves NPI, audits', async () => {
    const { db, physician, appUserRole, activityLog } = makeDb();
    physician.findUnique.mockResolvedValue({ id: 'PH-1', email: 'doc@x.test', fullName: 'Dr X, DO', npi: '1112223334', cognitoSub: null });
    physician.update.mockResolvedValue({ id: 'PH-1', cognitoSub: 'new-sub-123' });
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/physicians/PH-1/link-login').send({ credential: 'invite' });
    expect(res.status).toBe(200);
    expect(cognito.provisionUser).toHaveBeenCalledWith({ email: 'doc@x.test', groups: ['physician'], credential: { kind: 'invite' } });
    expect(appUserRole.upsert).toHaveBeenCalled(); // login carries the physician role (not role-less)
    // UPDATE only stamps cognitoSub — NPI never in the update payload (preserved, avoids the dup-NPI 409)
    expect(physician.update).toHaveBeenCalledWith({ where: { id: 'PH-1' }, data: { cognitoSub: 'new-sub-123' } });
    expect(activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'physician_login_linked' }) }));
    expect(res.body.data.cognitoSub).toBe('new-sub-123');
  });

  it('409 already_linked when the profile already has a cognitoSub (no Cognito call)', async () => {
    const { db, physician } = makeDb();
    physician.findUnique.mockResolvedValue({ id: 'PH-1', email: 'doc@x.test', fullName: 'Dr X', npi: '1112223334', cognitoSub: 'already-linked-sub' });
    const cognito = makeCognito();
    const res = await request(appFor(db, cognito)).post('/api/v1/physicians/PH-1/link-login').send({ credential: 'invite' });
    expect(res.status).toBe(409);
    expect(cognito.provisionUser).not.toHaveBeenCalled();
  });

  it('404 when the physician profile does not exist', async () => {
    const { db, physician } = makeDb();
    physician.findUnique.mockResolvedValue(null);
    const res = await request(appFor(db, makeCognito())).post('/api/v1/physicians/PH-1/link-login').send({ credential: 'invite' });
    expect(res.status).toBe(404);
  });
});
