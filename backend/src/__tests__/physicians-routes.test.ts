import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhysiciansRouter } from '../routes/physicians.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, PhysicianRecord, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Auth required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

// getSignedUrl needs no AWS creds in tests — stub it.
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.example/url') }));

function makeDb(opts: { inFlight?: number } = {}) {
  const store = new Map<string, PhysicianRecord>();
  const inFlight = opts.inFlight ?? 0;
  const dupCheck = (npi: string, sub: string | null, exceptId?: string) => {
    for (const p of store.values()) {
      if (p.id === exceptId) continue;
      if (p.npi === npi) throw { code: 'P2002', meta: { target: ['npi'] } };
      if (sub !== null && p.cognitoSub === sub) throw { code: 'P2002', meta: { target: ['cognito_sub'] } };
    }
  };
  const physician = {
    findMany: vi.fn(async () => [...store.values()]),
    findUnique: vi.fn(async (a: { where: { id: string } }) => store.get(a.where.id) ?? null),
    findFirst: vi.fn(),
    create: vi.fn(async (a: { data: Record<string, unknown> }) => {
      const d = a.data;
      dupCheck(d.npi as string, (d.cognitoSub as string | null) ?? null);
      const now = new Date('2026-06-01T00:00:00.000Z');
      const row: PhysicianRecord = {
        id: d.id as string, cognitoSub: (d.cognitoSub as string | null) ?? null, fullName: d.fullName as string,
        npi: d.npi as string, specialty: d.specialty as string, medicalLicense: d.medicalLicense as string,
        email: d.email as string, phone: (d.phone as string | null) ?? null, signatureImageS3Key: null,
        credentialBlockJson: d.credentialBlockJson ?? null, active: true, createdAt: now, updatedAt: now, version: 1,
      };
      store.set(row.id, row);
      return row;
    }),
    update: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      const cur = store.get(a.where.id)!;
      const d = a.data;
      if (d.npi !== undefined || d.cognitoSub !== undefined) {
        dupCheck((d.npi as string) ?? cur.npi, d.cognitoSub !== undefined ? (d.cognitoSub as string | null) : cur.cognitoSub, cur.id);
      }
      const vraw = d.version as { increment?: number } | undefined;
      const version = vraw && typeof vraw === 'object' ? cur.version + (vraw.increment ?? 1) : cur.version;
      const { version: _v, ...rest } = d;
      const row = { ...cur, ...rest, version, updatedAt: new Date() } as PhysicianRecord;
      store.set(row.id, row);
      return row;
    }),
  };
  const caseDelegate = { count: vi.fn(async () => inFlight) };
  const db = { physician, case: caseDelegate } as unknown as AppDb;
  return { db, store };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createPhysiciansRouter(db, { bucketName: 'phi-bucket', s3: { } as never }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const VALID = { fullName: 'Dr. Jane Doe, MD', npi: '1234567890', specialty: 'Family Medicine', medicalLicense: 'NV-12345', email: 'jane@x.test', cognitoSub: 'sub-jane', boardName: 'American Board of Family Medicine', boardAbbreviation: 'ABFM', licenseState: 'Nevada', licenseNumber: '12345' };

// POST /physicians is RETIRED (410) — physician creation is consolidated into Staff (POST /users) so
// the Cognito login is provisioned with the profile. Tests that operate on an existing profile seed
// the store directly via this helper instead of creating through the (now retired) route.
function seedPhysician(store: Map<string, PhysicianRecord>, overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const id = overrides.id ?? 'PHYS-1';
  const row: PhysicianRecord = {
    id, cognitoSub: 'sub-jane', fullName: 'Dr. Jane Doe, MD', npi: '1234567890', specialty: 'Family Medicine',
    medicalLicense: 'NV-12345', email: 'jane@x.test', phone: null, signatureImageS3Key: null,
    credentialBlockJson: { fullNameWithCredential: 'Dr. Jane Doe, MD', specialty: 'Family Medicine', npi: '1234567890', boardName: 'American Board of Family Medicine', boardAbbreviation: 'ABFM', licenseState: 'Nevada', licenseNumber: '12345' },
    active: true, createdAt: now, updatedAt: now, version: 1, ...overrides,
  };
  store.set(row.id, row);
  return row;
}

describe('physician profile routes (D1)', () => {
  beforeEach(() => { mockUser = { sub: 'admin-sub', roles: ['admin'] }; });

  it('POST /physicians is RETIRED -> 410 Gone (create via Staff)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/physicians').send(VALID);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('gone');
    expect(res.body.error.message).toMatch(/Staff \(POST \/users\)/);
  });

  it('POST /physicians returns 410 even for an otherwise-invalid body (route fully retired)', async () => {
    const { db } = makeDb();
    const { boardName: _omit, ...withoutBoard } = VALID;
    const res = await request(appFor(db)).post('/api/v1/physicians').send(withoutBoard);
    expect(res.status).toBe(410);
  });

  it('ops_staff can LIST but the retired CREATE is still admin-gated (403 before 410)', async () => {
    const { db } = makeDb();
    mockUser = { sub: 'ops-sub', roles: ['ops_staff'] };
    expect((await request(appFor(db)).get('/api/v1/physicians')).status).toBe(200);
    // requireRole runs before the handler, so a non-admin gets 403, not 410.
    expect((await request(appFor(db)).post('/api/v1/physicians').send(VALID)).status).toBe(403);
  });

  it('PATCH a credential field recomposes the block', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const res = await request(appFor(db)).patch(`/api/v1/physicians/${created.id}`).send({ version: 1, fields: { licenseNumber: 'DO99999' } });
    expect(res.status).toBe(200);
    expect(res.body.data.licenseNumber).toBe('DO99999');
    expect(res.body.data.hasCredentialBlock).toBe(true);
    // unchanged credential fields survive the recompose
    expect(res.body.data.boardAbbreviation).toBe('ABFM');
  });

  it('PATCH fullName refreshes the block fullNameWithCredential (column<->block never drift)', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    await request(appFor(db)).patch(`/api/v1/physicians/${created.id}`).send({ version: 1, fields: { fullName: 'Dr. Jane A. Doe, MD' } });
    const block = store.get(created.id)!.credentialBlockJson as { fullNameWithCredential: string; boardAbbreviation: string };
    expect(block.fullNameWithCredential).toBe('Dr. Jane A. Doe, MD');
    expect(block.boardAbbreviation).toBe('ABFM'); // unchanged fields survive
  });

  it('PATCH an unrelated field on a no-block profile leaves credentialBlockJson untouched (no half-build)', async () => {
    const { db, store } = makeDb();
    seedPhysician(store, { id: 'LEGACY', cognitoSub: null, fullName: 'Dr. Old, MD', npi: '5555555555', specialty: 'FM', medicalLicense: 'NV-9', email: 'old@x.test', credentialBlockJson: null });
    const res = await request(appFor(db)).patch('/api/v1/physicians/LEGACY').send({ version: 1, fields: { email: 'new@x.test' } });
    expect(res.status).toBe(200);
    expect(store.get('LEGACY')!.credentialBlockJson).toBeNull();
  });

  it('PATCH stale version -> 409', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const res = await request(appFor(db)).patch(`/api/v1/physicians/${created.id}`).send({ version: 99, fields: { specialty: 'Cardiology' } });
    expect(res.status).toBe(409);
  });

  it('deactivating a physician with in-flight cases -> 409', async () => {
    const { db, store } = makeDb({ inFlight: 2 });
    const created = seedPhysician(store);
    const res = await request(appFor(db)).patch(`/api/v1/physicians/${created.id}`).send({ version: 1, fields: { active: false } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.inFlightCount).toBe(2);
  });

  it('signature presign rejects non-PNG -> 400', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const res = await request(appFor(db)).post(`/api/v1/physicians/${created.id}/signature/presign`).send({ contentType: 'image/jpeg', sizeBytes: 1000 });
    expect(res.status).toBe(400);
  });

  it('signature presign for PNG -> 200 with key + upload url', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const res = await request(appFor(db)).post(`/api/v1/physicians/${created.id}/signature/presign`).send({ contentType: 'image/png', sizeBytes: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data.s3Key).toMatch(new RegExp(`^physician-signatures/${created.id}/`));
  });

  it('signature register rejects a key outside this physician subtree -> 400', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const res = await request(appFor(db)).post(`/api/v1/physicians/${created.id}/signature`).send({ s3Key: `physician-signatures/SOMEONE-ELSE/${'a'.repeat(8)}-signature.png` });
    expect(res.status).toBe(400);
  });

  it('signature register with a valid key -> 200, hasSignature true', async () => {
    const { db, store } = makeDb();
    const created = seedPhysician(store);
    const key = `physician-signatures/${created.id}/abcdef12-3456-7890-abcd-ef1234567890-signature.png`;
    const res = await request(appFor(db)).post(`/api/v1/physicians/${created.id}/signature`).send({ s3Key: key });
    expect(res.status).toBe(200);
    expect(res.body.data.hasSignature).toBe(true);
  });
});
