import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsersRouter } from '../routes/users.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, AppUserRecord, Role } from '../services/db-types.js';

/**
 * P3 avatar endpoints (UI sweep 2026-06-11): presign validation (content type, 2 MB cap),
 * self-or-admin authz, register-key safety (pattern + per-user prefix), and the presigned
 * avatarUrl on /users/me. Mirrors the physicians signature-route test harness (stubbed
 * getSignedUrl, in-memory db).
 */

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
vi.mock('../services/request-actor.js', () => ({
  currentActor: (req: express.Request) => {
    const u = (req as express.Request & { user?: MockUser }).user;
    const sub = u?.sub ?? 'anon';
    return { sub, email: undefined, roles: u?.roles ?? [], role: u?.roles?.[0] ?? 'admin', id: sub };
  },
}));

// getSignedUrl needs no AWS creds in tests — stub it (same pattern as physicians-routes.test.ts).
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.example/url') }));

function u(over: Partial<AppUserRecord> = {}): AppUserRecord {
  return { id: 'U-1', cognitoSub: 'sub-1', email: 'a@x.test', name: 'A', avatarS3Key: null, active: true, roles: [{ role: 'ops_staff' }], version: 1, ...over };
}

const RN = u({ id: 'U-RN', cognitoSub: 'rn-sub', email: 'rn@x.test', name: 'RN One' });
const OTHER = u({ id: 'U-OTHER', cognitoSub: 'other-sub', email: 'other@x.test', name: 'Other RN' });
const WITH_AVATAR = u({ id: 'U-AV', cognitoSub: 'av-sub', email: 'av@x.test', name: 'Ava Tarr', avatarS3Key: 'avatars/U-AV/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' });
const ALL = [RN, OTHER, WITH_AVATAR];

function makeDb() {
  const findUnique = vi.fn(async (a: { where?: { id?: string; cognitoSub?: string } }) => {
    if (a.where?.id !== undefined) return ALL.find((x) => x.id === a.where?.id) ?? null;
    if (a.where?.cognitoSub !== undefined) return ALL.find((x) => x.cognitoSub === a.where?.cognitoSub) ?? null;
    return null;
  });
  const update = vi.fn(async (a: { where: { id: string }; data: { avatarS3Key?: string } }) => {
    const cur = ALL.find((x) => x.id === a.where.id)!;
    return { ...cur, avatarS3Key: a.data.avatarS3Key ?? cur.avatarS3Key ?? null, version: cur.version + 1 };
  });
  const appUser = { findUnique, findMany: vi.fn(), upsert: vi.fn(), update };
  const db = { appUser } as unknown as AppDb;
  return { db, appUser };
}

function appFor(db: AppDb, opts: { bucket?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createUsersRouter(db, opts.bucket === false ? { s3: {} as never } : { s3: {} as never, bucketName: 'phi-bucket' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'unexpected');
  });
  return app;
}

beforeEach(() => { mockUser = { sub: 'rn-sub', roles: ['ops_staff'] }; });

describe('POST /users/:id/avatar/presign — validation + authz', () => {
  it('presigns a PUT for the caller\'s own avatar (png): key under avatars/<id>/, kms headers', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.data.uploadUrl).toBe('https://signed.example/url');
    expect(res.body.data.s3Key).toMatch(/^avatars\/U-RN\/[a-f0-9-]+\.png$/);
    expect(res.body.data.requiredHeaders).toEqual({ 'content-type': 'image/png', 'x-amz-server-side-encryption': 'aws:kms' });
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('accepts %s and derives the .%s extension server-side', async (contentType, ext) => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar/presign').send({ contentType, sizeBytes: 2048 });
    expect(res.status).toBe(200);
    expect(res.body.data.s3Key).toMatch(new RegExp(`^avatars/U-RN/[a-f0-9-]+\\.${ext}$`));
  });

  it('400 on a non-image content type', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'application/pdf', sizeBytes: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PNG, JPEG, or WebP/);
  });

  it('400 over the 2 MB cap', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 2 * 1024 * 1024 + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('400 on a non-integer / non-positive size', async () => {
    const app = appFor(makeDb().db);
    expect((await request(app).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 0 })).status).toBe(400);
    expect((await request(app).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1.5 })).status).toBe(400);
  });

  it('403 when a non-admin targets someone else\'s avatar', async () => {
    mockUser = { sub: 'rn-sub', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-OTHER/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(403);
  });

  it('admin may presign for anyone', async () => {
    mockUser = { sub: 'rn-sub', roles: ['admin'] };
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-OTHER/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.data.s3Key).toMatch(/^avatars\/U-OTHER\//);
  });

  it('404 when the target user does not exist', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/NOPE/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(404);
  });

  it('401 unauthenticated; 503 when the bucket is not configured', async () => {
    mockUser = undefined;
    expect((await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1 })).status).toBe(401);
    mockUser = { sub: 'rn-sub', roles: ['ops_staff'] };
    const prevBucket = process.env.PHI_BUCKET_NAME;
    delete process.env.PHI_BUCKET_NAME;
    try {
      expect((await request(appFor(makeDb().db, { bucket: false })).post('/api/v1/users/U-RN/avatar/presign').send({ contentType: 'image/png', sizeBytes: 1 })).status).toBe(503);
    } finally {
      if (prevBucket !== undefined) process.env.PHI_BUCKET_NAME = prevBucket;
    }
  });
});

describe('POST /users/:id/avatar — register the echoed key', () => {
  const GOOD_KEY = 'avatars/U-RN/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png';

  it('registers a safe own-prefix key, bumps version, returns a fresh avatarUrl', async () => {
    const { db, appUser } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/users/U-RN/avatar').send({ s3Key: GOOD_KEY });
    expect(res.status).toBe(200);
    expect(appUser.update).toHaveBeenCalledWith({ where: { id: 'U-RN' }, data: { avatarS3Key: GOOD_KEY, version: { increment: 1 } } });
    expect(res.body.data.avatarUrl).toBe('https://signed.example/url');
  });

  it('400 on a key outside this user\'s avatars/<id>/ prefix (another user\'s valid key)', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-RN/avatar').send({ s3Key: 'avatars/U-OTHER/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' });
    expect(res.status).toBe(400);
  });

  it('400 on traversal / wrong prefix / wrong extension', async () => {
    const app = appFor(makeDb().db);
    for (const bad of ['avatars/../secrets/leak.png', 'cases/U-RN/a1b2.png', 'avatars/U-RN/a1b2c3.exe', '']) {
      expect((await request(app).post('/api/v1/users/U-RN/avatar').send({ s3Key: bad })).status).toBe(400);
    }
  });

  it('403 registering on someone else\'s row without admin', async () => {
    const res = await request(appFor(makeDb().db)).post('/api/v1/users/U-OTHER/avatar').send({ s3Key: 'avatars/U-OTHER/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' });
    expect(res.status).toBe(403);
  });
});

describe('GET /users/me — presigned avatarUrl', () => {
  it('returns a presigned avatarUrl when the row has an avatarS3Key', async () => {
    mockUser = { sub: 'av-sub', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db)).get('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBe('https://signed.example/url');
    expect(res.body.data.name).toBe('Ava Tarr');
  });

  it('returns avatarUrl null when no avatar is set', async () => {
    mockUser = { sub: 'rn-sub', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db)).get('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
  });
});
