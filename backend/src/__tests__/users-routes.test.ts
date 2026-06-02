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
    ...over,
  };
}

function makeDb(opts: { existingByEmail?: AppUserRecord | null; byId?: AppUserRecord | null; inFlight?: number } = {}) {
  const findMany = vi.fn(async (a: { where?: { active?: boolean; roles?: { some?: { role?: string } } } }) => {
    const role = a.where?.roles?.some?.role;
    return (role === undefined ? ALL : ALL.filter((x) => x.roles.some((r) => r.role === role)));
  });
  const findUnique = vi.fn(async (a: { where?: { email?: string; id?: string } }) => {
    if (a.where?.email !== undefined) return opts.existingByEmail ?? null;
    if (a.where?.id !== undefined) return opts.byId ?? null;
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

  it('400 on an invalid role value', async () => {
    const res = await request(appFor(makeDb().db, makeCognito())).post('/api/v1/users').send({ ...VALID_RN, roles: ['superuser'] });
    expect(res.status).toBe(400);
  });

  it('surfaces a sub-less Cognito failure as 502/internal (no AppUser written)', async () => {
    const { db, appUser } = makeDb();
    const cognito = makeCognito({ provisionUser: vi.fn(async () => { throw new Error('Cognito user has no sub attribute'); }) });
    const res = await request(appFor(db, cognito)).post('/api/v1/users').send(VALID_RN);
    expect(res.status).toBe(500);
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
});
