import { describe, expect, it } from 'vitest';
import { buildDrafterBundle } from '../services/drafter-bundle.js';

// Returning-customer document reuse (Ryan 2026-06-04): the drafter bundle must include EVERY one of
// the veteran's already-parsed documents across all their cases — but the chart-readiness gate must
// still be computed from THIS case's own files only, so a prior case's unresolved file never blocks
// a new case's draft.

function makeDb(opts: {
  captureDocWhere: (w: unknown) => void;
  captureFrsWhere: (w: unknown) => void;
  // P2-3 (2026-06-14): optional latest ChartExtractionRun so the gap-count tests can drive a
  // complete_with_gaps run. Default null = no run yet (matches the prior single-arg callers).
  extractionRun?: { triggerHash: string; status: string; resultJson: unknown } | null;
}) {
  const empty = { findMany: async () => [] as unknown[] };
  return {
    case: {
      findFirst: async () => ({ id: 'CASE-MIGRAINE', veteranId: 'VET-1', claimedCondition: 'Migraine', claimedConditions: [], claimType: 'initial', status: 'records', currentVersion: 0 }),
      findMany: async () => [{ id: 'CASE-OSA' }, { id: 'CASE-MIGRAINE' }],
    },
    veteran: { findUnique: async () => ({ id: 'VET-1', firstName: 'Armand', lastName: 'Frank' }) },
    scCondition: empty,
    activeProblem: empty,
    activeMedication: empty,
    chartNote: empty,
    keyDoc: empty,
    fileReadStatus: {
      findMany: async (args: { where: unknown }) => {
        opts.captureFrsWhere(args.where);
        // VET-1 has TWO files: a RESOLVED one on the OSA case and an UNRESOLVED one — also on OSA
        // (a different case than the one we're drafting). Neither belongs to CASE-MIGRAINE.
        return [
          { id: 'frs-1', caseId: 'CASE-OSA', filePath: 'bluebutton.pdf', fileSha256: 'a', terminalStatus: 'read', attemptsJson: [], manualSummary: null },
          { id: 'frs-2', caseId: 'CASE-OSA', filePath: 'scan.pdf', fileSha256: 'b', terminalStatus: 'manual_summary_required', attemptsJson: [], manualSummary: null },
        ];
      },
    },
    document: {
      findMany: async (args: { where: unknown }) => {
        opts.captureDocWhere(args.where);
        return [{ id: 'doc-1', caseId: 'CASE-OSA', filename: 'bluebutton.pdf', pages: [] }];
      },
    },
    doctorPack: { findFirst: async () => null },
    draftJob: { findFirst: async () => null },
    // extractionState derivation (Ryan 2026-06-13): latest run for this case; null = no run yet.
    chartExtractionRun: { findFirst: async () => opts.extractionRun ?? null },
  };
}

describe('buildDrafterBundle — veteran-scoped documents', () => {
  it('queries documents + file-read-status across ALL the veteran\'s cases', async () => {
    let docWhere: unknown; let frsWhere: unknown;
    const db = makeDb({ captureDocWhere: (w) => { docWhere = w; }, captureFrsWhere: (w) => { frsWhere = w; } });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');

    expect(docWhere).toEqual({ caseId: { in: ['CASE-OSA', 'CASE-MIGRAINE'] } });
    expect(frsWhere).toEqual({ caseId: { in: ['CASE-OSA', 'CASE-MIGRAINE'] } });
    // The OSA blue button is now available to the migraine case's drafter.
    expect(bundle.documents).toHaveLength(1);
  });

  it('computes chart-readiness from THIS case only — a prior case\'s unresolved file does NOT block', async () => {
    const db = makeDb({ captureDocWhere: () => {}, captureFrsWhere: () => {} });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');
    // CASE-MIGRAINE has zero files of its own → empty set → ready, despite CASE-OSA's blocked file.
    expect(bundle.chartReadiness.ready).toBe(true);
  });
});

// P2-3 (doc-set closure + sweep hardening, 2026-06-14): when the latest extraction is
// complete_with_gaps the RN sees a banner (chart-readiness route) but the drafter previously got NO
// signal. The bundle now carries the worker-recorded gap counts so the drafter can note a gapped
// chart in the letter provenance. Mirrors chart-readiness.ts:175-178 read shape exactly.
describe('buildDrafterBundle — extraction gap counts', () => {
  it('carries truncatedWindows/uncoveredPages when the latest run is complete_with_gaps', async () => {
    const db = makeDb({
      captureDocWhere: () => {}, captureFrsWhere: () => {},
      extractionRun: { triggerHash: 'h1', status: 'complete_with_gaps', resultJson: { gaps: { truncatedWindows: 2, uncoveredPages: 5 } } },
    });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');
    expect(bundle.chartReadiness.extractionGaps).toEqual({ truncatedWindows: 2, uncoveredPages: 5 });
  });

  it('coerces missing gap fields to 0 (a complete_with_gaps run whose gaps block is partial)', async () => {
    const db = makeDb({
      captureDocWhere: () => {}, captureFrsWhere: () => {},
      extractionRun: { triggerHash: 'h1', status: 'complete_with_gaps', resultJson: { gaps: { uncoveredPages: 3 } } },
    });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');
    expect(bundle.chartReadiness.extractionGaps).toEqual({ truncatedWindows: 0, uncoveredPages: 3 });
  });

  it('extractionGaps is null for a clean complete run (no gaps to report)', async () => {
    const db = makeDb({
      captureDocWhere: () => {}, captureFrsWhere: () => {},
      extractionRun: { triggerHash: 'h1', status: 'complete', resultJson: { gaps: { truncatedWindows: 9, uncoveredPages: 9 } } },
    });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');
    // status !== complete_with_gaps → null even though a stale gaps block is present.
    expect(bundle.chartReadiness.extractionGaps).toBeNull();
  });

  it('extractionGaps is null when there is no extraction run yet', async () => {
    const db = makeDb({ captureDocWhere: () => {}, captureFrsWhere: () => {} });
    const bundle = await buildDrafterBundle(db as never, 'CASE-MIGRAINE');
    expect(bundle.chartReadiness.extractionGaps).toBeNull();
  });
});
