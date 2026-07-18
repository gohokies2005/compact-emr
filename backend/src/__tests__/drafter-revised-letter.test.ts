import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterWorkerRouter, type DrafterWorkerRouterDeps } from '../routes/drafter.js';
import { requireDrafterPrincipal } from '../middleware/drafter-principal.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import type { VerifyResult } from '../services/citation-enricher.js';

/**
 * Coverage for POST /api/v1/internal/drafter/cases/:id/revised-letter (revised-letter recovery,
 * 2026-07-16). An out-of-band physician-corrected TXT is pushed into physician_review WITHOUT a
 * re-draft: the endpoint bounds the body, refuses a fabricated PMID / SSN-PHI BEFORE any render,
 * refuses a push while a draft is in flight (else a later /complete buries it), re-renders the trio,
 * advances Case.currentVersion, and logs 'revised_letter_imported'. Two different bodies at the same
 * version 409 (version_conflict, NOT an idempotent no-op).
 */

interface CaseRowT {
  id: string;
  veteranId: string;
  claimedCondition: string;
  currentVersion: number;
  status: string;
  version: number;
}
interface VetRowT { id: string; firstName: string; lastName: string }
interface JobRowT { id: string; version: number; state: string; lastHeartbeatAt: Date | null }

function defaultCase(over: Partial<CaseRowT> = {}): CaseRowT {
  return { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'sleep apnea', currentVersion: 5, status: 'rn_review', version: 9, ...over };
}
function defaultVet(over: Partial<VetRowT> = {}): VetRowT {
  return { id: 'VET-1', firstName: 'Pat', lastName: 'Lozano', ...over };
}

interface MakeDbOpts {
  caseRow?: CaseRowT | null;
  veteran?: VetRowT | null;
  activeJob?: JobRowT | null;
  maxJob?: JobRowT | null;
  revisionThrows?: unknown; // when set, letterRevision.create throws it (P2002 conflict test)
}

function makeDb(opts: MakeDbOpts = {}) {
  const caseRow = opts.caseRow === undefined ? defaultCase() : opts.caseRow;
  const veteran = opts.veteran === undefined ? defaultVet() : opts.veteran;
  const activeJob = opts.activeJob ?? null;
  const maxJob = opts.maxJob ?? null;

  const store = {
    case: {
      findFirst: vi.fn(async () => caseRow),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (caseRow === null) throw new Error('no case');
        const d = args.data;
        if (typeof d['version'] === 'object' && d['version'] !== null) {
          caseRow.version += (d['version'] as { increment: number }).increment;
        }
        for (const k of ['currentVersion', 'status'] as const) {
          if (d[k] !== undefined) (caseRow as unknown as Record<string, unknown>)[k] = d[k];
        }
        return caseRow;
      }),
    },
    veteran: { findUnique: vi.fn(async () => veteran) },
    // Two call shapes: the active-job guard (where.OR, no orderBy) and the max-version lookup (orderBy).
    draftJob: {
      findFirst: vi.fn(async (args: { orderBy?: unknown }) => (args?.orderBy !== undefined ? maxJob : activeJob)),
    },
    letterRevision: {
      create: vi.fn(async (_args: { data: Record<string, unknown> }) => {
        if (opts.revisionThrows !== undefined) throw opts.revisionThrows;
        return {};
      }),
    },
    activityLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  };
  const db = { ...store, $transaction: vi.fn(async (fn: (inner: typeof store) => unknown) => fn(store)) } as unknown as AppDb;
  return { db, store, caseRow };
}

const OK_VERIFY: VerifyResult = { verified: true, pmid: '12345678', title: 't', journal: 'j', year: '2020', killer_finding: 'k' };

function deps(over: Partial<DrafterWorkerRouterDeps> = {}): DrafterWorkerRouterDeps {
  const renderLetter = vi.fn(async (input: { keys: { txtKey: string; pdfKey: string; docxKey: string }; version: number }) => ({
    ok: true, version: input.version, keys: input.keys, sizes: { txt: 10, pdf: 20, docx: 30 },
  }));
  const verifyPmid = vi.fn(async (_pmid: string, _condition?: string): Promise<VerifyResult> => OK_VERIFY);
  return { renderLetter, verifyPmid, bucketName: 'phi-test', ...over } as DrafterWorkerRouterDeps;
}

function errorMw(error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) {
  if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
  return sendError(res, 500, 'internal_error', 'Unexpected server error.');
}

function appFor(db: AppDb, d: DrafterWorkerRouterDeps) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', createDrafterWorkerRouter(db, d));
  app.use(errorMw);
  return app;
}

function appWithAuth(db: AppDb, d: DrafterWorkerRouterDeps) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', requireDrafterPrincipal(), createDrafterWorkerRouter(db, d));
  app.use(errorMw);
  return app;
}

const URL = '/api/v1/internal/drafter/cases/CASE-1/revised-letter';
const GOOD_LETTER = 'Dear Sir,\n\nThis nexus letter supports the claim. See PMID 12345678 for the mechanism.\n\nSincerely,\nDr. K';

beforeEach(() => { vi.clearAllMocks(); });

// (a) AUTH — the drafter-principal token is required; the shared worker token does NOT authenticate.
describe('auth (requireDrafterPrincipal)', () => {
  const REAL_DRAFTER = 'drafter-token-abcdefghijklmnop'; // >=16 chars
  const WORKER_TOKEN = 'internal-worker-token-xyz-0123456789';
  let savedDrafter: string | undefined;
  let savedWorker: string | undefined;
  beforeEach(() => { savedDrafter = process.env.DRAFTER_INVOKE_TOKEN; savedWorker = process.env.INTERNAL_WORKER_TOKEN; });
  afterEach(() => {
    if (savedDrafter === undefined) delete process.env.DRAFTER_INVOKE_TOKEN; else process.env.DRAFTER_INVOKE_TOKEN = savedDrafter;
    if (savedWorker === undefined) delete process.env.INTERNAL_WORKER_TOKEN; else process.env.INTERNAL_WORKER_TOKEN = savedWorker;
  });

  it('401 when the token is missing, 401 when wrong, and the shared worker token does NOT authenticate', async () => {
    process.env.DRAFTER_INVOKE_TOKEN = REAL_DRAFTER;
    process.env.INTERNAL_WORKER_TOKEN = WORKER_TOKEN;
    const { db, store } = makeDb();
    const app = appWithAuth(db, deps());

    const noTok = await request(app).post(URL).send({ letterText: GOOD_LETTER });
    expect(noTok.status).toBe(401);

    const wrongTok = await request(app).post(URL).set('X-Drafter-Invoke-Token', 'nope').send({ letterText: GOOD_LETTER });
    expect(wrongTok.status).toBe(401);

    // The shared INTERNAL_WORKER_TOKEN presented to the drafter route must be rejected.
    const workerTok = await request(app).post(URL).set('X-Drafter-Invoke-Token', WORKER_TOKEN).send({ letterText: GOOD_LETTER });
    expect(workerTok.status).toBe(401);

    // None of the rejected calls reached the handler.
    expect(store.case.findFirst).not.toHaveBeenCalled();
  });

  it('503 when DRAFTER_INVOKE_TOKEN is unset (not configured)', async () => {
    delete process.env.DRAFTER_INVOKE_TOKEN;
    const { db } = makeDb();
    const res = await request(appWithAuth(db, deps())).post(URL).set('X-Drafter-Invoke-Token', 'anything').send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(503);
  });
});

// (b) HAPPY PATH — revision at max+1, currentVersion advanced, status physician_review, logged, 3 keys.
describe('happy path', () => {
  it('creates a revised_import revision at max+1, advances currentVersion, moves to physician_review, logs the import', async () => {
    const { db, store, caseRow } = makeDb({ caseRow: defaultCase({ currentVersion: 5, version: 9 }), maxJob: { id: 'J9', version: 5, state: 'done', lastHeartbeatAt: null } });
    if (caseRow === null) throw new Error('caseRow was null');
    const d = deps();
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER, reason: 'physician hand-fix' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(6); // max(5,5)+1
    expect(res.body.verifiedPmids).toEqual(['12345678']);

    // Render ran once for version 6.
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // Revision persisted with source 'revised_import' and all three artifact keys non-null.
    expect(store.letterRevision.create).toHaveBeenCalledTimes(1);
    const revData = store.letterRevision.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(revData.source).toBe('revised_import');
    expect(revData.version).toBe(6);
    expect(revData.parentVersion).toBe(5);
    expect(revData.editedBy).toBe('service:drafter');
    expect(revData.editorRole).toBe('drafter');
    expect(typeof revData.artifactTxtS3Key).toBe('string');
    expect(typeof revData.artifactPdfS3Key).toBe('string');
    expect(typeof revData.artifactDocxS3Key).toBe('string');
    expect(revData.artifactTxtS3Key).not.toBe('');
    expect(revData.artifactPdfS3Key).not.toBe('');
    expect(revData.artifactDocxS3Key).not.toBe('');

    // Case pointer + status advanced.
    expect(caseRow.currentVersion).toBe(6);
    expect(caseRow.status).toBe('physician_review');
    expect(caseRow.version).toBe(10); // +1

    // Audit log.
    const logData = store.activityLog.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(logData.action).toBe('revised_letter_imported');
    expect(logData.actorUserId).toBe('service:drafter');
    expect((logData.detailsJson as Record<string, unknown>).reason).toBe('physician hand-fix');
    expect((logData.detailsJson as Record<string, unknown>).verifiedPmids).toEqual(['12345678']);
  });

  // (b2) DAVIS THYROID (2026-07-18): a case ALREADY in physician_review must accept a corrected-letter
  // replace. Pre-fix this 409'd ("cannot move to physician_review from status 'physician_review'") because
  // the transition table omits the self-edge — but replacing a letter already in the doctor's queue is the
  // ENTIRE POINT of this recovery endpoint. Must succeed, land a new revision, and stay in physician_review.
  it('accepts a corrected-letter push for a case ALREADY in physician_review (self-replace, not a 409)', async () => {
    const { db, store, caseRow } = makeDb({ caseRow: defaultCase({ status: 'physician_review', currentVersion: 5, version: 9 }), maxJob: { id: 'J9', version: 5, state: 'done', lastHeartbeatAt: null } });
    if (caseRow === null) throw new Error('caseRow was null');
    const res = await request(appFor(db, deps())).post(URL).send({ letterText: GOOD_LETTER, reason: 'physician hand-fix on a case already in review' });

    expect(res.status).toBe(200); // NOT 409 illegal_status_transition
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(6);
    expect(store.letterRevision.create).toHaveBeenCalledTimes(1);
    expect(caseRow.currentVersion).toBe(6);
    expect(caseRow.status).toBe('physician_review'); // stays in the doctor's queue with the new letter
  });
});

// (c) FABRICATED PMID — 422, nothing persisted, render NEVER called (pre-render gate).
describe('fabricated PMID', () => {
  it('422 fabricated_pmid; render never called; nothing persisted', async () => {
    const { db, store } = makeDb();
    const d = deps({ verifyPmid: vi.fn(async (): Promise<VerifyResult> => ({ verified: false, pmid: '12345678', title: '', journal: '', year: '', killer_finding: '', reason: 'not found' })) });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.details.reason).toBe('fabricated_pmid');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
    expect(store.case.update).not.toHaveBeenCalled();
  });

  it('422 ncbi_unavailable when the verifier keeps failing transiently — retried, then still fail-CLOSED', async () => {
    const { db, store } = makeDb();
    // A persistent transient outage (throw → caught as verify_error → retried with backoff) must still
    // BLOCK the push — but as ncbi_unavailable ("retry in a moment"), NOT fabricated_pmid, which would
    // falsely brand a real PMID fake. Render still never runs; nothing is persisted (fail-closed holds).
    const d = deps({ verifyPmid: vi.fn(async () => { throw new Error('ETIMEDOUT eutils'); }) });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('ncbi_unavailable');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });

  it('422 fabricated_pmid (NOT ncbi_unavailable) when no_summary PERSISTS — retried defensively, then branded fabricated', async () => {
    const { db, store } = makeDb();
    // no_summary = esummary returned 200-OK with no record for the PMID = the paper does not exist.
    // We retry it (in case a masked rate-limit body ever reads empty — the Tanner defensive path), but a
    // reason that PERSISTS across all attempts must be reported as fabricated, never as a false "outage"
    // that would loop the physician forever on a dead PMID. (architect QA 2026-07-18)
    const verifyPmid = vi.fn(async (): Promise<VerifyResult> => ({ verified: false, pmid: '12345678', title: '', journal: '', year: '', killer_finding: '', reason: 'no_summary' }));
    const d = deps({ verifyPmid });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('fabricated_pmid'); // NOT ncbi_unavailable
    expect(verifyPmid.mock.calls.length).toBe(3); // was retried (Tanner-safe), not failed on first read
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });

  // (c2) MOLE 11-13 (Davis thyroid, 2026-07-18): a REAL, non-retracted, physician-CHOSEN paper that merely
  // fails the retrieval-grade grounding heuristics (no verbatim killer stat / short abstract / off-topic
  // token-match) is NOT fabrication — it must be ACCEPTED. Pre-fix these definitive real-paper reasons were
  // branded fabricated_pmid and blocked the push. The physician's citation choice is the relevance authority
  // (same policy as the by-PMID enricher, which passes no condition).
  it('ACCEPTS a real physician-chosen paper that lacks a grounded killer stat (no_grounded_stat -> 200, not fabricated)', async () => {
    const { db, store } = makeDb({ caseRow: defaultCase({ currentVersion: 5, version: 9 }), maxJob: { id: 'J9', version: 5, state: 'done', lastHeartbeatAt: null } });
    // Real paper: esummary + efetch succeeded (has title/abstract), just no verbatim CONCLUSIONS-style stat.
    const verifyPmid = vi.fn(async (_pmid: string, _condition?: string): Promise<VerifyResult> => ({ verified: false, pmid: '12345678', title: 'Thyroid dysfunction after service exposure', journal: 'Thyroid', year: '2019', killer_finding: '', reason: 'no_grounded_stat' }));
    const d = deps({ verifyPmid });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER, reason: 'physician-chosen mechanistic cite' });

    expect(res.status).toBe(200); // accepted, NOT 422 fabricated_pmid
    expect(res.body.ok).toBe(true);
    expect(store.letterRevision.create).toHaveBeenCalledTimes(1);
    // On-topic gate skipped: the verifier is called WITHOUT the claimed condition (empty 2nd arg).
    expect(verifyPmid.mock.calls[0]?.[1]).toBe('');
  });

  // (c3) RETRACTED still fails closed — but with an HONEST label, not "fabricated". A retracted paper is
  // real; branding it fabricated would be wrong, and citing retracted science in a nexus letter is unsafe.
  it('BLOCKS a retracted paper as cites_retracted_paper (not fabricated_pmid), fail-closed', async () => {
    const { db, store } = makeDb();
    const d = deps({ verifyPmid: vi.fn(async (): Promise<VerifyResult> => ({ verified: false, pmid: '12345678', title: 'Retracted study', journal: 'J', year: '2015', killer_finding: '', reason: 'retracted' })) });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('cites_retracted_paper');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });

  it('RETRIES a transient NCBI error and SUCCEEDS when the verifier recovers (the throttle fix)', async () => {
    const { db, store } = makeDb();
    let n = 0;
    // First verify = a transient efetch_error (a throttled NCBI round-trip); it recovers on retry, the
    // real citation verifies, and the push goes through. This is the exact 5-citation throttle failure
    // the fix targets — a real PMID must not be blocked by NCBI rate-limiting.
    const verifyPmid = vi.fn(async (): Promise<VerifyResult> => {
      n += 1;
      return n === 1
        ? { verified: false, pmid: '12345678', title: '', journal: '', year: '', killer_finding: '', reason: 'efetch_error' }
        : OK_VERIFY;
    });
    const d = deps({ verifyPmid });
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER, reason: 'physician hand-fix' });
    expect(res.status).toBeLessThan(300);                          // push went through after the retry
    expect(verifyPmid.mock.calls.length).toBeGreaterThanOrEqual(2); // failed once (transient), retried
    expect(store.letterRevision.create).toHaveBeenCalled();
  });
});

// (d) TWO PUSHES SAME VERSION — 409 version_conflict (unique [caseId,version]).
describe('version conflict', () => {
  it('409 version_conflict when the revision unique constraint fires (P2002)', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const { db } = makeDb({ revisionThrows: p2002 });
    const res = await request(appFor(db, deps())).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('version_conflict');
  });
});

// (e) ACTIVE DRAFTJOB — 409 draft_in_flight (else a later /complete buries the recovery letter).
describe('draft in flight', () => {
  it('409 draft_in_flight when a running job is heartbeating within the stale window; render never called', async () => {
    const { db, store } = makeDb({ activeJob: { id: 'J-RUN', version: 6, state: 'running', lastHeartbeatAt: new Date() } });
    const d = deps();
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('draft_in_flight');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });
});

// (f) ILLEGAL STATUS — 409 when the case can't reach physician_review (e.g. rejected).
describe('illegal status transition', () => {
  it('409 illegal_status_transition from a rejected case; render never called', async () => {
    const { db, store } = makeDb({ caseRow: defaultCase({ status: 'rejected' }) });
    const d = deps();
    const res = await request(appFor(db, d)).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('illegal_status_transition');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });
});

// (g) RENDER !ok — 502, nothing persisted.
describe('render failure', () => {
  it('502 render_failed; nothing persisted', async () => {
    const renderLetter = vi.fn(async (input: { keys: unknown; version: number }) => ({ ok: false, version: input.version, keys: input.keys as { txtKey: string; pdfKey: string; docxKey: string }, sizes: { txt: 0, pdf: 0, docx: 0 } }));
    const { db, store } = makeDb();
    const res = await request(appFor(db, deps({ renderLetter }))).post(URL).send({ letterText: GOOD_LETTER });
    expect(res.status).toBe(502);
    expect(res.body.error.details.reason).toBe('render_failed');
    expect(store.letterRevision.create).not.toHaveBeenCalled();
    expect(store.case.update).not.toHaveBeenCalled();
  });
});

// (h) SSN IN BODY — 422, render never called, nothing persisted.
describe('SSN PHI guard', () => {
  it('422 phi_ssn_detected; render never called; nothing persisted', async () => {
    const { db, store } = makeDb();
    const d = deps();
    const res = await request(appFor(db, d)).post(URL).send({ letterText: `${GOOD_LETTER}\nSSN 123-45-6789 on file.` });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('phi_ssn_detected');
    expect((d.renderLetter as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(store.letterRevision.create).not.toHaveBeenCalled();
  });
});
