// SOAP-context assembler (Ryan 2026-06-22, Zimmelman FIX A + FIX C). Two contracts:
//
//   FIX A — WRITE==READ: the OFF-REQUEST async precompute and the SYNCHRONOUS open both build the
//   SoapContext from THIS assembler, so they fingerprint IDENTICALLY and the precomputed note is served
//   for $0 (instead of a permanent fallback). Proven by assembling twice over the SAME db state (the
//   async-write call vs the sync-read call) and asserting soapNoteFingerprint is identical — for BOTH a
//   grounded (framing present) and an ungrounded (framing=null) case.
//
//   FIX C — COVERAGE PARITY: deriveCoverageNote now goes through loadExtractionCoverageForCase (the SAME
//   loader GET /extraction-coverage uses), so a fully-read chart yields "All records were reviewed." and
//   100% — not the old false "0% of pages read" the empty-read-statuses call produced.
//
// PURE / DB-injectable: an in-memory delegate stub, no SDK, no AWS, no real DB. The assembler's downstream
// helpers (buildDigestForCase, loadReconciledChartReadiness) read this same stub and run deterministically.
import { describe, it, expect } from 'vitest';
import { assembleSoapContextForCase, type RoutePickerFramingInput } from '../soap-context-assembler.js';
import { soapNoteFingerprint } from '../soap-overview.js';
import type { AppDb } from '../db-types.js';

const CASE_ID = 'CLM-TEST-0001';

interface SeedDoc { id: string; s3Key: string; filename: string; contentType: string | null; pageCount: number | null; uploadedAt?: Date; docTag?: string | null }
interface SeedFrs { filePath: string; terminalStatus: string }

/** Build a minimal in-memory AppDb covering every read the assembler + its helpers make. Deterministic. */
function buildDb(opts: {
  caseRow: Record<string, unknown> | null;
  docs?: readonly SeedDoc[];
  frs?: readonly SeedFrs[];
  pages?: ReadonlyArray<{ documentId: string; pageNumber: number; extractionCoverage: string | null; handwritingPresent: boolean | null; text?: string | null }>;
  latestRun?: { status: string; resultJson: unknown } | null;
}): AppDb {
  const docs = opts.docs ?? [];
  const frs = (opts.frs ?? []).map((r, i) => ({
    id: `FRS-${i}`, caseId: CASE_ID, filePath: r.filePath, terminalStatus: r.terminalStatus,
    fileSha256: 'a'.repeat(64), manualSummary: null, manualSummaryAt: null, manualSummaryBy: null,
    lastCheckedAt: new Date('2026-06-22T00:00:00Z'), createdAt: new Date('2026-06-22T00:00:00Z'),
    updatedAt: new Date('2026-06-22T00:00:00Z'), version: 1, attemptsJson: [],
  }));
  const pages = opts.pages ?? [];
  const stub = {
    case: { findFirst: async () => opts.caseRow },
    document: { findMany: async (_a: unknown) => docs },
    fileReadStatus: { findMany: async (_a: unknown) => frs },
    documentPage: { findMany: async (_a: unknown) => pages },
    chartExtractionRun: { findFirst: async (_a: unknown) => opts.latestRun ?? null },
    chartNote: { findMany: async () => [] },
    caseMessage: { findMany: async () => [] },
  };
  return stub as unknown as AppDb;
}

const CASE_ROW = {
  claimedCondition: 'Obstructive sleep apnea',
  veteranStatement: 'I have snored since service and was diagnosed with sleep apnea.',
  veteran: {
    weightLb: 240,
    scConditions: [{ condition: 'Allergic rhinitis', status: 'service_connected' }, { condition: 'Old denial', status: 'denied' }],
    activeProblems: [{ problem: 'Hypertension' }],
    activeMedications: [{ drugName: 'CPAP', indication: 'OSA' }],
  },
};

const FRAMING: RoutePickerFramingInput = {
  framing: 'OSA secondary to service-connected allergic rhinitis',
  cfr_basis: '38 CFR 3.310(a)',
  mechanism: 'Chronic nasal obstruction raises upper-airway resistance, worsening apnea.',
  rationale: 'Recognized secondary pathway.',
  counterargument: 'Obesity is an independent risk factor.',
  confidence: 'moderate',
  viability: 'supportable',
  planHash: 'plan-hash-abc123',
};

describe('FIX A — write==read fingerprint parity (assembler is the single source for both paths)', () => {
  it('GROUNDED (framing present): async-write ctx and sync-read ctx fingerprint identically', async () => {
    const db = buildDb({ caseRow: CASE_ROW });
    const asyncWriteCtx = await assembleSoapContextForCase(db, CASE_ID, FRAMING); // off-request precompute
    const syncReadCtx = await assembleSoapContextForCase(db, CASE_ID, FRAMING);   // synchronous open
    expect(soapNoteFingerprint(syncReadCtx)).toBe(soapNoteFingerprint(asyncWriteCtx));
  });

  it('UNGROUNDED (framing=null): async-write ctx and sync-read ctx fingerprint identically', async () => {
    const db = buildDb({ caseRow: CASE_ROW });
    const asyncWriteCtx = await assembleSoapContextForCase(db, CASE_ID, null);
    const syncReadCtx = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(soapNoteFingerprint(syncReadCtx)).toBe(soapNoteFingerprint(asyncWriteCtx));
  });

  it('grounded vs ungrounded produce DIFFERENT fingerprints (the plan identity moves the hash)', async () => {
    const db = buildDb({ caseRow: CASE_ROW });
    const grounded = await assembleSoapContextForCase(db, CASE_ID, FRAMING);
    const ungrounded = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(soapNoteFingerprint(grounded)).not.toBe(soapNoteFingerprint(ungrounded));
  });

  it('only GRANTED SC conditions surface as anchors (denied dropped) — deterministic ctx content', async () => {
    const db = buildDb({ caseRow: CASE_ROW });
    const ctx = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(ctx.scConditions).toEqual(['Allergic rhinitis']);
    expect(ctx.claimedCondition).toBe('Obstructive sleep apnea');
  });
});

describe('FIX C — coverage parity: a fully-read chart → "All records were reviewed."', () => {
  it('all docs effectively read → coverageNote is the all-reviewed string (not "0% of pages read")', async () => {
    const docs: SeedDoc[] = [
      { id: 'D1', s3Key: `cases/${CASE_ID}/u1-dd214.pdf`, filename: 'dd214.pdf', contentType: 'application/pdf', pageCount: 4, uploadedAt: new Date('2026-06-20T00:00:00Z'), docTag: null },
      { id: 'D2', s3Key: `cases/${CASE_ID}/u2-sleep-study.pdf`, filename: 'sleep-study.pdf', contentType: 'application/pdf', pageCount: 6, uploadedAt: new Date('2026-06-20T00:00:00Z'), docTag: null },
    ];
    const frs: SeedFrs[] = [
      { filePath: `cases/${CASE_ID}/u1-dd214.pdf`, terminalStatus: 'read' },
      { filePath: `cases/${CASE_ID}/u2-sleep-study.pdf`, terminalStatus: 'read' },
    ];
    const db = buildDb({ caseRow: CASE_ROW, docs, frs, latestRun: { status: 'complete', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 0 } } } });
    const ctx = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(ctx.coverageNote).toBe('All records were reviewed.');
  });

  it('REGRESSION GUARD: the same fully-read chart does NOT report "0% of pages read"', async () => {
    const docs: SeedDoc[] = [{ id: 'D1', s3Key: `cases/${CASE_ID}/u1-records.pdf`, filename: 'records.pdf', contentType: 'application/pdf', pageCount: 12, uploadedAt: new Date('2026-06-20T00:00:00Z'), docTag: null }];
    const frs: SeedFrs[] = [{ filePath: `cases/${CASE_ID}/u1-records.pdf`, terminalStatus: 'read' }];
    const db = buildDb({ caseRow: CASE_ROW, docs, frs, latestRun: { status: 'complete', resultJson: {} } });
    const ctx = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(ctx.coverageNote).not.toMatch(/0% of pages read/);
    expect(ctx.coverageNote).toBe('All records were reviewed.');
  });

  it('no chart inputs at all → coverageNote is null (nothing to report)', async () => {
    const db = buildDb({ caseRow: CASE_ROW, docs: [], frs: [] });
    const ctx = await assembleSoapContextForCase(db, CASE_ID, null);
    expect(ctx.coverageNote).toBeNull();
  });
});
