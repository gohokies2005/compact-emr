import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { CLASSIFIER_VERSION_NUM } from '../services/key-docs-classifier.js';

// Assessment 2026-06-12 §2 — generate-path pins (separate file from doctor-pack-generate.test.ts
// so this work stream doesn't collide with the budget/selector stream's tests):
//   1. classifierVersion is stamped on every KeyDoc upsert (create AND update payloads) — the
//      stale-row backfill is only possible if fresh rows carry the stamp.
//   2. NEVER-CLASSIFY-OWN-ARTIFACTS: the system-generated Intake_Summary.pdf classifies
//      intake_summary via its reserved key (system_artifact guard) even when its Q&A text
//      echoes denial-letter phrasing, and NEVER lands in the RN queue (needsRnReview=false).
//   3. A prior nexus letter (Jr_AAD_Nexus.pdf) classifies nexus_letter_prior, not STR.

vi.mock('../services/chart-summary-aggregator.js', () => ({
  aggregateChartSummary: vi.fn(async () => null),
}));

vi.mock('../services/doctor-pack-queue.js', () => ({
  publishDoctorPackQueued: vi.fn(async () => ({ skipped: true })),
}));

// The trap text: the generated intake summary's Q&A echoes decision-letter phrasing. Without
// the system-artifact guard this content-classifies denial_letter and queues an RN to review
// our own output.
const INTAKE_SUMMARY_ECHO_PAGE =
  'Flat Rate Nexus Intake. Q: Have you previously been denied? A: Yes — the letter said entitlement to service connection for anxiety is denied.';

function makeGenDb() {
  const upserts: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  const tx = {
    keyDoc: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        upserts.push(args);
        return { id: `kd-${upserts.length}`, ...args.create };
      }),
    },
    doctorPack: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...args.data, createdAt: new Date(), updatedAt: new Date(), version: 1,
      })),
    },
    activityLog: { create: vi.fn(async () => ({})) },
  };
  const db = {
    case: {
      findFirst: vi.fn(async () => ({
        id: 'CASE-1',
        veteranId: 'VET-1',
        version: 2,
        claimedCondition: 'anxiety',
        claimType: 'initial',
        framingChoice: null,
        upstreamScCondition: null,
        status: 'rn_review',
        cdsVerdict: 'not_yet_run',
        cdsOddsPct: null,
        cdsRationale: null,
        veteranStatement: null,
        inServiceEvent: null,
        documents: [
          // Our OWN generated artifact (reserved key suffix) whose text looks like a denial.
          { id: 'doc-summary', s3Key: 'cases/CASE-1/aaaa1111-Intake_Summary.pdf', pageCount: 2, docTag: null },
          // A real-world prior nexus letter name (the assessment's STR misfire).
          { id: 'doc-nexus', s3Key: 'cases/CASE-1/bbbb2222-Jr_AAD_Nexus.pdf', pageCount: 2, docTag: null },
        ],
      })),
    },
    doctorPack: { findFirst: vi.fn(async () => null) },
    fileReadStatus: { findMany: vi.fn(async () => []) },
    keyDoc: { findMany: vi.fn(async () => []) },
    documentPage: {
      findMany: vi.fn(async () => [
        { documentId: 'doc-summary', pageNumber: 1, text: INTAKE_SUMMARY_ECHO_PAGE, confidence: 0.99 },
      ]),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as never, upserts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('doctor-pack generate — classifierVersion stamp + own-artifact guard (assessment §2)', () => {
  it('stamps classifierVersion on BOTH the create and update upsert payloads', async () => {
    const { db, upserts } = makeGenDb();
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'rn-1' });

    expect(upserts.length).toBe(2);
    for (const u of upserts) {
      expect(u.create.classifierVersion).toBe(CLASSIFIER_VERSION_NUM);
      expect(u.update.classifierVersion).toBe(CLASSIFIER_VERSION_NUM);
    }
  });

  it('the generated Intake_Summary.pdf classifies intake_summary (not denial_letter from its echo text) and NEVER needs RN review', async () => {
    const { db, upserts } = makeGenDb();
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'rn-1' });

    const summary = upserts.find((u) => String(u.create.filePath).endsWith('Intake_Summary.pdf'));
    expect(summary).toBeDefined();
    expect(summary?.create.docType).toBe('intake_summary');
    // The whole point of the guard: a system asking a human to review its own output is waste.
    expect(summary?.create.needsRnReview).toBe(false);
  });

  it('Jr_AAD_Nexus.pdf classifies nexus_letter_prior end-to-end (not service_treatment_record_summary)', async () => {
    const { db, upserts } = makeGenDb();
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'rn-1' });

    const nexus = upserts.find((u) => String(u.create.filePath).endsWith('Jr_AAD_Nexus.pdf'));
    expect(nexus).toBeDefined();
    expect(nexus?.create.docType).toBe('nexus_letter_prior');
    expect(nexus?.create.classification).toBe('high_signal');
    expect(nexus?.create.needsRnReview).toBe(false);
  });
});
