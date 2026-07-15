import { describe, expect, it, vi } from 'vitest';

// Mock the chart-extract trigger so the force-extract is a no-op (no SQS/DB) — we only assert THIS
// service's orchestration (the re-OCR nudge, the once-per-doc-set marker, and the outcome state).
vi.mock('../services/chart-extract-trigger.js', () => ({
  maybeEnqueueChartExtract: vi.fn(async () => ({ enqueued: true })),
}));

import { autoRemediateChartForDraft, AUTO_REMEDIATE_ACTION } from '../services/chart-auto-remediate.js';
import { maybeEnqueueChartExtract } from '../services/chart-extract-trigger.js';
import { computeTriggerHash } from '../services/chart-build-state.js';

const enqueueMock = vi.mocked(maybeEnqueueChartExtract);

// Document auto-recovery loop (2026-06-14) — STEP 4 thin fallback. The /draft route calls this when the
// chart is not ready and there is no override/rnDecision: it must auto-heal ONCE per doc-set (never loop
// on the poll) and report 'exhausted' only after a remediation already ran for the same doc-set.

interface FakeDbState {
  docs: { id: string; s3Key: string; contentType: string | null }[];
  readStatuses: { filePath: string; terminalStatus: string }[];
  latestRun: { triggerHash: string; status: string } | null;
  markers: { detailsJson?: { triggerHash?: unknown } | null }[];
  created: { action: string; detailsJson: unknown }[];
}

function makeDb(state: FakeDbState) {
  return {
    document: { findMany: async () => state.docs },
    fileReadStatus: { findMany: async () => state.readStatuses },
    chartExtractionRun: { findMany: async () => (state.latestRun ? [state.latestRun] : []) },
    activityLog: {
      findMany: async () => state.markers,
      create: async (a: { data: { action: string; detailsJson: unknown } }) => {
        state.created.push({ action: a.data.action, detailsJson: a.data.detailsJson });
        return {};
      },
    },
    case: { findFirst: async () => ({ id: 'C1', veteranId: 'V1' }) },
  };
}

// A stub S3 + maybeEnqueueChartExtract are exercised by the real modules; here we inject the bucket so
// the re-OCR loop runs against a no-op S3 (CopyObject is sent through the injected client).
function fakeS3(sent: string[]) {
  return { send: async (cmd: { input?: { Key?: string } }) => { sent.push(cmd?.input?.Key ?? '?'); return {}; } } as never;
}

describe('autoRemediateChartForDraft — bounded auto-recovery', () => {
  it('returns preparing WITHOUT re-firing when a remediation/extraction is already in flight (no poll loop)', async () => {
    // All docs OCR-terminal, latest run still queued for the current hash → build-state 'extracting'.
    const docs = [{ id: 'd1', s3Key: 'cases/C1/u-scan.pdf', contentType: 'application/pdf' }];
    const readStatuses = [{ filePath: 'cases/C1/u-scan.pdf', terminalStatus: 'manual_summary_required' }];
    const hash = computeTriggerHash(docs, readStatuses);
    const sent: string[] = [];
    const state: FakeDbState = { docs, readStatuses, latestRun: { triggerHash: hash, status: 'queued' }, markers: [], created: [] };
    const out = await autoRemediateChartForDraft(makeDb(state) as never, 'C1', 'rn-1', { s3: fakeS3(sent), bucketName: 'phi' });
    expect(out.state).toBe('preparing');
    if (out.state === 'preparing') expect(out.remediated).toBe(false);
    expect(sent).toEqual([]); // never re-fired re-OCR while in flight
    expect(state.created).toEqual([]); // no marker written
  });

  it('on a settled-but-blocked chart: forces a fresh extract, writes a triggerHash-keyed marker, returns preparing (remediated)', async () => {
    // Chart SETTLED (the one doc is OCR-terminal as manual_summary_required) + latest run COMPLETE for
    // the current hash → not extracting, but blocked. No prior remediation → remediate once. The re-OCR
    // loop nudges nothing (the doc is OCR-terminal, same as POST /cases/:id/reprocess), so the value is
    // the FORCE-EXTRACT (re-run extraction) + the marker; reocrQueued is 0.
    const docs = [{ id: 'd1', s3Key: 'cases/C1/u-scan.pdf', contentType: 'application/pdf' }];
    const readStatuses = [{ filePath: 'cases/C1/u-scan.pdf', terminalStatus: 'manual_summary_required' }];
    const hash = computeTriggerHash(docs, readStatuses);
    const sent: string[] = [];
    const state: FakeDbState = { docs, readStatuses, latestRun: { triggerHash: hash, status: 'complete' }, markers: [], created: [] };
    const out = await autoRemediateChartForDraft(makeDb(state) as never, 'C1', 'rn-1', { s3: fakeS3(sent), bucketName: 'phi' });
    expect(out.state).toBe('preparing');
    if (out.state === 'preparing') {
      expect(out.remediated).toBe(true);
      expect(out.reocrQueued).toBe(0); // OCR-terminal doc not re-OCR'd; the force-extract is the action
    }
    expect(sent).toEqual([]); // nothing to re-OCR on a fully-OCR-terminal chart
    // A triggerHash-keyed marker was written so a retried/polled draft won't re-fire.
    const marker = state.created.find((c) => c.action === AUTO_REMEDIATE_ACTION);
    expect(marker).toBeDefined();
    expect((marker?.detailsJson as { triggerHash?: string }).triggerHash).toBe(hash);
  });

  it('returns exhausted when a remediation already ran for THIS exact doc-set (no infinite re-fire)', async () => {
    const docs = [{ id: 'd1', s3Key: 'cases/C1/u-scan.pdf', contentType: 'application/pdf' }];
    const readStatuses = [{ filePath: 'cases/C1/u-scan.pdf', terminalStatus: 'manual_summary_required' }];
    const hash = computeTriggerHash(docs, readStatuses);
    const sent: string[] = [];
    // A prior marker carries the SAME triggerHash → auto-recovery already tried this doc-set.
    const state: FakeDbState = {
      docs, readStatuses, latestRun: { triggerHash: hash, status: 'complete' },
      markers: [{ detailsJson: { triggerHash: hash } }], created: [],
    };
    const out = await autoRemediateChartForDraft(makeDb(state) as never, 'C1', 'rn-1', { s3: fakeS3(sent), bucketName: 'phi' });
    expect(out.state).toBe('exhausted');
    expect(sent).toEqual([]); // did NOT re-fire
    expect(state.created).toEqual([]); // no new marker
  });

  it('a NEW upload (different doc-set hash) is NOT mistaken for the exhausted set — remediates again', async () => {
    const docs = [{ id: 'd1', s3Key: 'cases/C1/u-new.pdf', contentType: 'application/pdf' }];
    const readStatuses = [{ filePath: 'cases/C1/u-new.pdf', terminalStatus: 'manual_summary_required' }];
    const sent: string[] = [];
    // The prior marker is for a DIFFERENT (stale) hash → must not block remediating the new doc-set.
    const state: FakeDbState = {
      docs, readStatuses, latestRun: { triggerHash: computeTriggerHash(docs, readStatuses), status: 'complete' },
      markers: [{ detailsJson: { triggerHash: 'stale-prior-hash-deadbeef' } }], created: [],
    };
    const out = await autoRemediateChartForDraft(makeDb(state) as never, 'C1', 'rn-1', { s3: fakeS3(sent), bucketName: 'phi' });
    expect(out.state).toBe('preparing'); // remediates again — the new doc-set is fresh work, not exhausted
    if (out.state === 'preparing') expect(out.remediated).toBe(true);
    // A NEW marker is written keyed on the NEW doc-set's hash.
    const newHash = computeTriggerHash(docs, readStatuses);
    const marker = state.created.find((c) => c.action === AUTO_REMEDIATE_ACTION);
    expect((marker?.detailsJson as { triggerHash?: string }).triggerHash).toBe(newHash);
  });
});

// ── FIX 4 (2026-06-14): DETERMINISTIC remediation salt ───────────────────────────────────────────
// The force-extract salt was a fresh randomUUID per call, which DEFEATED the (caseId, triggerHash)
// INSERT-as-mutex: two near-simultaneous draft POSTs that BOTH pass the in-flight + no-marker guards
// each minted a different random salt → two distinct triggerHashes → two ChartExtractionRun rows →
// double LLM spend. The salt is now derived from the current doc-set triggerHash, so two remediations
// for the SAME unchanged doc-set collapse to one enqueue (dedup holds); a changed doc-set still differs.
describe('autoRemediateChartForDraft — deterministic salt (FIX 4)', () => {
  function settledBlockedState(docs: { id: string; s3Key: string; contentType: string | null }[]): FakeDbState {
    const readStatuses = docs.map((d) => ({ filePath: d.s3Key, terminalStatus: 'manual_summary_required' }));
    // A COMPLETE run for the current hash → build-state is settled-but-blocked, so the remediation
    // reaches step 3 (fire the reprocess) where the salt is computed. No prior marker → not exhausted.
    return { docs, readStatuses, latestRun: { triggerHash: computeTriggerHash(docs, readStatuses), status: 'complete' }, markers: [], created: [] };
  }

  it('two remediations for the SAME unchanged doc-set produce the SAME forceSalt (dedup holds)', async () => {
    const docs = [
      { id: 'd1', s3Key: 'cases/C1/a-records.pdf', contentType: 'application/pdf' },
      { id: 'd2', s3Key: 'cases/C1/b-buddy.pdf', contentType: 'application/pdf' },
    ];
    enqueueMock.mockClear();

    // First remediation (no prior marker → fires; computes a salt).
    const r1 = await autoRemediateChartForDraft(makeDb(settledBlockedState(docs)) as never, 'C1', 'actor-1', { s3: fakeS3([]), bucketName: 'phi' });
    expect(r1.state).toBe('preparing');
    const salt1 = enqueueMock.mock.calls[0]?.[2]?.forceSalt;

    enqueueMock.mockClear();

    // SECOND near-simultaneous remediation in the SAME race window (marker not yet visible) for the
    // SAME doc-set → MUST derive the SAME salt so the second enqueue P2002-dedups instead of spending.
    const r2 = await autoRemediateChartForDraft(makeDb(settledBlockedState(docs)) as never, 'C1', 'actor-2', { s3: fakeS3([]), bucketName: 'phi' });
    expect(r2.state).toBe('preparing');
    const salt2 = enqueueMock.mock.calls[0]?.[2]?.forceSalt;

    expect(salt1).toBeTruthy();
    expect(salt2).toBe(salt1);
  });

  it('a CHANGED doc-set produces a DIFFERENT forceSalt (a new upload re-arms remediation)', async () => {
    const docsA = [{ id: 'd1', s3Key: 'cases/C1/a-records.pdf', contentType: 'application/pdf' }];
    const docsB = [
      { id: 'd1', s3Key: 'cases/C1/a-records.pdf', contentType: 'application/pdf' },
      { id: 'd9', s3Key: 'cases/C1/c-new-upload.pdf', contentType: 'application/pdf' },
    ];
    enqueueMock.mockClear();

    await autoRemediateChartForDraft(makeDb(settledBlockedState(docsA)) as never, 'C1', 'actor-1', { s3: fakeS3([]), bucketName: 'phi' });
    const saltA = enqueueMock.mock.calls[0]?.[2]?.forceSalt;
    enqueueMock.mockClear();

    await autoRemediateChartForDraft(makeDb(settledBlockedState(docsB)) as never, 'C1', 'actor-1', { s3: fakeS3([]), bucketName: 'phi' });
    const saltB = enqueueMock.mock.calls[0]?.[2]?.forceSalt;

    expect(saltA).toBeTruthy();
    expect(saltB).toBeTruthy();
    expect(saltB).not.toBe(saltA);
  });
});
