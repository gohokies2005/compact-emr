import { describe, expect, it } from 'vitest';
import { buildDrafterBundle } from '../services/drafter-bundle.js';

// MANUAL / EXISTING-VETERAN CASE, 0 UPLOADED FILES (Hackworth cervical, Ryan 2026-06-30).
// A New-Claim case for an existing veteran can carry its records as on-file chart data (SC conditions,
// active problems, medications, prior-case OCR'd documents) with ZERO files uploaded to THIS case. The
// drafter bundle's extractionState keys on THIS case's uploaded-document count, so it used to derive
// 'no_documents' and the Fargate drafter refused ("chart extraction is not ready") even though the SOAP
// note renders a full grounded chart. The bundle is veteran-scoped for content, so the drafter CAN
// ground the letter — the gate was wrong. Fix: when there are 0 this-case input docs BUT real draftable
// chart content exists, extractionState is 'chart_ready'. A genuinely empty case stays 'no_documents'.

/**
 * A veteran with prior-case documents (so the veteran-wide document/read-status query returns rows) but
 * whose THIS case (CASE-NEW) has NO uploaded files of its own. `content` seeds the veteran-level chart
 * tables (SC conditions / active problems / meds / notes) — the draftable-content signal under test.
 */
function makeDb(content: {
  scConditions?: unknown[];
  activeProblems?: unknown[];
  activeMedications?: unknown[];
  chartNotes?: unknown[];
}) {
  const list = (rows?: unknown[]) => ({ findMany: async () => rows ?? [] });
  return {
    case: {
      findFirst: async () => ({ id: 'CASE-NEW', veteranId: 'VET-1', claimedCondition: 'Cervical strain', claimedConditions: [], claimType: 'initial', status: 'records', currentVersion: 0 }),
      // The veteran has a PRIOR case (CASE-OLD) whose documents were parsed; CASE-NEW is the manual one.
      findMany: async () => [{ id: 'CASE-OLD' }, { id: 'CASE-NEW' }],
    },
    veteran: { findUnique: async () => ({ id: 'VET-1', firstName: 'Hack', lastName: 'Worth' }) },
    scCondition: list(content.scConditions),
    activeProblem: list(content.activeProblems),
    activeMedication: list(content.activeMedications),
    chartNote: list(content.chartNotes),
    keyDoc: { findMany: async () => [] },
    // The veteran's prior-case files are read+terminal, but they belong to CASE-OLD, not CASE-NEW.
    fileReadStatus: {
      findMany: async () => [
        { id: 'frs-1', caseId: 'CASE-OLD', filePath: 'prior-records.pdf', fileSha256: 'a', terminalStatus: 'read', attemptsJson: [], manualSummary: null },
      ],
    },
    // Prior-case document with OCR'd pages — carried veteran-wide into the bundle; NOT a CASE-NEW file.
    document: {
      findMany: async () => [{ id: 'doc-old', caseId: 'CASE-OLD', s3Key: 'prior-records.pdf', filename: 'prior-records.pdf', pages: [{ pageNumber: 1, text: 'C4-C5 DDD, Modic type I' }] }],
    },
    doctorPack: { findFirst: async () => null },
    draftJob: { findFirst: async () => null },
    chartExtractionRun: { findMany: async () => [] },
  };
}

describe('buildDrafterBundle — manual case with 0 this-case docs but on-file chart content', () => {
  it('SC conditions present + 0 this-case docs → chart_ready (drafter must not refuse)', async () => {
    const db = makeDb({ scConditions: [{ condition: 'Cervical degenerative disc disease', status: 'service_connected', ratingPct: 20 }] });
    const bundle = await buildDrafterBundle(db as never, 'CASE-NEW');
    expect(bundle.chartReadiness.extractionState).toBe('chart_ready');
  });

  it('active problems present + 0 this-case docs → chart_ready', async () => {
    const db = makeDb({ activeProblems: [{ problem: 'C5 radiculopathy' }] });
    const bundle = await buildDrafterBundle(db as never, 'CASE-NEW');
    expect(bundle.chartReadiness.extractionState).toBe('chart_ready');
  });

  it('only medications present + 0 this-case docs → chart_ready', async () => {
    const db = makeDb({ activeMedications: [{ name: 'Gabapentin' }] });
    const bundle = await buildDrafterBundle(db as never, 'CASE-NEW');
    expect(bundle.chartReadiness.extractionState).toBe('chart_ready');
  });

  it('CONTROL: genuinely empty case (0 this-case docs AND 0 chart content) stays no_documents (drafter must not run on nothing)', async () => {
    const db = makeDb({});
    const bundle = await buildDrafterBundle(db as never, 'CASE-NEW');
    expect(bundle.chartReadiness.extractionState).toBe('no_documents');
  });
});

// ⭐ NEWEST-RUN POISON REGRESSION LOCK (Sheats CLM-4772FEF2A4 + Kimbrough CLM-41E9900FB8, 2026-07-15).
// The bundle used to fetch ONLY the newest chartExtractionRun and wrap it in a one-element array —
// starving deriveChartBuildState's sticky-completion precedence. When the newest row was a
// watcher-failed duplicate of already-completed work, the Fargate drafter halted "chart extraction is
// not ready (state: extract_failed)" on a COMPLETE chart. This locks the flood shape at the BUNDLE
// level: the completed run must win over newer failed duplicates, and the drafter gate must open.
describe('buildDrafterBundle — watcher-failed duplicate runs must not un-ready a complete chart', () => {
  function makeFloodDb(runs: Array<{ triggerHash: string; status: string; resultJson?: unknown }>) {
    const list = (rows?: unknown[]) => ({ findMany: async () => rows ?? [] });
    return {
      case: {
        findFirst: async () => ({ id: 'CASE-F', veteranId: 'VET-1', claimedCondition: 'Migraine', claimedConditions: [], claimType: 'appeal_bva', status: 'records', currentVersion: 0 }),
        findMany: async () => [{ id: 'CASE-F' }],
      },
      veteran: { findUnique: async () => ({ id: 'VET-1', firstName: 'Chelsea', lastName: 'Flood' }) },
      scCondition: list([{ condition: 'PTSD', status: 'service_connected', ratingPct: 70 }]),
      activeProblem: list([{ problem: 'Chronic migraine' }]),
      activeMedication: list(),
      chartNote: list(),
      keyDoc: { findMany: async () => [] },
      fileReadStatus: {
        findMany: async () => [
          { id: 'frs-f1', caseId: 'CASE-F', filePath: 'cases/CASE-F/records.pdf', fileSha256: 'a', terminalStatus: 'read', attemptsJson: [], manualSummary: null },
        ],
      },
      document: {
        findMany: async () => [{ id: 'doc-f1', caseId: 'CASE-F', s3Key: 'cases/CASE-F/records.pdf', filename: 'records.pdf', pages: [{ pageNumber: 1, text: 'migraine hx' }] }],
      },
      doctorPack: { findFirst: async () => null },
      draftJob: { findFirst: async () => null },
      // newest-first, exactly as the real query returns them
      chartExtractionRun: { findMany: async () => runs },
    };
  }

  it('FLOOD SHAPE: [watcher-failed newest ×3, complete older] same doc set → chart_ready (drafter gate opens)', async () => {
    const { computeTriggerHash } = await import('../services/chart-build-state.js');
    const h = computeTriggerHash(
      [{ id: 'doc-f1', s3Key: 'cases/CASE-F/records.pdf' }],
      [{ filePath: 'cases/CASE-F/records.pdf', terminalStatus: 'read' }],
    );
    const db = makeFloodDb([
      { triggerHash: `${h}:manual:dup3`, status: 'failed' },
      { triggerHash: `${h}:manual:dup2`, status: 'failed' },
      { triggerHash: h, status: 'failed' },
      { triggerHash: h, status: 'complete', resultJson: { items: 150 } },
    ]);
    const bundle = await buildDrafterBundle(db as never, 'CASE-F');
    expect(bundle.chartReadiness.extractionState).toBe('chart_ready');
  });

  it('HONEST: only failed runs for the current doc set (no completed run) → extract_failed still halts', async () => {
    const { computeTriggerHash } = await import('../services/chart-build-state.js');
    const h = computeTriggerHash(
      [{ id: 'doc-f1', s3Key: 'cases/CASE-F/records.pdf' }],
      [{ filePath: 'cases/CASE-F/records.pdf', terminalStatus: 'read' }],
    );
    const db = makeFloodDb([{ triggerHash: h, status: 'failed' }]);
    const bundle = await buildDrafterBundle(db as never, 'CASE-F');
    expect(bundle.chartReadiness.extractionState).toBe('extract_failed');
  });

  it('gapped-complete run: extractionGaps read from the STICKY WINNER, not the newest failed row', async () => {
    const { computeTriggerHash } = await import('../services/chart-build-state.js');
    const h = computeTriggerHash(
      [{ id: 'doc-f1', s3Key: 'cases/CASE-F/records.pdf' }],
      [{ filePath: 'cases/CASE-F/records.pdf', terminalStatus: 'read' }],
    );
    const db = makeFloodDb([
      { triggerHash: `${h}:manual:dup1`, status: 'failed' },
      { triggerHash: h, status: 'complete_with_gaps', resultJson: { gaps: { truncatedWindows: 1, uncoveredPages: 3 } } },
    ]);
    const bundle = await buildDrafterBundle(db as never, 'CASE-F');
    expect(bundle.chartReadiness.extractionState).toBe('chart_ready');
    expect(bundle.chartReadiness.extractionGaps).toEqual({ truncatedWindows: 1, uncoveredPages: 3 });
  });
});
