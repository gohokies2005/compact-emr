import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterClientRouter } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

/**
 * Import final letter (2026-06-14). POST /cases/:id/letter/import-presign + /import let an
 * admin/ops_staff drop an already-FINISHED letter PDF onto a case so it lands in the RN review
 * queue and flows RN -> physician -> delivery. No re-render — exact PDF bytes preserved.
 *
 * The commit route mirrors the drafter /complete happy path: DraftJob (done) + LetterRevision
 * (external_import) + Case (currentVersion=N, status='rn_review', version increment) in ONE
 * transaction. These tests assert that shape, the s3Key ownership/pattern rejections, role-gating,
 * and idempotency — without real AWS (S3 + presigner are mocked).
 */

// ── S3 + presigner mocks ───────────────────────────────────────────────────
const s3Send = vi.fn(async () => ({})); // HeadObject + PutObject both resolve OK by default
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = s3Send; },
  GetObjectCommand: class { constructor(public args: unknown) {} },
  HeadObjectCommand: class { constructor(public args: unknown) {} },
  PutObjectCommand: class { constructor(public args: unknown) {} },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://s3.test/presigned-put'),
}));

interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

vi.mock('../services/request-actor.js', () => ({
  currentActor: (req: express.Request) => {
    const u = (req as express.Request & { user?: MockUser }).user;
    return { sub: u?.sub ?? 'X', email: u?.email ?? null, roles: u?.roles ?? [], role: u?.roles?.[0] ?? 'ops_staff' };
  },
}));

interface Captured {
  draftJob?: Record<string, unknown>;
  letterRevision?: Record<string, unknown>;
  caseUpdate?: Record<string, unknown>;
  activity?: Record<string, unknown>;
}

function makeDb(opts: { currentVersion?: number; existingRevAtVersion?: number | null; maxDraftVersion?: number | null } = {}) {
  const captured: Captured = {};
  const caseRow = {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Lumbosacral strain', status: 'records',
    assignedPhysicianId: 'PHYS-1', assignedRnId: 'RN-1',
    currentVersion: opts.currentVersion ?? 2, version: 5, createdAt: new Date(), updatedAt: new Date(),
  };
  const tx = {
    draftJob: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { captured.draftJob = a.data; return { id: a.data.id, ...a.data }; }) },
    letterRevision: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { captured.letterRevision = a.data; return a.data; }) },
    case: { update: vi.fn(async (a: { data: Record<string, unknown> }) => { captured.caseUpdate = a.data; return { ...caseRow, ...a.data }; }) },
    activityLog: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { captured.activity = a.data; return a.data; }) },
  };
  const db = {
    case: { findFirst: vi.fn(async () => caseRow) },
    draftJob: { findFirst: vi.fn(async () => (opts.maxDraftVersion != null ? { version: opts.maxDraftVersion } : null)) },
    letterRevision: { findFirst: vi.fn(async () => (opts.existingRevAtVersion != null ? { id: 'REV-X', version: opts.existingRevAtVersion } : null)) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as AppDb;
  return { db, captured, tx };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createDrafterClientRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('Import final letter (2026-06-14)', () => {
  beforeEach(() => {
    mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] };
    process.env.PHI_BUCKET_NAME = 'phi-test-bucket';
    s3Send.mockReset();
    s3Send.mockResolvedValue({});
  });

  describe('POST /letter/import-presign', () => {
    it('presigns a PUT to the next version key and returns version + required headers', async () => {
      const { db } = makeDb({ currentVersion: 2, maxDraftVersion: 3 });
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import-presign').send({});
      expect(res.status).toBe(200);
      // next version = max(maxDraftVersion 3, currentVersion 2) + 1 = 4
      expect(res.body.data.version).toBe(4);
      expect(res.body.data.s3Key).toBe('drafter-artifacts/CASE-1/v4/imported-letter.pdf');
      expect(res.body.data.uploadUrl).toBe('https://s3.test/presigned-put');
      expect(res.body.data.requiredHeaders['content-type']).toBe('application/pdf');
      expect(res.body.data.requiredHeaders['x-amz-server-side-encryption']).toBe('aws:kms');
    });

    it('403s a physician (not admin/ops_staff)', async () => {
      mockUser = { sub: 'DOC', roles: ['physician'] };
      const { db } = makeDb();
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import-presign').send({});
      expect(res.status).toBe(403);
    });
  });

  describe('POST /letter/import — commit', () => {
    const goodKey = 'drafter-artifacts/CASE-1/v3/imported-letter.pdf';

    it('creates DraftJob(done) + LetterRevision(external_import) + Case(rn_review, currentVersion, version++)', async () => {
      const { db, captured } = makeDb({ currentVersion: 2 });
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: goodKey, filename: 'final.pdf' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, version: 3 }));

      expect(captured.draftJob).toEqual(expect.objectContaining({ caseId: 'CASE-1', version: 3, state: 'done', artifactPdfS3Key: goodKey }));
      expect(captured.letterRevision).toEqual(expect.objectContaining({
        caseId: 'CASE-1', version: 3, parentVersion: 2, source: 'external_import',
        artifactPdfS3Key: goodKey, artifactDocxS3Key: null, editedBy: 'OPS-SUB', editorRole: 'ops_staff',
      }));
      expect(captured.caseUpdate).toEqual(expect.objectContaining({ currentVersion: 3, status: 'rn_review', version: { increment: 1 } }));
      expect(captured.activity).toEqual(expect.objectContaining({ action: 'letter_imported', caseId: 'CASE-1' }));
    });

    it('rejects an s3Key for a DIFFERENT case (ownership)', async () => {
      const { db } = makeDb();
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: 'drafter-artifacts/CASE-2/v3/imported-letter.pdf' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/does not belong to this case/i);
    });

    it('rejects a pattern-unsafe s3Key (traversal / wrong prefix)', async () => {
      const { db } = makeDb();
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: 'cases/CASE-1/evil.pdf' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not a valid drafter-artifacts key/i);
    });

    it('rejects a non-PDF key', async () => {
      const { db } = makeDb();
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: 'drafter-artifacts/CASE-1/v3/v3.txt' });
      expect(res.status).toBe(400);
    });

    it('is idempotent — a LetterRevision already at the version no-ops gracefully', async () => {
      const { db, captured } = makeDb({ existingRevAtVersion: 3 });
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: goodKey });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, version: 3, alreadyImported: true }));
      expect(captured.draftJob).toBeUndefined(); // no new rows
    });

    it('409s when the uploaded PDF is missing in S3 (HeadObject throws)', async () => {
      const { db } = makeDb();
      s3Send.mockRejectedValueOnce(new Error('NoSuchKey'));
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: goodKey });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/no uploaded pdf/i);
    });

    it('403s a physician on commit', async () => {
      mockUser = { sub: 'DOC', roles: ['physician'] };
      const { db } = makeDb();
      const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/letter/import').send({ s3Key: goodKey });
      expect(res.status).toBe(403);
    });
  });
});
