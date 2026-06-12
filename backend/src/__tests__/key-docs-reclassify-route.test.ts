import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoctorPackRouter } from '../routes/doctor-pack.js';
import { CLASSIFIER_VERSION_NUM } from '../services/key-docs-classifier.js';

// Assessment 2026-06-12 §2: POST /rn/key-docs/reclassify-stale — the stale-row backfill.
// Classifier upgrades never retrofitted stored KeyDoc rows, so the RN "Doc selection review"
// queue kept showing yesterday's misclassifications (our own Intake_Summary.pdf as
// "unspecified"; Jr_AAD_Nexus.pdf as "Service treatment records"). These tests pin:
//   1. version-0 rows are selected (classifierVersion < CLASSIFIER_VERSION_NUM);
//   2. the intake-summary row reclassifies intake_summary + needsRnReview clears;
//   3. docType flip REPLICATES the generate-path ack-clearing (selectorAcknowledgedAt/By null);
//   4. an already-correct row is version-stamped WITHOUT touching needsRnReview/acks;
//   5. stored document_pages text is fed to the classifier (the content path, not just filename);
//   6. admin-only.

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/doctor-pack.pdf'),
}));
vi.mock('../services/chart-summary-aggregator.js', () => ({
  aggregateChartSummary: vi.fn(async () => null),
}));
vi.mock('../services/doctor-pack-queue.js', () => ({
  publishDoctorPackQueued: vi.fn(async () => ({})),
}));

const ACKED_AT = new Date('2026-06-10T12:00:00.000Z');

// Four stale rows (classifierVersion 0 = legacy), one per pinned behavior.
const ROW_SUMMARY = {
  id: 'kd-summary',
  caseId: 'CASE-1',
  filePath: 'cases/CASE-1/3f2a9c1e-Intake_Summary.pdf',
  docType: 'unspecified',
  classification: 'normal',
  importance: 50,
  needsRnReview: true,
  selectorAcknowledgedAt: null,
  selectorAcknowledgedBy: null,
  classifierVersion: 0,
};
const ROW_NEXUS = {
  id: 'kd-nexus',
  caseId: 'CASE-1',
  filePath: 'cases/CASE-1/bb12cd34-Jr_AAD_Nexus.pdf',
  docType: 'service_treatment_record_summary', // the assessment's exact misfire
  classification: 'high_signal',
  importance: 80,
  needsRnReview: false,
  selectorAcknowledgedAt: ACKED_AT, // RN acked it AS an STR — must not stick after the flip
  selectorAcknowledgedBy: 'rn-9',
  classifierVersion: 0,
};
const ROW_OK = {
  id: 'kd-ok',
  caseId: 'CASE-2',
  filePath: 'cases/CASE-2/cc34ef56-DD-214.pdf',
  docType: 'dd_214', // already correct — stamp only
  classification: 'high_signal',
  importance: 95,
  needsRnReview: false,
  selectorAcknowledgedAt: ACKED_AT,
  selectorAcknowledgedBy: 'rn-9',
  classifierVersion: 0,
};
const ROW_MISC = {
  id: 'kd-misc',
  caseId: 'CASE-2',
  filePath: 'cases/CASE-2/dd56aa77-Misc_2.pdf',
  docType: 'unspecified',
  classification: 'normal',
  importance: 50,
  needsRnReview: true,
  selectorAcknowledgedAt: null,
  selectorAcknowledgedBy: null,
  classifierVersion: 0,
};

const RATING_DECISION_TEXT =
  'Department of Veterans Affairs. We have made a decision on your claim received March 12, 2024.';

function makeDb(opts: { staleRows?: readonly Record<string, unknown>[] } = {}) {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const activityLogCreate = vi.fn(async (_args: unknown) => ({}));
  const tx = {
    keyDoc: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { id: args.where.id, ...args.data };
      }),
    },
    activityLog: { create: activityLogCreate },
  };
  const keyDocFindMany = vi.fn(async (_args: unknown) =>
    opts.staleRows ?? [ROW_SUMMARY, ROW_NEXUS, ROW_OK, ROW_MISC]);
  const db = {
    keyDoc: { findMany: keyDocFindMany },
    document: {
      // Only Misc_2 has a surviving Document row — the others exercise the filename-only
      // fallback (same behavior generation has for a doc with no per-page text).
      findMany: vi.fn(async () => [
        { id: 'doc-misc', s3Key: ROW_MISC.filePath, docTag: null },
      ]),
    },
    documentPage: {
      findMany: vi.fn(async () => [
        { documentId: 'doc-misc', pageNumber: 1, text: RATING_DECISION_TEXT, confidence: 0.98 },
      ]),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as never, updates, spies: { keyDocFindMany, activityLogCreate } };
}

function appFor(db: unknown, role: 'admin' | 'ops_staff' = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'admin-1', email: 'admin@example.com', roles: [role] };
    next();
  });
  app.use('/api/v1', createDoctorPackRouter(db as never));
  app.use((err: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code ?? 'internal_error', message: err.message ?? 'error' } });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /rn/key-docs/reclassify-stale (assessment §2 backfill)', () => {
  it('selects rows below the current classifier version', async () => {
    const { db, spies } = makeDb();
    await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);
    expect(spies.keyDocFindMany).toHaveBeenCalledWith({
      where: { classifierVersion: { lt: CLASSIFIER_VERSION_NUM } },
      orderBy: { updatedAt: 'asc' },
    });
  });

  it('a version-0 Intake_Summary row reclassifies intake_summary and CLEARS needsRnReview', async () => {
    const { db, updates } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);

    const u = updates.find((x) => x.where.id === 'kd-summary');
    expect(u?.data.docType).toBe('intake_summary');
    expect(u?.data.classification).toBe('high_signal');
    expect(u?.data.needsRnReview).toBe(false);
    expect(u?.data.classifierVersion).toBe(CLASSIFIER_VERSION_NUM);
    expect(res.body.data.rnReviewCleared).toBeGreaterThanOrEqual(1);
  });

  it('the Jr_AAD_Nexus STR-misfire flips to nexus_letter_prior and REPLICATES the docTypeChanged ack-clear', async () => {
    const { db, updates } = makeDb();
    await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);

    const u = updates.find((x) => x.where.id === 'kd-nexus');
    expect(u?.data.docType).toBe('nexus_letter_prior');
    // The RN acknowledged this row when it claimed to be an STR — the ack must not stick.
    expect(u?.data.selectorAcknowledgedAt).toBeNull();
    expect(u?.data.selectorAcknowledgedBy).toBeNull();
    expect(u?.data.classifierVersion).toBe(CLASSIFIER_VERSION_NUM);
  });

  it('an already-correct row is version-stamped ONLY — docType/needsRnReview/acks untouched', async () => {
    const { db, updates } = makeDb();
    await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);

    const u = updates.find((x) => x.where.id === 'kd-ok');
    expect(u?.data.classifierVersion).toBe(CLASSIFIER_VERSION_NUM);
    expect(u?.data).not.toHaveProperty('docType');
    expect(u?.data).not.toHaveProperty('needsRnReview');
    expect(u?.data).not.toHaveProperty('selectorAcknowledgedAt');
  });

  it('feeds STORED document_pages text to the classifier — Misc_2.pdf reclassifies rating_decision by content', async () => {
    const { db, updates } = makeDb();
    await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);

    const u = updates.find((x) => x.where.id === 'kd-misc');
    expect(u?.data.docType).toBe('rating_decision');
    expect(u?.data.needsRnReview).toBe(false);
  });

  it('returns the audit counts', async () => {
    const { db, spies } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);
    expect(res.body.data).toEqual({
      classifierVersion: CLASSIFIER_VERSION_NUM,
      scanned: 4,
      reclassified: 3, // summary + nexus + misc
      stampedOnly: 1, // dd_214
      rnReviewCleared: 2, // summary + misc
      acksCleared: 1, // nexus
    });
    expect(spies.activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it('no stale rows: returns zero counts without touching anything', async () => {
    const { db, updates } = makeDb({ staleRows: [] });
    const res = await request(appFor(db)).post('/api/v1/rn/key-docs/reclassify-stale').expect(200);
    expect(res.body.data.scanned).toBe(0);
    expect(res.body.data.reclassified).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('is admin-only (ops_staff gets 403)', async () => {
    const { db } = makeDb();
    await request(appFor(db, 'ops_staff')).post('/api/v1/rn/key-docs/reclassify-stale').expect(403);
  });
});
