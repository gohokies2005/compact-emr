import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeApproveBlockers, type ApproveBlockerDeps } from '../services/approve-blockers.js';
import { createCasesRouter } from '../routes/cases.js';
import { KASKY_CREDENTIALS } from '../services/credential-block.js';
import type { AppDb, PhysicianRecord, Role } from '../services/db-types.js';

/**
 * Fix 3 of the sign-off incident (2026-06-09): the physician completed the whole attestation
 * popup and only THEN hit the approve 409 (signer-name gate). computeApproveBlockers is the
 * advisory pre-flight mirror of the POST /letter/approve gates, served on GET /cases/:id
 * (physician_review only) so the review page can warn BEFORE the physician attests.
 */

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

const LETTER_NAMES_KASKY = 'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.\n\nThe veteran has lumbosacral strain.';
const LETTER_NO_NAME = 'The veteran has a chronic back condition documented in the record.';

function physician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-06-09T00:00:00.000Z');
  return {
    id: 'PHYS-001', cognitoSub: 'PHYS-SUB', fullName: 'Ryan J. Kasky, DO', npi: '1073018958',
    specialty: 'Family Medicine', medicalLicense: 'NV-DO2996', email: 'p@x.test', phone: null,
    signatureImageS3Key: 'physician-signatures/PHYS-001/abc-signature.png',
    credentialBlockJson: { ...KASKY_CREDENTIALS },
    active: true, createdAt: now, updatedAt: now, version: 1, ...overrides,
  };
}

interface DbOpts {
  readonly fileReadRows?: unknown[];
  readonly revision?: { version: number; artifactTxtS3Key: string } | null;
  readonly signer?: PhysicianRecord | null;
  readonly roster?: PhysicianRecord[];
}

function makeDb(opts: DbOpts = {}) {
  const revision = opts.revision === undefined
    ? { id: 'LR-1', caseId: 'CASE-1', version: 1, artifactTxtS3Key: 'letter-revisions/CASE-1/v1/letter.txt', artifactPdfS3Key: 'p', artifactDocxS3Key: 'd' }
    : opts.revision;
  const signer = opts.signer === undefined ? physician() : opts.signer;
  const roster = opts.roster ?? [physician()];
  const tx = {
    fileReadStatus: { findMany: vi.fn(async () => opts.fileReadRows ?? []) },
    letterRevision: { findFirst: vi.fn(async () => revision) },
    draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    physician: {
      findFirst: vi.fn(async (a: { where?: { id?: string } }) => (signer !== null && a.where?.id === signer.id ? signer : null)),
      findMany: vi.fn(async () => roster),
      findUnique: vi.fn(async () => null),
    },
  };
  return { db: tx as unknown as AppDb, tx };
}

function s3Deps(text: string): ApproveBlockerDeps {
  return {
    bucketName: 'phi-bucket',
    s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => text } })) } as unknown as ApproveBlockerDeps['s3'],
  };
}

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Lumbosacral strain', claimType: 'initial',
    status: 'physician_review', assignedPhysicianId: 'PHYS-001', assignedRnId: null,
    refundEligible: false, currentVersion: 1, version: 3,
    createdAt: new Date('2026-06-09T00:00:00.000Z'), updatedAt: new Date('2026-06-09T00:00:00.000Z'),
    ...overrides,
  };
}

describe('computeApproveBlockers (advisory pre-flight mirror of the approve gates)', () => {
  it('returns [] for a fully provisioned case (chart ready, letter present, signer named)', async () => {
    const { db } = makeDb();
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers).toEqual([]);
  });

  it('flags chart_not_ready when a file still needs an RN manual summary', async () => {
    const { db } = makeDb({ fileReadRows: [{ id: 'F1', filePath: 'cases/CASE-1/scan.pdf', terminalStatus: 'manual_summary_required', manualSummary: null, attemptsJson: [] }] });
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers.map((b) => b.code)).toEqual(['chart_not_ready']);
    expect(blockers[0]?.message).toContain('1 file(s)');
  });

  it('flags no_letter when no current revision or draft job exists', async () => {
    const { db } = makeDb({ revision: null });
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers.map((b) => b.code)).toEqual(['no_letter']);
  });

  it('flags no_assigned_physician and stops (every later check keys off the signer)', async () => {
    const { db, tx } = makeDb();
    const blockers = await computeApproveBlockers(db, caseRow({ assignedPhysicianId: null }) as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers.map((b) => b.code)).toEqual(['no_assigned_physician']);
    expect(tx.physician.findFirst).not.toHaveBeenCalled();
  });

  it('flags assigned_physician_not_found when the physician row is missing', async () => {
    const { db } = makeDb({ signer: null });
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers.map((b) => b.code)).toEqual(['assigned_physician_not_found']);
  });

  it('collects MULTIPLE blockers: inactive signer + missing signature in one pass', async () => {
    const { db } = makeDb({ signer: physician({ active: false, signatureImageS3Key: null }) });
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NAMES_KASKY));
    expect(blockers.map((b) => b.code)).toEqual(['assigned_physician_inactive', 'signer_signature_missing']);
    expect(blockers[0]?.message).toContain('Ryan J. Kasky, DO is inactive');
  });

  it('flags signer_credentials_incomplete and SKIPS the text checks (no creds to match against)', async () => {
    const { db } = makeDb({ signer: physician({ credentialBlockJson: null }) });
    const deps = s3Deps(LETTER_NO_NAME);
    const blockers = await computeApproveBlockers(db, caseRow() as never, deps);
    expect(blockers.map((b) => b.code)).toEqual(['signer_credentials_incomplete']);
    expect((deps.s3 as unknown as { send: unknown }).send).not.toHaveBeenCalled();
  });

  it('flags signer_name_absent — the exact gate that burned the hour — with the gate\'s own message', async () => {
    const { db } = makeDb();
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps(LETTER_NO_NAME));
    expect(blockers.map((b) => b.code)).toEqual(['signer_name_absent']);
    expect(blockers[0]?.message).toContain('the letter does not name the assigned signing physician (Ryan J. Kasky, DO)');
  });

  it('substitutes signer sentinels BEFORE the name check (a sentinel letter is not a false positive)', async () => {
    const { db } = makeDb();
    const blockers = await computeApproveBlockers(db, caseRow() as never, s3Deps('[[SIGNER_CREDENTIALS]]\n\nBody.\n\n[[SIGNER_BLOCK]]'));
    expect(blockers).toEqual([]);
  });

  it('flags foreign_signer_name when the letter also names another active physician', async () => {
    const jane = physician({
      id: 'PHYS-002', cognitoSub: 'JANE-SUB', fullName: 'Jane A. Doe, MD', npi: '1999999999',
      credentialBlockJson: { ...KASKY_CREDENTIALS, fullNameWithCredential: 'Jane A. Doe, MD' },
    });
    const { db } = makeDb({ roster: [physician(), jane] });
    const blockers = await computeApproveBlockers(
      db, caseRow() as never,
      s3Deps(`${LETTER_NAMES_KASKY}\n\nCo-reviewed with Jane A. Doe, MD.`),
    );
    expect(blockers.map((b) => b.code)).toEqual(['foreign_signer_name']);
    expect(blockers[0]?.message).toContain('Jane A. Doe, MD');
  });

  it('fail-open: with NO S3 wired the text checks are skipped, cheap checks still run', async () => {
    const { db } = makeDb({ signer: physician({ signatureImageS3Key: null }) });
    const blockers = await computeApproveBlockers(db, caseRow() as never, {});
    expect(blockers.map((b) => b.code)).toEqual(['signer_signature_missing']); // no signer_name_absent
  });
});

// ── Route integration: GET /cases/:id serves the flags (physician_review only, fail-open) ──

function makeRouteDb(row: Record<string, unknown>, opts: DbOpts & { fileReadThrows?: boolean } = {}) {
  const { tx } = makeDb(opts);
  if (opts.fileReadThrows === true) {
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('relation "FileReadStatus" does not exist'));
  }
  const db = {
    ...tx,
    case: { findFirst: vi.fn(async () => row), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1' })) },
    activityLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return db;
}

function appFor(db: AppDb, deps: ApproveBlockerDeps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCasesRouter(db, deps));
  return app;
}

describe('GET /cases/:id approveBlockers pre-flight (route wiring)', () => {
  // Structural spy type — keeps this file agnostic to the vitest MockInstance generics.
  let warnSpy: { mock: { calls: unknown[][] } };
  beforeEach(() => {
    mockUser = { sub: 'USER-1', email: 'a@example.com', roles: ['admin'] };
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('serves approveBlockers on a physician_review case (signer-name gate surfaced pre-attest)', async () => {
    const db = makeRouteDb(caseRow());
    const res = await request(appFor(db, s3Deps(LETTER_NO_NAME))).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.approveBlockers).toEqual([
      { code: 'signer_name_absent', message: expect.stringContaining('does not name the assigned signing physician') },
    ]);
  });

  it('serves an EMPTY approveBlockers array when nothing blocks (page shows no banner)', async () => {
    const db = makeRouteDb(caseRow());
    const res = await request(appFor(db, s3Deps(LETTER_NAMES_KASKY))).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.approveBlockers).toEqual([]);
  });

  it('OMITS the field outside physician_review (no pre-flight cost on every case load)', async () => {
    const db = makeRouteDb(caseRow({ status: 'drafting' }));
    const res = await request(appFor(db, s3Deps(LETTER_NO_NAME))).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.approveBlockers).toBeUndefined();
  });

  it('FAIL-OPEN: a pre-flight crash omits the field, the GET still 200s, and the failure is logged (not silent)', async () => {
    const db = makeRouteDb(caseRow(), { fileReadThrows: true });
    const res = await request(appFor(db, s3Deps(LETTER_NO_NAME))).get('/api/v1/cases/CASE-1');
    expect(res.status).toBe(200);
    expect(res.body.data.approveBlockers).toBeUndefined();
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).find((raw) => raw.includes('approve_blockers_unavailable'));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged as string)).toMatchObject({
      msg: 'approve_blockers_unavailable',
      method: 'GET',
      caseId: 'CASE-1',
      error: 'relation "FileReadStatus" does not exist',
    });
  });
});
