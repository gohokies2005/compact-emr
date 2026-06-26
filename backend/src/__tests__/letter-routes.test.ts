import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLetterRouter, staleSignOffOutcome, type LetterRouterDeps } from '../routes/letter.js';
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
    coverMemoSuppressed: false,
    coverMemoTextOverride: null,
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
  opts: { signOffs?: unknown[]; signer?: PhysicianRecord; self?: PhysicianRecord; roster?: PhysicianRecord[]; currentRevisionOverride?: Partial<LetterRevisionRecord> } = {},
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
    letterRevision: { findFirst: vi.fn(async () => ({ ...currentRevision(initialCase.currentVersion), ...(opts.currentRevisionOverride ?? {}) })), findMany: vi.fn(async () => []), create: vi.fn(async () => currentRevision()), update: vi.fn(async () => currentRevision()) },
    draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn(async () => ({})) },
    signOff: { findMany: vi.fn(async () => signOffs), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(async (a: { data: unknown }) => ({ id: 'SO-NEW', ...(a.data as object) })) },
    fileReadStatus: { findMany: vi.fn(async () => []), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    // Reconcile source (CLM-4DACAF4A80, 2026-06-14): the chart-readiness gate now drops orphaned rows
    // by reconciling against the chart's documents. DEFAULT mirrors fileReadStatus (every read-status
    // row is a live document → a blocking row still blocks). An ORPHAN test overrides this to [].
    document: {
      findMany: vi.fn(async () => {
        const rows = (await tx.fileReadStatus.findMany()) as readonly { filePath: string }[];
        return rows.map((r) => ({ s3Key: r.filePath }));
      }),
    },
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

  // ── Guided Revision (Guided Revision, 2026-06-13) ────────────────────────────────────────────
  // The broader edit tier: the physician highlights a passage + instructs; Opus reshapes ONLY that
  // passage (softer prose, HARD guards). Propose-only. Behind GUIDED_REVISION_ENABLED.
  describe('guided revision', () => {
    // A letter that carries a §VII holding + a cited passage, so the holding lock + citation guard
    // have real material to act on. The highlighted passage is the mechanism sentence.
    const GR_LETTER = [
      '**I. Physician Qualifications**',
      'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
      '',
      '**VI. Discussion**',
      'The mechanism is supported by Smith 2019, which reported a 22% prevalence.',
      '',
      '**VII. Opinion**',
      "**It is my opinion that the veteran's condition is at least as likely as not (50 percent or greater probability) caused by service, under 38 CFR 3.310.**",
      '',
      '**VIII. References**',
      '1. Smith 2019.',
    ].join('\n');
    const GR_PASSAGE = 'The mechanism is supported by Smith 2019, which reported a 22% prevalence.';

    function grDeps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
      return deps({
        s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => GR_LETTER } })) } as unknown as LetterRouterDeps['s3'],
        ...over,
      });
    }
    function grProposer(newText: string) {
      // Mirror the concrete proposer's guided contract: anchor_text is pinned to the passage.
      return vi.fn(async (i: { passage?: string }) => ({ proposal: { operation: 'replace' as const, anchor_text: i.passage ?? GR_PASSAGE, new_text: newText }, costUsd: 0.03, model: 'claude-opus-4-8' }));
    }

    beforeEach(() => { process.env.GUIDED_REVISION_ENABLED = 'true'; mockUser = { sub: 'PHYS-SUB', roles: ['physician'] }; });
    afterEach(() => { delete process.env.GUIDED_REVISION_ENABLED; });

    it('PROPOSE returns a passage-scoped replace + preview (anchor_text === the highlighted passage)', async () => {
      const newText = 'The physiologic mechanism is well documented by Smith 2019, with a 22% prevalence.';
      const d = grDeps({ proposeSurgicalEdit: grProposer(newText) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'tighten and de-emphasize' });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('guided_revision');
      expect(res.body.data.proposal.operation).toBe('replace');
      expect(res.body.data.proposal.anchor_text).toBe(GR_PASSAGE);
      expect(res.body.data.preview).toContain('physiologic mechanism is well documented');
      // pure rewording keeping Smith 2019 + 22% → no added, no removed, no warnings
      expect(res.body.data.citationDiff.added).toHaveLength(0);
      expect(res.body.data.citationDiff.removed).toHaveLength(0);
      expect(res.body.data.warnings).toHaveLength(0);
    });

    it('REJECTS (422 citation_invented) a revision that invents a new PMID', async () => {
      const newText = 'The mechanism is supported by Smith 2019 (PMID: 31234567), which reported a 22% prevalence.';
      const d = grDeps({ proposeSurgicalEdit: grProposer(newText) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'add a reference' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('citation_invented');
      expect(res.body.error.details.citationDiff.added.map((t: { key: string }) => t.key)).toContain('pmid:31234567');
    });

    it('REJECTS (422 citation_invented) a revision that invents a new statistic', async () => {
      const newText = 'The mechanism is supported by Smith 2019, which reported a 22% prevalence (OR 3.1).';
      const d = grDeps({ proposeSurgicalEdit: grProposer(newText) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'strengthen' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('citation_invented');
    });

    it('WARNS (200 + warning) when a revision DROPS a citation (physician decides)', async () => {
      const newText = 'The physiologic mechanism is well documented in the medical literature.';
      const d = grDeps({ proposeSurgicalEdit: grProposer(newText) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'de-emphasize this marginal theory' });
      expect(res.status).toBe(200);
      expect(res.body.data.warnings.length).toBeGreaterThan(0);
      expect(res.body.data.warnings[0]).toMatch(/removes 2 citation\/statistic|removes/);
      expect(res.body.data.citationDiff.removed.map((t: { key: string }) => t.key)).toContain('ay:smith:2019');
    });

    it('REJECTS (422 holding_changed) a revision that would alter the §VII holding even via a passage overlapping it', async () => {
      // Highlight the §VII holding sentence; the model tries to weaken it. The holding lock blocks it.
      const holding = "**It is my opinion that the veteran's condition is at least as likely as not (50 percent or greater probability) caused by service, under 38 CFR 3.310.**";
      const weakened = "**It is my opinion that the veteran's condition is less likely than not caused by service, under 38 CFR 3.310.**";
      const d = grDeps({ proposeSurgicalEdit: vi.fn(async () => ({ proposal: { operation: 'replace' as const, anchor_text: holding, new_text: weakened }, costUsd: 0.03, model: 'claude-opus-4-8' })) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: holding, instruction: 'soften the conclusion' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('holding_changed');
    });

    it('422 (passage_not_found) when the highlighted passage is not a verbatim substring of the letter', async () => {
      const d = grDeps({ proposeSurgicalEdit: grProposer('x') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: 'text that is not in the letter at all', instruction: 'edit it' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('passage_not_found');
    });

    it('400 (passage_required) when mode is guided_revision but no passage is given', async () => {
      const d = grDeps({ proposeSurgicalEdit: grProposer('x') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', instruction: 'edit it' });
      expect(res.status).toBe(400);
      expect(res.body.error.details.reason).toBe('passage_required');
    });

    it('503 (guided_revision_disabled) when the flag is OFF', async () => {
      delete process.env.GUIDED_REVISION_ENABLED;
      const d = grDeps({ proposeSurgicalEdit: grProposer('x') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect(res.status).toBe(503);
      expect(res.body.error.details.reason).toBe('guided_revision_disabled');
    });

    it('does not run the proposer when the flag is OFF (no spend)', async () => {
      delete process.env.GUIDED_REVISION_ENABLED;
      const proposer = grProposer('x');
      const d = grDeps({ proposeSurgicalEdit: proposer });
      await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect(proposer).not.toHaveBeenCalled();
    });

    it('403 for a role outside the allow-set (no auth user)', async () => {
      mockUser = undefined; // requireRole → 401/403 before the handler
      const d = grDeps({ proposeSurgicalEdit: grProposer('x') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect([401, 403]).toContain(res.status);
    });

    it('locks ops_staff guided revision while in physician_review (the AI door matches the hand door)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const d = grDeps({ proposeSurgicalEdit: grProposer('x') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('locked_physician_review');
    });

    // Guided-revision robustness (2026-06-24): a proposer that fails after the SDK's transient
    // retries OR returns nothing usable throws a typed ProposerUnavailableError; the route turns it
    // into a SPECIFIC 422 'proposal_unavailable' (+ detail) — never the generic could-not-be-generated.
    function unavailableProposer(detail: string, passageTooLong = false) {
      return vi.fn(async () => { throw Object.assign(new Error(`proposer unavailable: ${detail}`), { isProposerUnavailable: true, detail, passageTooLong }); });
    }
    it('422 proposal_unavailable (model_unavailable) when the proposer is transiently down', async () => {
      const d = grDeps({ proposeSurgicalEdit: unavailableProposer('model_unavailable') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('proposal_unavailable');
      expect(res.body.error.details.detail).toBe('model_unavailable');
      expect(res.body.error.message).toMatch(/briefly unavailable.*Propose/i);
    });
    it('422 proposal_unavailable (passage_too_complex) carries passageTooLong + a too-long message', async () => {
      const d = grDeps({ proposeSurgicalEdit: unavailableProposer('passage_too_complex', true) });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: GR_PASSAGE, instruction: 'edit it' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('proposal_unavailable');
      expect(res.body.error.details.detail).toBe('passage_too_complex');
      expect(res.body.error.details.passageTooLong).toBe(true);
      expect(res.body.error.message).toMatch(/too long/i);
    });
    it('SURGICAL (non-guided) propose also maps a ProposerUnavailableError to 422 proposal_unavailable', async () => {
      const d = deps({ proposeSurgicalEdit: unavailableProposer('no_change_proposed') });
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ instruction: 'add the DC code' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('proposal_unavailable');
      expect(res.body.error.details.detail).toBe('no_change_proposed');
    });

    it('APPLY of a guided-revision proposal that changes the holding is BLOCKED (422 holding_changed) defense-in-depth', async () => {
      // Even a hand-crafted apply payload that bypassed propose cannot change the holding.
      const holding = "**It is my opinion that the veteran's condition is at least as likely as not (50 percent or greater probability) caused by service, under 38 CFR 3.310.**";
      const weakened = "**It is my opinion that the veteran's condition is less likely than not caused by service, under 38 CFR 3.310.**";
      const d = grDeps();
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: holding, new_text: weakened } });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('holding_changed');
    });

    // ── NARROWED holding lock + physician-only §VII gate (Puller, 2026-06-24) ───────────────────
    // A letter whose §VII uses the STRONG FRN standard so a causation->aggravation rephrase that keeps
    // ">50%" is ALLOWED, but a weakening to "at least as likely as not" is BLOCKED.
    const MLTN_LETTER = [
      '**I. Physician Qualifications**',
      'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
      '',
      '**III. History**',
      'The veteran served on active duty from 2003 to 2009.',
      '',
      '**VII. Opinion**',
      "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**",
      '',
      '**VIII. References**',
      '1. Smith 2019.',
    ].join('\n');
    const MLTN_HOLDING = "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**";
    function mltnDeps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
      return deps({
        s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => MLTN_LETTER } })) } as unknown as LetterRouterDeps['s3'],
        ...over,
      });
    }

    it('APPLY: a physician causation->aggravation rephrase that KEEPS >50% is ALLOWED (the Puller fix)', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const aggravated = MLTN_HOLDING.replace('proximately caused by', 'aggravated by').replace('3.310(a)', '3.310(b)');
      const d = mltnDeps();
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: MLTN_HOLDING, new_text: aggravated } });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
    });

    it('APPLY: weakening >50% to "at least as likely as not" is BLOCKED (422 holding_changed) even for a physician', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const weakened = MLTN_HOLDING.replace('more likely than not (greater than 50% probability)', 'at least as likely as not');
      const d = mltnDeps();
      const res = await request(appFor(makeDb().db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: MLTN_HOLDING, new_text: weakened } });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('holding_changed');
    });

    it('APPLY: ops_staff editing §VII is BLOCKED (403 section_vii_physician_only)', async () => {
      // ops_staff on a NON-physician_review status (drafting) — the older 409 lock does not fire, so
      // the new physician-only §VII gate is what blocks. The edit keeps >50% (so it is not holding_changed).
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const aggravated = MLTN_HOLDING.replace('proximately caused by', 'aggravated by').replace('3.310(a)', '3.310(b)');
      const d = mltnDeps();
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: MLTN_HOLDING, new_text: aggravated } });
      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('section_vii_physician_only');
    });

    it('APPLY: ops_staff editing a NON-§VII section is ALLOWED (the gate is §VII-scoped)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const d = mltnDeps();
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: 'The veteran served on active duty from 2003 to 2009.', new_text: 'The veteran served on active duty from 2003 to 2010.' } });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
    });

    it('PROPOSE (guided): ops_staff cannot even GENERATE a §VII change (403 section_vii_physician_only)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const aggravated = MLTN_HOLDING.replace('proximately caused by', 'aggravated by').replace('3.310(a)', '3.310(b)');
      const d = mltnDeps({ proposeSurgicalEdit: vi.fn(async (i: { passage?: string }) => ({ proposal: { operation: 'replace' as const, anchor_text: i.passage ?? MLTN_HOLDING, new_text: aggravated }, costUsd: 0.03, model: 'claude-opus-4-8' })) });
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: MLTN_HOLDING, instruction: 'switch to aggravation' });
      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('section_vii_physician_only');
    });

    it('PROPOSE (guided): a physician causation->aggravation rephrase keeping >50% is ACCEPTED', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const aggravated = MLTN_HOLDING.replace('proximately caused by', 'aggravated by').replace('3.310(a)', '3.310(b)');
      const d = mltnDeps({ proposeSurgicalEdit: vi.fn(async (i: { passage?: string }) => ({ proposal: { operation: 'replace' as const, anchor_text: i.passage ?? MLTN_HOLDING, new_text: aggravated }, costUsd: 0.03, model: 'claude-opus-4-8' })) });
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage: MLTN_HOLDING, instruction: 'switch to aggravation' });
      expect(res.status).toBe(200);
      expect(res.body.data.preview).toContain('aggravated by');
    });
  });

  // ── FIX A (Puller, CLM-CCFDA1BCC3, 2026-06-25): mutating edit paths self-heal a STRANDED pointer ─
  // Case.currentVersion=39 but v39 has NO artifact (a failed re-draft advanced the pointer onto a dead
  // version). The read path recovers (serves v40), but the mutating paths used the STRICT resolver →
  // null at v39 → 409 no_letter BEFORE any §VII gate ran (25+ live surgical-ai 409s). The fix: an edit
  // recovers the last good version (v40), builds v41 over it, and RE-PINS currentVersion=41.
  describe('stranded-pointer self-heal (FIX A)', () => {
    const STRANDED_TXT = [
      '**I. Physician Qualifications**',
      'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
      '',
      '**VII. Opinion**',
      "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**",
      '',
      'The veteran has lumbosacral strain. It is documented.',
    ].join('\n');

    // currentVersion=39 (dead). A good letter exists at v40. findFirst({v39}) → null (no row/job);
    // findFirst({v40}) → the good row; findMany(DESC) surfaces v40 for the recovery walk. HeadObject
    // (s3.send) returns OK so the recovered v40 txt is confirmed present.
    function strandedDb(status: CaseRecord['status'] = 'physician_review') {
      const v40row: LetterRevisionRecord = {
        ...currentRevision(40), id: 'LR-40', parentVersion: 39, source: 'drafter_run',
        artifactTxtS3Key: 'letter-revisions/CASE-1/v40/letter.txt',
        artifactPdfS3Key: 'letter-revisions/CASE-1/v40/letter.pdf',
        artifactDocxS3Key: 'letter-revisions/CASE-1/v40/letter.docx',
      };
      const created: Array<Record<string, unknown>> = [];
      const caseRow = baseCase({ currentVersion: 39, status });
      const caseUpdates: Array<Record<string, unknown>> = [];
      const tx = {
        case: {
          findFirst: vi.fn(async () => caseRow), findUnique: vi.fn(async () => caseRow),
          update: vi.fn(async (a: { data: Record<string, unknown> }) => { caseUpdates.push(a.data); return caseRow; }),
        },
        veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Robert', lastName: 'Testcase' })) },
        letterRevision: {
          // STRICT resolve at v39 → null (stranded); the recovery winner v40 → the good row.
          findFirst: vi.fn(async (a: { where?: { version?: number } }) => (a.where?.version === 40 ? v40row : null)),
          findMany: vi.fn(async () => [v40row]), // DESC walk surfaces v40
          create: vi.fn(async (a: { data: Record<string, unknown> }) => { created.push(a.data); return { id: 'LR-NEW', ...a.data }; }),
          update: vi.fn(),
        },
        draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        activityLog: { create: vi.fn(async () => ({})) },
        signOff: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(), create: vi.fn() },
        // PHYS-SUB resolves to the assigned PHYS-001 so enforcePhysicianAssignment passes.
        physician: {
          findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === 'PHYS-SUB' ? physician() : null)),
          findFirst: vi.fn(async (a: { where?: { id?: string } }) => (a.where?.id === 'PHYS-001' ? physician() : null)),
          findMany: vi.fn(async () => [physician()]),
        },
      };
      const db = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
      return { db, created, caseUpdates };
    }
    // s3 that resolves a Body for GetObject AND succeeds HeadObject (object present) — the recovered
    // v40 txt is confirmed present, so the edit rebases onto it.
    function strandedDeps() {
      return deps({ s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => STRANDED_TXT } })) } as unknown as LetterRouterDeps['s3'] });
    }

    it('surgical-ai APPLY on a stranded v39 pointer RECOVERS: builds v41 over v40, re-pins currentVersion=41 (not 409 no_letter)', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const { db, created, caseUpdates } = strandedDb();
      const res = await request(appFor(db, strandedDeps())).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' } });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(41); // v40 (recovered) + 1
      expect(created[0]?.version).toBe(41);
      expect(created[0]?.parentVersion).toBe(40); // parent = the recovered version it was built from
      // currentVersion re-pinned to 41 so the next edit resolves strictly again.
      expect(caseUpdates.some((u) => u.currentVersion === 41)).toBe(true);
    });

    it('PUT save on a stranded pointer RECOVERS (base_version=40, the recovered version the editor loaded)', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const { db, created, caseUpdates } = strandedDb();
      const res = await request(appFor(db, strandedDeps())).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 40, txt: STRANDED_TXT.replace('It is documented.', 'It is well documented.') });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(41);
      expect(created[0]?.parentVersion).toBe(40);
      expect(caseUpdates.some((u) => u.currentVersion === 41)).toBe(true);
    });

    it('guided-revision PROPOSE on a stranded pointer recovers (no 409 no_letter; returns a preview)', async () => {
      process.env.GUIDED_REVISION_ENABLED = 'true';
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const passage = 'The veteran has lumbosacral strain. It is documented.';
      const newText = 'The veteran has a documented lumbosacral strain.';
      const { db } = strandedDb();
      const d = deps({
        s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => STRANDED_TXT } })) } as unknown as LetterRouterDeps['s3'],
        proposeSurgicalEdit: vi.fn(async (i: { passage?: string }) => ({ proposal: { operation: 'replace' as const, anchor_text: i.passage ?? passage, new_text: newText }, costUsd: 0.03, model: 'claude-opus-4-8' })),
      });
      const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ mode: 'guided_revision', passage, instruction: 'tighten' });
      delete process.env.GUIDED_REVISION_ENABLED;
      expect(res.status).toBe(200);
      expect(res.body.data.preview).toContain('documented lumbosacral strain');
    });

    // ── FIX 1 (QA SHOULD-FIX, 2026-06-25): transient-S3 tolerance on the strict-branch HeadObject probe ──
    // resolveCurrentForEdit now HeadObject-probes the strict-resolved letter. headObjectExists RE-THROWS any
    // non-NotFound error, so a transient S3 Throttling/Timeout/5xx during that probe would 500 a HEALTHY edit
    // that pre-fix succeeded (the old strict path did NO HeadObject). The fix: trust the strict letter on a
    // transient probe error (proceed, recovered=false); only a DEFINITIVE NotFound drops to recovery.
    it('FIX 1: a healthy strict case whose HeadObject probe THROWS a TRANSIENT (non-NotFound) error still edits on the strict letter (no 500, no recovery)', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      // A NORMAL case: currentVersion=40, the strict v40 row resolves. Build a db like strandedDb but with
      // the strict findFirst returning the good row AT currentVersion (so resolveCurrent hits).
      const v40row: LetterRevisionRecord = {
        ...currentRevision(40), id: 'LR-40', parentVersion: 39, source: 'drafter_run',
        artifactTxtS3Key: 'letter-revisions/CASE-1/v40/letter.txt',
        artifactPdfS3Key: 'letter-revisions/CASE-1/v40/letter.pdf',
        artifactDocxS3Key: 'letter-revisions/CASE-1/v40/letter.docx',
      };
      const created: Array<Record<string, unknown>> = [];
      const caseRow = baseCase({ currentVersion: 40, status: 'physician_review' });
      const caseUpdates: Array<Record<string, unknown>> = [];
      const recoveryWalk = vi.fn(async () => [v40row]); // would be consulted ONLY if recovery fired
      const tx = {
        case: {
          findFirst: vi.fn(async () => caseRow), findUnique: vi.fn(async () => caseRow),
          update: vi.fn(async (a: { data: Record<string, unknown> }) => { caseUpdates.push(a.data); return caseRow; }),
        },
        veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Robert', lastName: 'Testcase' })) },
        letterRevision: {
          findFirst: vi.fn(async (a: { where?: { version?: number } }) => (a.where?.version === 40 ? v40row : null)),
          findMany: recoveryWalk,
          create: vi.fn(async (a: { data: Record<string, unknown> }) => { created.push(a.data); return { id: 'LR-NEW', ...a.data }; }),
          update: vi.fn(),
        },
        draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        activityLog: { create: vi.fn(async () => ({})) },
        signOff: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(), create: vi.fn() },
        physician: {
          findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === 'PHYS-SUB' ? physician() : null)),
          findFirst: vi.fn(async (a: { where?: { id?: string } }) => (a.where?.id === 'PHYS-001' ? physician() : null)),
          findMany: vi.fn(async () => [physician()]),
        },
      };
      const db = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
      // s3 that THROWS a transient (Throttling, NOT NotFound) error on HeadObject but serves a Body on GetObject.
      const throttling = Object.assign(new Error('Please reduce your request rate.'), { name: 'ThrottlingException' });
      const s3 = {
        send: vi.fn(async (cmd: { constructor: { name: string } }) => {
          if ((cmd?.constructor?.name ?? '') === 'HeadObjectCommand') throw throttling;
          return { Body: { transformToString: async () => STRANDED_TXT } };
        }),
      } as unknown as LetterRouterDeps['s3'];
      const res = await request(appFor(db, deps({ s3 }))).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 40, txt: STRANDED_TXT.replace('It is documented.', 'It is well documented.') });
      expect(res.status).toBe(200); // healthy edit proceeds — a transient probe blip must NOT 500
      expect(res.body.data.version).toBe(41); // built over the STRICT v40 (no recovery)
      expect(created[0]?.parentVersion).toBe(40);
      // No spurious recovery: the recovery walk (findMany) was never consulted…
      expect(recoveryWalk).not.toHaveBeenCalled();
      // …and no stranded-recovery breadcrumb was written (recovered=false).
      expect(tx.activityLog.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'letter_stranded_recovery' }) }));
    });

    it('FIX 3: a stranded-pointer RECOVERY emits a letter_stranded_recovery breadcrumb (best-effort)', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const { db } = strandedDb();
      // Capture the activityLog spy off the underlying tx through a fresh recovery run.
      const res = await request(appFor(db, strandedDeps())).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 40, txt: STRANDED_TXT.replace('It is documented.', 'It is well documented.') });
      expect(res.status).toBe(200);
      // The breadcrumb mirrors the read-path stranded-recovery log: action + stranded & recovered versions.
      const calls = ((db as unknown as { activityLog: { create: ReturnType<typeof vi.fn> } }).activityLog.create).mock.calls;
      const crumb = calls.find((c) => (c[0] as { data?: { action?: string } })?.data?.action === 'letter_stranded_recovery');
      expect(crumb).toBeDefined();
      const details = (crumb?.[0] as { data?: { detailsJson?: Record<string, unknown> } })?.data?.detailsJson;
      expect(details?.strandedCurrentVersion).toBe(39);
      expect(details?.recoveredVersion).toBe(40);
    });

    it('a GENUINELY no-letter case (no resolvable version anywhere) still 409s no_letter', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const caseRow = baseCase({ currentVersion: 5, status: 'physician_review' });
      const tx = {
        case: { findFirst: vi.fn(async () => caseRow), findUnique: vi.fn(async () => caseRow), update: vi.fn(async () => caseRow) },
        veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'R', lastName: 'T' })) },
        letterRevision: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
        draftJob: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        activityLog: { create: vi.fn(async () => ({})) },
        signOff: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
        physician: {
          findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === 'PHYS-SUB' ? physician() : null)),
          findFirst: vi.fn(async (a: { where?: { id?: string } }) => (a.where?.id === 'PHYS-001' ? physician() : null)),
          findMany: vi.fn(async () => [physician()]),
        },
      };
      const db = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
      // s3 HeadObject + ListObjectsV2 both miss → no S3-truth fallback either.
      const notFound = Object.assign(new Error('not found'), { name: 'NotFound' });
      const d = deps({ s3: { send: vi.fn(async () => { throw notFound; }) } as unknown as LetterRouterDeps['s3'] });
      const res = await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: 'x', new_text: 'y' } });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('no_letter');
    });
  });

  // ── PUT save — physician-only §VII gate (Puller, 2026-06-24) ─────────────────────────────────
  describe('PUT save — §VII physician-only gate', () => {
    const PUT_LETTER = [
      '**I. Physician Qualifications**',
      'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.',
      '',
      '**III. History**',
      'The veteran served on active duty from 2003 to 2009.',
      '',
      '**VII. Opinion**',
      "**It is my opinion that the veteran's hypertension is more likely than not (greater than 50% probability) proximately caused by his service-connected PTSD, under 38 CFR 3.310(a).**",
      '',
      '**VIII. References**',
      '1. Smith 2019.',
    ].join('\n');
    function putDeps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
      return deps({
        s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => PUT_LETTER } })) } as unknown as LetterRouterDeps['s3'],
        ...over,
      });
    }

    it('ops_staff saving a §VII change is BLOCKED (403 section_vii_physician_only)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const edited = PUT_LETTER.replace('proximately caused by', 'aggravated by');
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, putDeps())).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 1, txt: edited });
      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('section_vii_physician_only');
    });

    it('ops_staff saving a NON-§VII change is ALLOWED', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const edited = PUT_LETTER.replace('2003 to 2009', '2003 to 2010');
      const res = await request(appFor(makeDb(baseCase({ status: 'drafting' })).db, putDeps())).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 1, txt: edited });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
    });

    it('physician saving a §VII causation->aggravation change keeping >50% is ALLOWED', async () => {
      mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
      const edited = PUT_LETTER.replace('proximately caused by', 'aggravated by').replace('3.310(a)', '3.310(b)');
      const res = await request(appFor(makeDb().db, putDeps())).put('/api/v1/cases/CASE-1/letter')
        .send({ base_version: 1, txt: edited });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
    });
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

  // ── Doctor-pay stamps (DOCTOR_PAY_BUILD_PLAN §5.6/§7-O) — ACCURACY-CRITICAL: Ryan pays real
  // checks from these columns. Locked here so a refactor of the approve tx can't silently drop them.
  it('approve stamps letterType/signingPhysicianId/payCents on the approved_final revision', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    const revCreate = (tx.letterRevision.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(revCreate.data.source).toBe('approved_final');
    expect(revCreate.data.letterType).toBe('nexus_letter'); // approve always produces a letter (memo = manual re-tag)
    expect(revCreate.data.signingPhysicianId).toBe('PHYS-001'); // the ASSIGNED signer snapshot
    expect(revCreate.data.payCents).toBe(10000); // rate-at-completion: $100
  });

  it('approve stamps signingPhysicianId = the ASSIGNED signer even when an ADMIN clicks approve (matrix L: actor is never the payee)', async () => {
    mockUser = { sub: 'ADMIN-SUB', roles: ['admin'] };
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    const revCreate = (tx.letterRevision.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(revCreate.data.signingPhysicianId).toBe('PHYS-001'); // never 'ADMIN-SUB'
    expect(revCreate.data.editedBy).toBe('ADMIN-SUB'); // the clicker is recorded separately
  });

  it('tie-out (matrix O): one approve writes EXACTLY one approved_final revision and one letter_approved log, in the same transaction', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    const revCreates = (tx.letterRevision.create as ReturnType<typeof vi.fn>).mock.calls;
    const logCreates = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[0] as { data: { action: string } }).data.action === 'letter_approved');
    expect(revCreates).toHaveLength(1);
    expect(logCreates).toHaveLength(1); // divergence here = a code path created one without the other
    expect((db.$transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
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

  // ── Chart-readiness machine-read gate at approve: descriptive 409 + honored override
  //    (CLM-4DACAF4A80, 2026-06-14, item d) ──
  function blockingFileRow() {
    const now = new Date();
    return {
      id: 'FRS-b', caseId: 'CASE-1',
      filePath: 'cases/CASE-1/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf', fileSha256: 'a'.repeat(64),
      terminalStatus: 'manual_summary_required',
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 0, corruptedTokenRatio: 0, attemptedAt: now.toISOString(), note: 'empty (0 words)' }],
      manualSummary: null, manualSummaryAt: null, manualSummaryBy: null,
      lastCheckedAt: now, createdAt: now, updatedAt: now, version: 1,
    };
  }

  it('(d) approve is BLOCKED with the descriptive chart_not_ready 409 when a file is unread AND no override exists', async () => {
    const { db, tx } = makeDb();
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no override
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
    expect(res.body.error.message).toContain('Sleep_Study.pdf');
    expect(res.body.error.message).toContain('empty (0 words)');
    expect(res.body.error.message).not.toContain('chart-readiness gate failed');
  });

  it('(d) approve HONORS an existing chart-readiness override sign-off (proceeds to 200 + logs it)', async () => {
    const { db, tx } = makeDb();
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    // A prior sign-off overrode the gate — findFirst({ chartReadinessOverridden: true }) finds it.
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'SO-OVR', chartReadinessOverrideReason: 'reviewed in person' });
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
    // The reliance on the override is logged.
    const logged = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(logged).toContain('letter_approve_chart_readiness_override_honored');
  });

  it('(d) finalize-import HONORS an existing chart-readiness override sign-off', async () => {
    const { db, tx } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'SO-OVR', chartReadinessOverrideReason: 'reviewed in person' });
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
    const logged = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(logged).toContain('letter_finalize_chart_readiness_override_honored');
  });

  it('(d) finalize-import accepts an INLINE override (overrideChartReadiness + reason) with NO prior sign-off — the dead-link fix (CLM-4DACAF4A80)', async () => {
    const { db, tx } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    // A real unread (garbled) file is in the chart, and there is NO prior override sign-off — exactly
    // Moseley's situation. The finalize modal submits the override inline; before the fix this 409'd
    // ("Sign off anyway" was a dead link) because the route only looked for a PRIOR override sign-off.
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db, importDeps()))
      .post('/api/v1/cases/CASE-1/letter/finalize-import')
      .send({ ...AFFIRMATIVE_BODY, overrideChartReadiness: true, chartReadinessOverrideReason: 'I reviewed the garbled intake PDF in person; it is legible to me.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
    const so = (tx.signOff.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { data: { chartReadinessOverridden?: boolean; chartReadinessOverrideReason?: string | null } };
    expect(so.data.chartReadinessOverridden).toBe(true);
    expect(so.data.chartReadinessOverrideReason).toContain('reviewed');
    const logged = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(logged).toContain('letter_finalized_import_chart_readiness_overridden');
  });

  it('(d) finalize-import still 409s when the override flag is set WITHOUT a reason (blank reason cannot slip the gate)', async () => {
    const { db, tx } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db, importDeps()))
      .post('/api/v1/cases/CASE-1/letter/finalize-import')
      .send({ ...AFFIRMATIVE_BODY, overrideChartReadiness: true, chartReadinessOverrideReason: '   ' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
  });

  it('(d) approve is NOT blocked by an ORPHANED readiness row (file not in chart documents) (CLM-4DACAF4A80)', async () => {
    // Wayne Moseley: a deleted final-letter PDF left a manual_summary_required row that the chart no
    // longer lists. Reconcile drops it → approve proceeds to 200 WITHOUT needing an override sign-off.
    const { db, tx } = makeDb();
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // chart no longer has the file
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null); // and NO override exists
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
  });

  it('(d) finalize-import is NOT blocked by an ORPHANED readiness row (CLM-4DACAF4A80)', async () => {
    const { db, tx } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([blockingFileRow()]);
    (tx.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
  });

  it('(d) approve STILL blocks when the unread file IS a live chart document (CLM-4DACAF4A80 control)', async () => {
    const { db, tx } = makeDb();
    const row = blockingFileRow();
    (tx.fileReadStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
    (tx.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ s3Key: row.filePath }]); // live doc
    (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('chart_not_ready');
  });

  // ── Imported letter: deliver-as-is (no re-render) — import deliver-as-is, 2026-06-14 ──────────
  // An external_import current revision must be FINALIZED via /finalize-import (binds a sign-off to
  // the imported PDF bytes, no re-render). The normal /approve REFUSES it (it would re-render from
  // the placeholder TXT and mangle the externally-signed PDF). $500 signed-letter path → bias SAFE.
  const IMPORT_PDF_KEY = 'drafter-artifacts/CASE-1/v1/imported-letter.pdf';
  const IMPORT_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x42, 0x07]);
  const AFFIRMATIVE_BODY = { answers: { records_reviewed: true, diagnosis_documented: true, nexus_supported: true, no_phi_in_letter: true, final_pdf_correct: true } };
  function importedRevisionOverride(): Partial<LetterRevisionRecord> {
    return { source: 'external_import', artifactPdfS3Key: IMPORT_PDF_KEY, artifactTxtS3Key: 'drafter-artifacts/CASE-1/v1/imported-letter.txt' };
  }
  // S3 mock that serves the imported PDF bytes (transformToByteArray) + a placeholder TXT.
  function importDeps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
    return deps({
      s3: { send: vi.fn(async () => ({ Body: { transformToByteArray: async () => IMPORT_PDF_BYTES, transformToString: async () => '[placeholder]' } })) } as unknown as LetterRouterDeps['s3'],
      ...over,
    });
  }

  it('approve 409s on an external_import current revision (would re-render + mangle the imported PDF)', async () => {
    const { db } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('imported_letter_use_finalize_as_is');
  });

  it('finalize-import records a sign-off bound to the PDF sha256, stamps pay, and sets delivered (no new revision)', async () => {
    const { db, tx } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
    expect(res.body.data.source).toBe('external_import');
    // The sign-off binds to the EXACT imported PDF bytes (sha256), NOT the placeholder TXT.
    const expectedPdfSha = createHash('sha256').update(IMPORT_PDF_BYTES).digest('hex');
    const soCreate = (tx.signOff.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(soCreate.data.signedContentSha256).toBe(expectedPdfSha);
    expect(soCreate.data.physicianId).toBe('PHYS-001'); // the ASSIGNED signer, never the clicker
    expect(soCreate.data.signedVersion).toBe(1);
    // NO new LetterRevision created (the imported PDF IS the final artifact); the current revision is
    // pay-stamped in place instead.
    expect((tx.letterRevision.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const revUpdate = (tx.letterRevision.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(revUpdate.data.letterType).toBe('nexus_letter');
    expect(revUpdate.data.signingPhysicianId).toBe('PHYS-001');
    expect(revUpdate.data.payCents).toBe(10000);
    // Case flips to delivered; currentVersion is NOT advanced (imported revision already current).
    const caseUpdate = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(caseUpdate.data.status).toBe('delivered');
    expect(caseUpdate.data.currentVersion).toBeUndefined();
  });

  it('finalize-import 409s (sign_off_not_affirmative) on a "No" answer — never finalize against a concern', async () => {
    const { db } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    const body = { answers: { records_reviewed: true, diagnosis_documented: false, nexus_supported: true, no_phi_in_letter: true, final_pdf_correct: true } };
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('sign_off_not_affirmative');
  });

  it('finalize-import 409s (not_an_imported_letter) when the current revision is a normal rendered letter', async () => {
    const { db } = makeDb(); // default source = drafter_run
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('not_an_imported_letter');
  });

  it('finalize-import 403s for an unassigned physician (role + assignment gate, mirrors approve)', async () => {
    mockUser = { sub: 'OTHER-SUB', roles: ['physician'] };
    // self resolves to a physician whose id (PHYS-002) != the case's assignedPhysicianId (PHYS-001).
    const { db } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride(), self: janePhysician() });
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(403);
  });

  it('finalize-import 403s for an RN (ops_staff) — only physician/admin can finalize', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb(baseCase(), { currentRevisionOverride: importedRevisionOverride() });
    const res = await request(appFor(db, importDeps())).post('/api/v1/cases/CASE-1/letter/finalize-import').send(AFFIRMATIVE_BODY);
    expect(res.status).toBe(403);
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

  // Regression (Dr. Kasky send-back note fix): a physician must be able to decline an UNASSIGNED
  // physician_review case (legacy / claimed-from-queue). The assignment guard runs ONLY when a physician
  // IS assigned — without the `assignedPhysicianId !== null` carve-out this 403'd, which would dead-end
  // send-back-with-a-note (it routes through /decline) while the no-note path still worked.
  it('decline SUCCEEDS for a physician on an UNASSIGNED case (assignment guard skipped when none assigned)', async () => {
    mockUser = { sub: 'PHYS-SUB', roles: ['physician'] };
    const { db } = makeDb(baseCase({ assignedPhysicianId: null }));
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/decline').send({ reason: 'rework the overall theory' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('correction_requested');
  });

  it('rejects ops_staff on approve with 403', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const res = await request(appFor(makeDb().db, deps())).post('/api/v1/cases/CASE-1/letter/approve').send({});
    expect(res.status).toBe(403);
  });

  // ── RN lock during physician review (Ryan 2026-06-11 — reverses the 2026-06-04 RN-can-edit
  // decision). Physician + admin retain editing; ops_staff is locked on BOTH mutation routes.
  it('locks ops_staff letter PUT while in physician_review (409 locked_physician_review)', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db } = makeDb(); // fixture default status is physician_review
    const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'edited text' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('locked_physician_review');
  });

  it('locks ops_staff surgical-ai while in physician_review (409 locked_physician_review)', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/surgical-ai').send({ instruction: 'tighten section IV' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('locked_physician_review');
  });

  it('ops_staff letter PUT still allowed in correction_review (lock is physician_review ONLY)', async () => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
    const { db } = makeDb(baseCase({ status: 'correction_review' }));
    const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'edited text' });
    // Any downstream shape (200 or a different 409 like stale_version) proves the gate let
    // ops_staff through — it must just never be the lock.
    expect(res.body?.error?.details?.reason).not.toBe('locked_physician_review');
  });

  // ── Ratified sign/edit lifecycle (Ryan 2026-06-12) — G2 door-level signed guard + G4 ────────
  // "only the signed copy can ship · the signed PDF itself is send-only forever · a post-sign
  // edit goes back to the doctor to re-sign." The byte-hash delivery gate (delivery.ts
  // signed_bytes_changed, pinned in delivery-routes.test.ts) stays the ultimate enforcement;
  // these pin the DOOR-level behavior.
  describe('signed-letter lifecycle (G2/G4)', () => {
    // G2(b): a delivered (approved/signed) case is immutable through EVERY letter mutation route,
    // for every role — the editor set excluding 'delivered' is the invariant, not an accident.
    it('ops_staff can NOT hand-PUT a delivered case (409 not_editable)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const { db } = makeDb(baseCase({ status: 'delivered' }));
      const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'edited text' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('not_editable');
    });

    it('ops_staff can NOT surgical-ai a delivered case (409 not_editable — the AI door matches the hand door)', async () => {
      mockUser = { sub: 'OPS', roles: ['ops_staff'] };
      const { db } = makeDb(baseCase({ status: 'delivered' }));
      const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/surgical-ai').send({ instruction: 'tighten section IV' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('not_editable');
    });

    it('even admin can NOT edit a delivered case — the signed letter is send-only for everyone', async () => {
      mockUser = { sub: 'ADMIN', roles: ['admin'] };
      const { db } = makeDb(baseCase({ status: 'delivered' }));
      const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'edited text' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('not_editable');
    });

    // G4 outcome helper — the delivered branch is intentionally unreachable through the routes
    // today (the not_editable tests above prove it), so the branch selection is pinned directly.
    it('staleSignOffOutcome: delivered → RETURN to physician_review with the ratified notice', () => {
      const out = staleSignOffOutcome('delivered');
      expect(out.returnToPhysicianReview).toBe(true);
      expect(out.logAction).toBe('letter_edited_after_signoff_returned_to_physician');
      expect(out.notice).toBe("This letter was already signed — it has returned to the doctor's queue for re-signature.");
    });

    it('staleSignOffOutcome: physician_review (and other editable statuses) → stay but flag', () => {
      for (const status of ['physician_review', 'correction_review', 'rn_review']) {
        const out = staleSignOffOutcome(status);
        expect(out.returnToPhysicianReview).toBe(false);
        expect(out.logAction).toBe('letter_edited_after_signoff');
        expect(out.notice).toContain('re-sign');
      }
    });

    // Binds tx.signOff.findFirst to "a SignOff exists on signedVersion 1" (the version the
    // edit goes over). Legacy sign-offs carry signedVersion null and never match.
    function bindSignOffToV1(tx: ReturnType<typeof makeDb>['tx']) {
      (tx.signOff.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        async (a: { where?: { signedVersion?: number } }) =>
          (a?.where?.signedVersion === 1 ? { id: 'SO-1', caseId: 'CASE-1', signedVersion: 1, signedContentSha256: 'a'.repeat(64) } : null),
      );
    }

    // G4 reachable path: the physician's own edit in physician_review AFTER signing but before
    // approving. The case stays in the doctor's queue (no status change) but the edit is flagged
    // and the response notice tells the editor the doctor must re-sign.
    it('PUT over a signed version: 200, stays in physician_review, flags the activity log, response carries the notice', async () => {
      const { db, tx } = makeDb(); // physician_review, currentVersion 1; default user = physician
      bindSignOffToV1(tx);
      const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'edited after signing' });
      expect(res.status).toBe(200);
      expect(res.body.data.notice).toBe('This letter was signed before this edit — the doctor must re-sign before it can be delivered.');
      // The case stays put — the doctor re-signs at approve; no status field in the update.
      const caseUpdate = (tx.case.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(caseUpdate.data.status).toBeUndefined();
      // Flag row written in the SAME transaction, naming the stale signed version.
      const flagLogs = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => (c[0] as { data: { action: string } }).data.action === 'letter_edited_after_signoff');
      expect(flagLogs).toHaveLength(1);
      expect((flagLogs[0][0] as { data: { detailsJson: Record<string, unknown> } }).data.detailsJson).toMatchObject({ staleSignedVersion: 1, newVersion: 2, fromStatus: 'physician_review', source: 'editor_save' });
    });

    it('surgical-ai APPLY over a signed version: same flag + notice (the AI door can not dodge the re-sign rule)', async () => {
      const { db, tx } = makeDb();
      bindSignOffToV1(tx);
      const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/surgical-ai')
        .send({ apply: true, proposal: { operation: 'replace', anchor_text: 'lumbosacral strain', new_text: 'lumbosacral strain (DC 5237)' } });
      expect(res.status).toBe(200);
      expect(res.body.data.notice).toBe('This letter was signed before this edit — the doctor must re-sign before it can be delivered.');
      const flagLogs = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => (c[0] as { data: { action: string } }).data.action === 'letter_edited_after_signoff');
      expect(flagLogs).toHaveLength(1);
      expect((flagLogs[0][0] as { data: { detailsJson: Record<string, unknown> } }).data.detailsJson).toMatchObject({ source: 'surgical_ai' });
    });

    it('PUT with NO sign-off bound to the edited version: notice null, no flag log (nothing went stale)', async () => {
      const { db, tx } = makeDb(); // default signOff.findFirst resolves undefined → treated as none
      const res = await request(appFor(db, deps())).put('/api/v1/cases/CASE-1/letter').send({ base_version: 1, txt: 'plain edit' });
      expect(res.status).toBe(200);
      expect(res.body.data.notice).toBeNull();
      const flagLogs = (tx.activityLog.create as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => String((c[0] as { data: { action: string } }).data.action).startsWith('letter_edited_after_signoff'));
      expect(flagLogs).toHaveLength(0);
    });
  });
});
