import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDrafterWorkerRouter, type DrafterWorkerRouterDeps } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';

/**
 * /halt MUST PRESERVE A PRODUCED DRAFT (2026-06-22, option A — no-FRN-change path).
 *
 * A body-quality park is the one halt class where a FULL letter WAS produced. Before this change the
 * /halt receiver parked the case (state='halted', status='needs_rn_decision') but never persisted an
 * artifact key and never advanced Case.currentVersion — so getLetter (resolveCurrentTxtKey, which
 * falls back to the DraftJob row at currentVersion) could not reach the produced txt. The held letter
 * was invisible/uneditable.
 *
 * Fix: when the halt should carry a produced draft, reconstruct the CANONICAL key
 * drafter-artifacts/<caseId>/v<N>/v<N>.txt, validate it, and HeadObject-check it. ONLY when the object
 * ACTUALLY exists do we (a) set DraftJob.artifactTxtS3Key and (b) advance Case.currentVersion to the
 * halted version. When the object does NOT exist (the genuine no-draft case incl. the Gate-2 dx-halt
 * path, OR S3/bucket unconfigured), nothing about version/key changes — it stays no-draft so the dx-halt
 * confirm/halt panel is untouched. Fail-safe default: never advance currentVersion onto a draft we
 * cannot prove exists.
 */

interface JobRow {
  id: string; caseId: string; version: number; state: string;
  manifestSnapshot: unknown; errorMessage: string | null; failureClass: string | null;
  completedAt: Date | null; lastHeartbeatAt: Date | null; haltPayloadJson: unknown;
  artifactTxtS3Key: string | null;
}
interface CaseR { id: string; version: number; currentVersion: number | null; status: string; operatorState: string | null; operatorMessage: string | null; runComplete: boolean | null }

function makeDb(job: JobRow, c: CaseR) {
  const caseUpdate = vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
    const d = a.data;
    if (typeof d['version'] === 'object' && d['version'] !== null) c.version += (d['version'] as { increment: number }).increment;
    for (const k of ['status', 'operatorState', 'operatorMessage', 'runComplete', 'currentVersion'] as const) {
      if (d[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = d[k] as never;
    }
    return c;
  });
  const jobUpdate = vi.fn(async (a: { where: { id: string }; data: Partial<JobRow> }) => { Object.assign(job, a.data); return job; });
  const tx = {
    draftJob: { findUnique: vi.fn(async (a: { where: { id: string } }) => (a.where.id === job.id ? job : null)), update: jobUpdate },
    case: { update: caseUpdate },
    draftDecision: { create: vi.fn(async () => ({})) },
    activityLog: { create: vi.fn(async () => ({})) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, job, c, spies: { caseUpdate, jobUpdate } };
}

/** Minimal S3 stub: HeadObject resolves for keys in `present`, throws NotFound otherwise. */
function s3Stub(present: Set<string>) {
  const send = vi.fn(async (cmd: { input?: { Key?: string } }) => {
    const key = cmd.input?.Key ?? '';
    if (present.has(key)) return {};
    const err = new Error('NotFound'); err.name = 'NotFound'; throw err;
  });
  return { send } as unknown as NonNullable<DrafterWorkerRouterDeps['s3']>;
}

function appFor(db: AppDb, deps: DrafterWorkerRouterDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createDrafterWorkerRouter(db, deps));
  app.use((e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    if (isHttpError(e)) return sendError(res, e.status, e.code, e.message, e.details);
    return sendError(res, 500, 'internal_error', 'err');
  });
  return app;
}

const jobRow = (o: Partial<JobRow> = {}): JobRow => ({ id: 'JOB-1', caseId: 'CASE-1', version: 3, state: 'running', manifestSnapshot: null, errorMessage: null, failureClass: null, completedAt: null, lastHeartbeatAt: new Date('2026-06-01T00:00:00Z'), haltPayloadJson: null, artifactTxtS3Key: null, ...o });
const caseR = (o: Partial<CaseR> = {}): CaseR => ({ id: 'CASE-1', version: 5, currentVersion: 2, status: 'drafting', operatorState: null, operatorMessage: null, runComplete: true, ...o });
const bodyQualityHalt = (o: Record<string, unknown> = {}) => ({
  haltGate: 'body_quality', reasonCode: 'body_quality_critical',
  plainEnglish: 'Drafting completed but the quality gate found a fabricated PMID.',
  operatorState: 'needs_rn_decision', runComplete: false,
  materialIds: ['pmid_not_found'], ...o,
});
const dxHalt = (o: Record<string, unknown> = {}) => ({
  haltGate: 'dx_verification', reasonCode: 'dx_not_found',
  plainEnglish: 'No diagnosis of PTSD found in the records.',
  operatorState: 'needs_rn_decision', runComplete: false, ...o,
});

const canonicalTxtKey = (caseId: string, v: number) => `drafter-artifacts/${caseId}/v${v}/v${v}.txt`;

describe('/halt preserves a produced draft', () => {
  it('body-quality halt WITH the produced txt in S3: persists artifactTxtS3Key + advances currentVersion', async () => {
    const { db, job, c } = makeDb(jobRow({ version: 3 }), caseR({ currentVersion: 2 }));
    const deps = { s3: s3Stub(new Set([canonicalTxtKey('CASE-1', 3)])), bucketName: 'phi-bucket' };
    const res = await request(appFor(db, deps)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(bodyQualityHalt()).expect(200);
    // The held letter is now reachable by getLetter (resolveCurrentTxtKey → DraftJob fallback at currentVersion).
    expect(job.artifactTxtS3Key).toBe(canonicalTxtKey('CASE-1', 3));
    expect(c.currentVersion).toBe(3);
    // Still parked for the RN decision — status is the gate, NOT currentVersion (F4 invariant).
    expect(job.state).toBe('halted');
    expect(c.status).toBe('needs_rn_decision');
    expect(res.body.data.case.status).toBe('needs_rn_decision');
  });

  it('body-quality halt with NO produced txt in S3: leaves currentVersion + key untouched (stays no-draft)', async () => {
    const { db, job, c } = makeDb(jobRow({ version: 3 }), caseR({ currentVersion: 2 }));
    const deps = { s3: s3Stub(new Set()), bucketName: 'phi-bucket' }; // object absent
    await request(appFor(db, deps)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(bodyQualityHalt()).expect(200);
    expect(job.artifactTxtS3Key).toBeNull();
    expect(c.currentVersion).toBe(2); // unchanged
    expect(c.status).toBe('needs_rn_decision');
  });

  it('dx-halt (genuine no-draft) NEVER advances currentVersion even if some txt object happens to exist', async () => {
    const { db, job, c } = makeDb(jobRow({ version: 3 }), caseR({ currentVersion: 2 }));
    // Even with the canonical key present, a dx_not_found halt is not a produced-draft halt.
    const deps = { s3: s3Stub(new Set([canonicalTxtKey('CASE-1', 3)])), bucketName: 'phi-bucket' };
    await request(appFor(db, deps)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(dxHalt()).expect(200);
    expect(job.artifactTxtS3Key).toBeNull();
    expect(c.currentVersion).toBe(2);
    expect(c.status).toBe('needs_rn_decision');
  });

  it('body-quality halt with S3 deps unconfigured: fail-safe to no-draft (no currentVersion advance)', async () => {
    const { db, job, c } = makeDb(jobRow({ version: 3 }), caseR({ currentVersion: 2 }));
    await request(appFor(db, {})).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(bodyQualityHalt()).expect(200);
    expect(job.artifactTxtS3Key).toBeNull();
    expect(c.currentVersion).toBe(2);
    expect(c.status).toBe('needs_rn_decision');
  });

  it('legacy verify_error + haltGate body_quality WITH the produced txt: also preserves the draft', async () => {
    const { db, job, c } = makeDb(jobRow({ version: 4 }), caseR({ currentVersion: 3 }));
    const deps = { s3: s3Stub(new Set([canonicalTxtKey('CASE-1', 4)])), bucketName: 'phi-bucket' };
    await request(appFor(db, deps)).post('/api/v1/internal/drafter/jobs/JOB-1/halt')
      .send(bodyQualityHalt({ reasonCode: 'verify_error' })).expect(200);
    expect(job.artifactTxtS3Key).toBe(canonicalTxtKey('CASE-1', 4));
    expect(c.currentVersion).toBe(4);
  });
});
