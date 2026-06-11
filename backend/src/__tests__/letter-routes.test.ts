import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLetterRouter, type LetterRouterDeps } from '../routes/letter.js';
import { isHttpError, sendError } from '../http/errors.js';
import { KASKY_CREDENTIALS, type SignerCredentials } from '../services/credential-block.js';
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
    previouslyDenied: false, priorDenialReason: null, priorDecisionDate: null,
    upstreamScCondition: null, veteranStatement: null, inServiceEvent: null,
    status: 'physician_review', cdsVerdict: 'accept', cdsOddsPct: 70, cdsRationale: null,
    assignedPhysicianId: 'PHYS-001', assignedRnId: null, refundEligible: false, currentVersion: 1,
    createdAt: now, updatedAt: now, version: 3, ...overrides,
  };
}

// Default signer = Kasky, fully provisioned (credential block + signature on file) so the
// happy-path approve reaches 200. fullNameWithCredential matches LETTER_TXT ("Ryan J. Kasky, DO").
function physician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-05-30T00:00:00.000Z');
  return {
    id: 'PHYS-001', cognitoSub: 'PHYS-SUB', fullName: 'Ryan J. Kasky, DO', npi: '1073018958',
    specialty: 'Family Medicine', medicalLicense: 'NV-DO2996', email: 'p@x.test', phone: null,
    signatureImageS3Key: 'physician-signatures/PHYS-001/abc-signature.png',
    credentialBlockJson: { ...KASKY_CREDENTIALS },
    active: true, createdAt: now, updatedAt: now, version: 1, ...overrides,
  };
}

const JANE_CREDS: SignerCredentials = {
  fullNameWithCredential: 'Jane A. Doe, MD', specialty: 'Internal Medicine',
  boardName: 'American Board of Internal Medicine', boardAbbreviation: 'ABIM',
  licenseState: 'Texas', licenseNumber: 'MD55512', npi: '1999999999',
};
function janePhysician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  return physician({ id: 'PHYS-002', cognitoSub: 'JANE-SUB', fullName: 'Jane A. Doe, MD', npi: '1999999999', credentialBlockJson: { ...JANE_CREDS }, ...overrides });
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

function makeDb(
  initialCase: CaseRecord = baseCase(),
  opts: { signOffs?: unknown[]; signer?: PhysicianRecord; self?: PhysicianRecord; roster?: PhysicianRecord[] } = {},
) {
  const signOffs = opts.signOffs ?? [{
    id: 'SO-1', createdAt: new Date('2026-05-30T00:00:00.000Z'),
    answersJson: { records_reviewed: true, diagnosis_documented: true, nexus_supported: true, no_phi_in_letter: true, final_pdf_correct: true },
  }];
  // signer = the assigned physician resolved by id (the fraud gate). self = resolved by
  // cognitoSub for the physician-self auth check. roster = active physicians for foreign-name.
  const signer = opts.signer ?? physician();
  const self = opts.self ?? physician();
  const roster = opts.roster ?? [physician()];
  const tx = {
    case: { findFirst: vi.fn(async () => initialCase), findUnique: vi.fn(async () => initialCase), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(async () => initialCase) },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Robert', lastName: 'Testcase' })) },
    letterRevision: { findFirst: vi.fn(async () => currentRevision(initialCase.currentVersion)), findMany: vi.fn(async () => []), create: vi.fn(async () => currentRevision()) },
    draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn(async () => ({})) },
    signOff: { findMany: vi.fn(async () => signOffs), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    fileReadStatus: { findMany: vi.fn(async () => []), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    physician: {
      findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === self.cognitoSub ? self : null)),
      findFirst: vi.fn(async (a: { where?: { id?: string } }) => (a.where?.id === signer.id ? signer : null)),
      findMany: vi.fn(async () => roster),
      create: vi.fn(), update: vi.fn(),
    },
    // Staff-messaging delegates for the bug-(a) decline hook.
    staffMessage: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(async (a: { data: unknown }) => ({ id: 'SM-1', ...(a.data as object) })) },
    staffMessageRecipient: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 1 })), updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(), count: vi.fn() },
  };
  // appUser.findUnique resolves the assigned RN id -> cognitoSub (decline hook).
  const appUser = { findUnique: vi.fn(async (a: { where?: { id?: string; cognitoSub?: string } }) => (a.where?.id === 'RN-1' ? { id: 'RN-1', cognitoSub: 'RN-SUB', email: 'rn@x', active: true, roles: [{ role: 'ops_staff' }] } : null)), findMany: vi.fn(async () => []) };
  const db = { ...tx, appUser, staffMessage: tx.staffMessage, staffMessageRecipient: tx.staffMessageRecipient, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
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

  it('GET /letter surfaces an S3 NoSuchKey as the structured 404 (letter_artifact_missing), never a 500', async () => {
    // CLM-BBFCB3F8CE (2026-06-11): the DraftJob/LetterRevision row pointed at artifacts the draft run
    // never uploaded; the S3 NoSuchKey escaped as an unhandled 500 → generic dead-end in the UI.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noSuchKey = new Error('The specified key does not exist.');
    noSuchKey.name = 'NoSuchKey';
    const d = deps({ s3: { send: vi.fn(async () => { throw noSuchKey; }) } as unknown as LetterRouterDeps['s3'] });
    const res = await request(appFor(makeDb().db, d)).get('/api/v1/cases/CASE-1/letter');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toBe('Letter artifact missing from storage for v1 — the draft run that created this version never uploaded its files. Re-draft to produce a new letter.');
    expect(res.body.error.details.reason).toBe('letter_artifact_missing');
    expect(res.body.error.details.caseId).toBe('CASE-1');
    expect(res.body.error.details.version).toBe(1);
    // S3 key redacted to the basename — no bucket path in the envelope.
    expect(res.body.error.details.s3Key).toBe('letter.txt');
    // The structured http_error warn fires for the GET (server.ts only logs mutating methods).
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

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
    const renderArg = (d.renderLetter as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(renderArg.draft).toBe(false);
    // D2: signer name + signature key threaded into the render payload.
    expect(renderArg.caseData.signer_name).toBe('Ryan J. Kasky, DO');
    expect(renderArg.caseData.signature_image_s3_key).toBe('physician-signatures/PHYS-001/abc-signature.png');
    const caseUpdate = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(caseUpdate.data.status).toBe('delivered');
  });

  // ── D2 fraud gate ──────────────────────────────────────────────────────────
  it('approve 409 when no physician is assigned', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: null }));
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('no_assigned_physician');
  });

  it('approve 409 (sign_off_not_affirmative) when the latest sign-off has a "No" answer', async () => {
    // The legal gate (audit 2026-06-07): a physician who attested "No" to diagnosis_documented must not
    // be able to finalize the signed letter. Before the gate, approve proceeded; now it 409s.
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase(), { signOffs: [{
      id: 'SO-NO', createdAt: new Date('2026-05-30T00:00:00.000Z'),
      answersJson: { records_reviewed: true, diagnosis_documented: false, nexus_supported: true, no_phi_in_letter: true, final_pdf_correct: true },
    }] });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('sign_off_not_affirmative');
  });

  it('approve 409 when the assigned physician record is not found', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-999' }));
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('assigned_physician_not_found');
  });

  it('approve 409 when the assigned physician is inactive', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase(), { signer: physician({ active: false }) });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('assigned_physician_inactive');
  });

  it('approve 409 when the signer credential block is incomplete', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase(), { signer: physician({ credentialBlockJson: null }) });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('signer_credentials_incomplete');
  });

  it('approve 409 when the signer has no signature on file', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const { db } = makeDb(baseCase(), { signer: physician({ signatureImageS3Key: null }) });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('signer_signature_missing');
  });

  it('approve 409 (signer_name_absent) when the letter does not name the assigned signer', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const txt = 'The veteran has a chronic back condition documented in the record.';
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-002' }), { signer: janePhysician(), roster: [physician(), janePhysician()] });
    const d = deps({ s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => txt } })) } as unknown as LetterRouterDeps['s3'] });
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('signer_name_absent');
  });

  it('approve 409 (foreign_signer_name) when the letter names another physician', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    // Jane is assigned + named (positive check passes), but the body also names Kasky -> fraud.
    const txt = 'I, Jane A. Doe, MD, am board-certified.\n\nCo-reviewed with Ryan J. Kasky, DO.';
    const { db } = makeDb(baseCase({ assignedPhysicianId: 'PHYS-002' }), { signer: janePhysician(), roster: [physician(), janePhysician()] });
    const d = deps({ s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => txt } })) } as unknown as LetterRouterDeps['s3'] });
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('foreign_signer_name');
    expect(res.body.error.details.foreignNames).toEqual(['Ryan J. Kasky, DO']);
  });

  it('approve substitutes signer sentinels before render (no [[SIGNER_ survives)', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    const txt = '[[SIGNER_CREDENTIALS]]\n\nThe veteran has a back condition.\n\n[[SIGNER_BLOCK]]';
    const { db } = makeDb();
    const d = deps({ s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => txt } })) } as unknown as LetterRouterDeps['s3'] });
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    const sentText = (d.renderLetter as ReturnType<typeof vi.fn>).mock.calls[0][0].letterText as string;
    expect(sentText).not.toContain('[[SIGNER_');
    expect(sentText).toContain('Ryan J. Kasky, DO');
    expect(sentText).toContain('Board-Certified in Family Medicine, ABOFP');
  });

  it('approve 502 (fail closed) when an unresolved signer sentinel survives', async () => {
    mockUser = { sub: 'ADMIN', roles: ['admin'] };
    // A malformed sentinel the substitutor will not match; assigned signer is still named.
    const txt = 'I, Ryan J. Kasky, DO, am board-certified.\n\n[[SIGNER_FOOTER]]';
    const { db } = makeDb();
    const d = deps({ s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => txt } })) } as unknown as LetterRouterDeps['s3'] });
    const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.details.reason).toBe('signer_sentinel_unresolved');
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

  // ── Bug (a) fix: the decline must drop a case-linked StaffMessage TO the assigned RN ──
  it('decline ALSO creates a case-linked StaffMessage To the assigned RN with the reason', async () => {
    const reason = 'the AHI is missing — get the sleep study and regenerate';
    const { db, tx } = makeDb(baseCase({ assignedRnId: 'RN-1' }));
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/decline').send({ reason });
    expect(res.status).toBe(200);
    // A StaffMessage was created on the case with the reason as the body.
    expect(tx.staffMessage.create).toHaveBeenCalled();
    const smArg = (tx.staffMessage.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(smArg.data.caseId).toBe('CASE-1');
    expect(smArg.data.body).toBe(reason);
    expect(smArg.data.subject).toMatch(/Correction requested/);
    // A recipient row To the assigned RN (RN-SUB) was created, marked unread.
    expect(tx.staffMessageRecipient.create).toHaveBeenCalled();
    const recipArg = (tx.staffMessageRecipient.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(recipArg.data.recipientSub).toBe('RN-SUB');
    expect(recipArg.data.kind).toBe('to');
    expect(recipArg.data.readAt).toBeNull();
    // Back-compat operatorMessage still written.
    const upd = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upd.data.operatorMessage).toBe(reason);
  });

  it('rejects ops_staff on approve with 403', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(403);
  });
});
