import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLetterRouter, type LetterRouterDeps } from '../routes/letter.js';
import { insertVerifiedCitations } from '../services/citation-enricher.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, Role } from '../services/db-types.js';

/**
 * Feature B — Citation Enricher (2026-06-24). Tests the three async-poll routes + the keystone
 * apply-time SERVER-SIDE re-verify + sanctioned-citation guard. The grounded NCBI retrieve, the
 * apply-time verify, and the Haiku term-extractor are all INJECTED stubs (no real network).
 */

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

vi.mock('../services/request-actor.js', () => ({
  currentActor: (req: express.Request) => {
    const u = (req as express.Request & { user?: MockUser }).user;
    return { sub: u?.sub ?? 'X', email: null, roles: u?.roles ?? [], role: u?.roles?.[0] ?? 'ops_staff' };
  },
}));

// A letter with §VI + §VIII so insertion has real anchors.
const LETTER_TXT = [
  'VI. Medical Reasoning',
  'The mechanism is established.',
  '',
  'VII. Opinion',
  '**It is more likely than not (greater than 50% probability) due to service.**',
  '',
  'VIII. References',
  '1. Existing A. A study. J Test. 2010. PMID: 11111111.',
].join('\n');

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date('2026-06-24T00:00:00.000Z');
  return {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Obstructive sleep apnea',
    claimedConditions: ['Obstructive sleep apnea'], claimType: 'initial', framingChoice: 'secondary',
    previouslyDenied: false, priorDenialReason: null, priorDecisionDate: null,
    upstreamScCondition: null, veteranStatement: null, inServiceEvent: null,
    status: 'physician_review', cdsVerdict: 'accept', cdsOddsPct: 70, cdsRationale: null,
    assignedPhysicianId: 'PHYS-001', assignedRnId: null, refundEligible: false, currentVersion: 1,
    createdAt: now, updatedAt: now, version: 3, ...overrides,
  };
}

interface JobRow {
  id: string; caseId: string; status: string; condition: string | null; claim: string | null;
  mechanismHints: string[]; candidatesJson: unknown; errorMessage: string | null; requestedBy: string;
  createdAt: Date; updatedAt: Date;
}

function makeDb(opts: { caseOverride?: Partial<CaseRecord>; job?: Partial<JobRow> } = {}) {
  const caseRow = baseCase(opts.caseOverride);
  const jobStore: { row: JobRow | null } = { row: null };
  const enrichDelegate = {
    create: vi.fn(async (a: { data: Record<string, unknown> }) => {
      const row: JobRow = {
        id: 'JOB-1', caseId: 'CASE-1', status: 'pending', condition: null, claim: null,
        mechanismHints: [], candidatesJson: null, errorMessage: null, requestedBy: 'PHYS-SUB',
        createdAt: new Date(), updatedAt: new Date(), ...(a.data as Partial<JobRow>),
      };
      jobStore.row = row;
      return row;
    }),
    update: vi.fn(async (a: { where: { id: string }; data: Partial<JobRow> }) => {
      jobStore.row = { ...(jobStore.row as JobRow), ...a.data };
      return jobStore.row;
    }),
    // findFirst resolves the poll/apply target. If propose ran it returns that row; otherwise
    // (apply-only tests) it returns a default ready job so the apply path has a job to read.
    findFirst: vi.fn(async () => {
      const fallback: JobRow = { id: 'JOB-1', caseId: 'CASE-1', status: 'ready', condition: 'obstructive sleep apnea', claim: null, mechanismHints: [], candidatesJson: null, errorMessage: null, requestedBy: 'PHYS-SUB', createdAt: new Date(), updatedAt: new Date() };
      const row = jobStore.row ?? fallback;
      return opts.job ? { ...row, ...opts.job } : row;
    }),
    findUnique: vi.fn(async () => jobStore.row),
  };
  const tx = {
    letterRevision: { create: vi.fn(async (a: { data: Record<string, unknown> }) => a.data) },
    case: { update: vi.fn(async (a: { data: Record<string, unknown> }) => ({ ...caseRow, ...a.data })) },
    activityLog: { create: vi.fn(async () => ({})) },
  };
  const db = {
    case: { findFirst: vi.fn(async () => caseRow) },
    veteran: { findUnique: vi.fn(async () => ({ id: 'VET-1', firstName: 'Robert', lastName: 'Testcase' })) },
    letterRevision: { findFirst: vi.fn(async () => ({ version: 1, artifactTxtS3Key: 'k/v1/letter.txt', artifactPdfS3Key: 'k/v1/letter.pdf', artifactDocxS3Key: 'k/v1/letter.docx' })) },
    draftJob: { findFirst: vi.fn(async () => null) },
    signOff: { findFirst: vi.fn(async () => null) },
    // physician.findUnique resolves the requesting physician for the assignment check
    // (enforcePhysicianAssignment → resolveCurrentPhysician). PHYS-SUB → PHYS-001 (the assignee).
    physician: { findUnique: vi.fn(async (a: { where?: { cognitoSub?: string } }) => (a.where?.cognitoSub === 'PHYS-SUB' ? { id: 'PHYS-001', cognitoSub: 'PHYS-SUB', active: true } : null)), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    citationEnrichJob: enrichDelegate,
    activityLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return { db, tx, enrichDelegate, jobStore };
}

function deps(over: Partial<LetterRouterDeps> = {}): LetterRouterDeps {
  return {
    bucketName: 'phi-bucket',
    s3: { send: vi.fn(async () => ({ Body: { transformToString: async () => LETTER_TXT } })) } as unknown as LetterRouterDeps['s3'],
    renderLetter: vi.fn(async (i) => ({ ok: true, version: i.version, keys: i.keys, sizes: { txt: 1, pdf: 1, docx: 1 } })),
    enrichRetrieve: vi.fn(async () => ({
      condition: 'osa', status: 'grounded' as const, retrieved_at: 'now', trace: [],
      anchors: [{ slot: 'A2' as const, slot_label: 'EPI', pmid: '22222222', title: 'OSA and PTSD', journal: 'J Sleep', year: '2020', full_citation: 'X. OSA and PTSD. J Sleep. 2020.', killer_finding: 'OSA prevalence was elevated.', source: 'fallback_ncbi_grounded', title_match: true }],
    })),
    enrichVerify: vi.fn(async (pmid: string) => (
      pmid === '22222222'
        ? { verified: true, pmid: '22222222', title: 'OSA and PTSD', journal: 'J Sleep', year: '2020', killer_finding: 'OSA prevalence was elevated.', full_citation: 'Gupta MA, Simpson FC. OSA and PTSD. J Sleep. 2020;11(2):165-175' }
        : { verified: false, pmid, title: '', journal: '', year: '', killer_finding: '', reason: 'no_summary' }
    )),
    extractTerms: vi.fn(async () => ({ condition: 'obstructive sleep apnea', mechanismHints: [] })),
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

// Let the fire-and-forget async retrieval settle before polling.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Citation Enricher routes (Feature B)', () => {
  beforeEach(() => { mockUser = { sub: 'PHYS-SUB', roles: ['physician'] }; });

  it('PROPOSE returns 202 + jobId and fills candidates the POLL can read', async () => {
    const { db } = makeDb();
    const d = deps();
    const app = appFor(db, d);
    const proposeRes = await request(app).post('/api/v1/cases/CASE-1/letter/citations/enrich').send({ claim: 'OSA is aggravated by PTSD.' });
    expect(proposeRes.status).toBe(202);
    expect(proposeRes.body.data.jobId).toBe('JOB-1');
    expect(proposeRes.body.data.status).toBe('pending');
    await settle();
    const pollRes = await request(app).get('/api/v1/cases/CASE-1/letter/citations/enrich/JOB-1');
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.data.status).toBe('ready');
    expect(pollRes.body.data.candidates[0].pmid).toBe('22222222');
    expect(pollRes.body.data.candidates[0].pubmedUrl).toContain('22222222');
  });

  it('APPLY with a re-verified PMID inserts the citation + creates a new version', async () => {
    const { db, tx } = makeDb();
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/citations/apply')
      .send({ jobId: 'JOB-1', selectedPmids: ['22222222'] });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.insertedPmids).toEqual(['22222222']);
    // BUG 1: the §VIII entry is in the HOUSE numbered format built from full_citation.
    expect(res.body.data.txt).toMatch(/2\. Gupta MA, Simpson FC\. OSA and PTSD\. J Sleep\. 2020;11\(2\):165-175\. PMID: 22222222\./);
    expect(tx.letterRevision.create).toHaveBeenCalled();
    const arg = (tx.letterRevision.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { data: { source: string } };
    expect(arg.data.source).toBe('surgical_ai');
  });

  it('APPLY REJECTS (422) a selectedPmid that fails the SERVER-SIDE re-verify — nothing changes', async () => {
    const { db, tx } = makeDb();
    // 99999999 is unverified by the stub → the whole apply is refused.
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/citations/apply')
      .send({ jobId: 'JOB-1', selectedPmids: ['22222222', '99999999'] });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('citation_unverified');
    expect(tx.letterRevision.create).not.toHaveBeenCalled(); // no version created
  });

  it('APPLY re-verifies SERVER-SIDE (does not trust the client) — every selected PMID hits enrichVerify', async () => {
    const { db } = makeDb();
    const d = deps();
    await request(appFor(db, d)).post('/api/v1/cases/CASE-1/letter/citations/apply')
      .send({ jobId: 'JOB-1', selectedPmids: ['22222222'] });
    expect(d.enrichVerify).toHaveBeenCalledWith('22222222', expect.any(String));
  });

  it('BUG 2: condition-search APPLY adds a numbered §VIII reference, NOT a generic §VI sentence', async () => {
    const { db } = makeDb({ job: { condition: 'obstructive sleep apnea', claim: null } });
    // groundInSectionVi:true is sent (old client) but is now IGNORED — no §VI sentence is added.
    const res = await request(appFor(db, deps())).post('/api/v1/cases/CASE-1/letter/citations/apply')
      .send({ jobId: 'JOB-1', selectedPmids: ['22222222'], groundInSectionVi: true });
    expect(res.status).toBe(200);
    const txt: string = res.body.data.txt;
    // A real numbered §VIII reference in house format:
    expect(txt).toMatch(/2\. Gupta MA, Simpson FC\. OSA and PTSD\. J Sleep\. 2020;11\(2\):165-175\. PMID: 22222222\./);
    // NO generic throwaway §VI sentence:
    expect(txt).not.toMatch(/further supported by additional peer-reviewed literature/i);
    // §VI body untouched:
    expect(txt).toContain('VI. Medical Reasoning\nThe mechanism is established.');
  });

  it('ops_staff (RN) → 403 on PROPOSE, POLL, and APPLY (physician-only)', async () => {
    mockUser = { sub: 'RN-SUB', roles: ['ops_staff'] };
    const { db } = makeDb();
    const app = appFor(db, deps());
    const propose = await request(app).post('/api/v1/cases/CASE-1/letter/citations/enrich').send({ condition: 'osa' });
    const poll = await request(app).get('/api/v1/cases/CASE-1/letter/citations/enrich/JOB-1');
    const apply = await request(app).post('/api/v1/cases/CASE-1/letter/citations/apply').send({ jobId: 'JOB-1', selectedPmids: ['22222222'] });
    expect(propose.status).toBe(403);
    expect(poll.status).toBe(403);
    expect(apply.status).toBe(403);
  });

  it('PROPOSE 503 when the enricher is not wired', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db, deps({ enrichRetrieve: undefined }))).post('/api/v1/cases/CASE-1/letter/citations/enrich').send({ condition: 'osa' });
    expect(res.status).toBe(503);
  });
});

describe('insertVerifiedCitations (deterministic insertion)', () => {
  const CITE = { pmid: '22222222', title: 'OSA and PTSD', journal: 'J Sleep', year: '2020', killer_finding: 'elevated.' };
  // BUG 1: a verified citation now carries a HOUSE-FORMAT full_citation (Author. Title. Journal. Year;Vol(Issue):Pages).
  const CITE_HOUSE = {
    pmid: '31393195', title: 'OSA and PTSD', journal: 'J Sleep', year: '2019', killer_finding: 'elevated.',
    full_citation: 'Spring B, Krakow B, et al. OSA and PTSD among veterans. J Sleep. 2019;5(2):100-110',
  };

  it('appends a numbered §VIII reference continuing the existing numbering (fallback form, no full_citation)', () => {
    const { newText, insertedPmids } = insertVerifiedCitations(LETTER_TXT, [CITE]);
    expect(insertedPmids).toEqual(['22222222']);
    expect(newText).toMatch(/2\. OSA and PTSD\. J Sleep\. 2020 PMID: 22222222\./);
  });

  it('BUG 1: inserts the §VIII entry in the HOUSE numbered format using full_citation', () => {
    const { newText } = insertVerifiedCitations(LETTER_TXT, [CITE_HOUSE]);
    // House format: "<N>. Author(s). Title. Journal. Year;Vol(Issue):Pages. PMID: NNNN." — matches the
    // existing numbered §VIII entries (author block + volume(issue):pages), not the degraded shape.
    expect(newText).toMatch(/2\. Spring B, Krakow B, et al\. OSA and PTSD among veterans\. J Sleep\. 2019;5\(2\):100-110\. PMID: 31393195\./);
  });

  it('BUG 2: NEVER adds a generic Section VI grounding sentence (even if the flag is passed)', () => {
    const { newText } = insertVerifiedCitations(LETTER_TXT, [CITE], { groundInSectionVi: true });
    // The generic §VI sentence was removed; only the §VIII reference is added.
    expect(newText).not.toMatch(/further supported by additional peer-reviewed literature/i);
    expect(newText).toContain('PMID: 22222222'); // the §VIII reference IS present
    // The §VI body is unchanged (no appended sentence).
    expect(newText).toContain('VI. Medical Reasoning\nThe mechanism is established.');
  });

  it('creates a §VIII block if the letter has none', () => {
    const { newText } = insertVerifiedCitations('No references here.', [CITE]);
    expect(newText).toContain('VIII. References');
    expect(newText).toContain('1. OSA and PTSD. J Sleep. 2020 PMID: 22222222.');
  });
});
