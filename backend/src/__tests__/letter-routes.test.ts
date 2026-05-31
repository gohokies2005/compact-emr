import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLetterRouter, type LetterRouterDeps } from '../routes/letter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, LetterRevisionRecord, PhysicianRecord, Role } from '../services/db-types.js';

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

const LETTER_TXT = [
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
  '',
  'The veteran has lumbosacral strain. It is documented.',
].join('\n');

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date('2026-05-30T00:00:00.000Z');
  return {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Lumbosacral strain',
    claimedConditions: ['Lumbosacral strain'], claimType: 'initial', framingChoice: 'direct',
    upstreamScCondition: null, veteranStatement: null, inServiceEvent: null,
    status: 'physician_review', cdsVerdict: 'accept', cdsOddsPct: 70, cdsRationale: null,
    assignedPhysicianId: 'PHYS-001', assignedRnId: null, refundEligible: false, currentVersion: 1,
    createdAt: now, updatedAt: now, version: 3, ...overrides,
  };
}

function physician(): PhysicianRecord {
  const now = new Date('2026-05-30T00:00:00.000Z');
  return {
    id: 'PHYS-001', cognitoSub: 'PHYS-SUB', fullName: 'Dr. Test, DO', npi: '1111111111',
    specialty: 'Family Medicine', medicalLicense: 'NV-DO0001', email: 'p@x.test', phone: null,
    signatureImageS3Key: null, active: true, createdAt: now, updatedAt: now, version: 1,
  };
}

function currentRevision(version = 1): LetterRevisionRecord {
  return {
    id: 'LR-0', caseId: 'CASE-1', version, parentVersion: version - 1, source: 'drafter_run',
    artifactTxtS3Key: `letter-revisions/CASE-1/v${version}/letter.txt`,
    artifactPdfS3Key: `letter-revisions/CASE-1/v${version}/letter.pdf`,
    artifactDocxS3Key: `letter-revisions/CASE-1/v${version}/letter.docx`,
    editedBy: 'drafter', editorRole: 'drafter', sanityJson: null, createdAt: new Date(),
  };
}

function makeDb(initialCase: CaseRecord = baseCase(), opts: { signOffs?: unknown[] } = {}) {
  const signOffs = opts.signOffs ?? [{ id: 'SO-1' }];
  const tx = {
    case: { findFirst: vi.fn(async () => initialCase), findUnique: vi.fn(async () => initialCase), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(async () => initialCase) },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Robert', lastName: 'Testcase' })) },
    letterRevision: { findFirst: vi.fn(async () => currentRevision(initialCase.currentVersion)), findMany: vi.fn(async () => []), create: vi.fn(async () => currentRevision()) },
    draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn(async () => ({})) },
    signOff: { findMany: vi.fn(async () => signOffs), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    fileReadStatus: { findMany: vi.fn(async () => []), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    physician: { findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === 'PHYS-SUB' ? physician() : null)), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, tx };
}

function deps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
  return {
    bucketName: 'phi-bucket',
    s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => LETTER_TXT } })) } as unknown as LetterRouterDeps['s3'],
    renderLetter: vi.fn(async (i) => ({ ok: true, version: i.version, keys: i.keys, sizes: { txt: 1, pdf: 1, docx: 1 } })),
    proposeSurgicalEdit: vi.fn(async () => ({ proposal: { operation: 'replace' as const, anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' }, costUsd: 0.02, model: 'claude-opus-4-8' })),
    ...over,
  };
}

function appFor(db: AppDb, d: LetterRouterDeps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createLetterRouter(db, d));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

describe('letter editor routes — surgical-AI / approve / decline', () => {
  beforeEach(() => { mockUser = { sub: 'PHYS-SUB', roles: ['physician'] }; });

  it('surgical-ai PROPOSE returns a proposal + preview + cost (no save)', async () => {
    const d = deps();
    const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai').send({ instruction: 'add the DC code' });
    expect(res.status).toBe(200);
    expect(res.body.data.proposal.new_text).toContain('DC 5237');
    expect(res.body.data.preview).toContain('lumbosacral strain (DC 5237)');
    expect(res.body.data.costUsd).toBe(0.02);
  });

  it('surgical-ai PROPOSE 503 when no proposer wired', async () => {
    const res = await request(appFor(makeDb().db, deps({ proposeSurgicalEdit: undefined }))).post('/api/v1/cases/CASE-1/letter/surgical-ai').send({ instruction: 'x' });
    expect(res.status).toBe(503);
  });

  it('surgical-ai APPLY advances the version + writes a surgical_ai revision', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/surgical-ai')
      .send({ apply: true, proposal: { operation: 'replace', anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' } });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(tx.letterRevision.create).toHaveBeenCalled();
    const arg = (tx.letterRevision.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.data.source).toBe('surgical_ai');
  });

  it('approve is BLOCKED (409) when no sign-off exists', async () => {
    const { db } = makeDb(baseCase(), { signOffs: [] });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('sign_off_required');
  });

  it('approve finalizes (draft:false), advances version, sets delivered', async () => {
    const { db, tx } = makeDb();
    const d = deps();
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
    expect(res.body.data.version).toBe(2);
    // final render must be draft:false
    expect((d.renderLetter as ReturnType<typeof vi.fn>).mock.calls[0][0].draft).toBe(false);
    const caseUpdate = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(caseUpdate.data.status).toBe('delivered');
  });

  it('approve HARD-FAILS (500) the version-match guard if render returns a stale version', async () => {
    const { db } = makeDb();
    const d = deps({ renderLetter: vi.fn(async (i) => ({ ok: true, version: i.version - 1, keys: i.keys, sizes: { txt: 1, pdf: 1, docx: 1 } })) });
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(500);
  });

  it('decline sets correction_requested + records the reason', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/decline').send({ reason: 'get the sleep study (AHI) and regenerate' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('correction_requested');
    const upd = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upd.data.status).toBe('correction_requested');
    expect(upd.data.operatorMessage).toMatch(/sleep study/);
  });

  it('decline 400 without a reason', async () => {
    const res = await request(appFor(makeDb().db, deps())).post('/api/v1/cases/CASE-1/letter/decline').send({});
    expect(res.status).toBe(400);
  });

  it('rejects ops_staff on approve with 403', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(403);
  });
});
