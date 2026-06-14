import { describe, it, expect } from 'vitest';
import { computeTriggerHash, deriveChartBuildState, runMatchesHash, EXTRACTED_SOURCE } from '../chart-build-state.js';

const docs = [{ id: 'd1', s3Key: 'cases/c/k1' }, { id: 'd2', s3Key: 'cases/c/k2' }];
const bothRead = [
  { filePath: 'cases/c/k1', terminalStatus: 'read' },
  { filePath: 'cases/c/k2', terminalStatus: 'read' },
];

describe('EXTRACTED_SOURCE', () => {
  it('is the single non-manual provenance value', () => expect(EXTRACTED_SOURCE).toBe('extracted'));
});

// The auto-generated screening-summary file (Ryan 2026-06-13) is an extraction OUTPUT, not an input.
// It has no OCR read-status and must be IGNORED by build-state + trigger-hash, or it would stall
// chart_ready and churn the hash (re-trigger loop).
describe('screening-summary file is excluded from build-state', () => {
  const summaryDoc = { id: 'd-screen', s3Key: 'cases/c/00000000-screening-summary.txt' };

  it('does NOT change the trigger hash', () => {
    expect(computeTriggerHash([...docs, summaryDoc], bothRead)).toBe(computeTriggerHash(docs, bothRead));
  });

  it('does NOT stall chart_ready (no read-status on the summary doc)', () => {
    const hash = computeTriggerHash(docs, bothRead);
    const run = { triggerHash: hash, status: 'complete' };
    expect(deriveChartBuildState(docs, bothRead, [run]).state).toBe('chart_ready');
    expect(deriveChartBuildState([...docs, summaryDoc], bothRead, [run]).state).toBe('chart_ready');
  });

  it('a case with ONLY a summary doc reads as no_documents (it is not a real input)', () => {
    expect(deriveChartBuildState([summaryDoc], [], []).state).toBe('no_documents');
  });
});

describe('computeTriggerHash', () => {
  it('is stable for the same doc set + read outcomes (order-independent)', () => {
    const a = computeTriggerHash(docs, bothRead);
    const b = computeTriggerHash([docs[1]!, docs[0]!], [bothRead[1]!, bothRead[0]!]);
    expect(a).toBe(b);
  });
  it('changes when a new document is added', () => {
    const a = computeTriggerHash(docs, bothRead);
    const c = computeTriggerHash([...docs, { id: 'd3', s3Key: 'cases/c/k3' }], [...bothRead, { filePath: 'cases/c/k3', terminalStatus: 'read' }]);
    expect(a).not.toBe(c);
  });
  it('changes when a read outcome changes', () => {
    const a = computeTriggerHash(docs, bothRead);
    const b = computeTriggerHash(docs, [bothRead[0]!, { filePath: 'cases/c/k2', terminalStatus: 'manual_summary_required' }]);
    expect(a).not.toBe(b);
  });

  // Keystone 4b — the salt contract. The NO-SALT lock is load-bearing: every non-force caller
  // (the /pages trigger, draft-readiness) must produce a byte-identical hash to the historical one.
  it('LOCK: no salt / undefined salt / empty salt are byte-identical bare sha256 hex', () => {
    const a = computeTriggerHash(docs, bothRead);
    expect(computeTriggerHash(docs, bothRead, undefined)).toBe(a);
    expect(computeTriggerHash(docs, bothRead, '')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // bare hex — no separator ever appears unsalted
  });
  it('salted form is `<baseHash>:<salt>` — base prefix-recoverable, deterministic per salt, unique across salts', () => {
    const base = computeTriggerHash(docs, bothRead);
    const salted = computeTriggerHash(docs, bothRead, 'manual:req-1');
    expect(salted).toBe(`${base}:manual:req-1`);
    expect(computeTriggerHash(docs, bothRead, 'manual:req-1')).toBe(salted); // deterministic within a request
    expect(computeTriggerHash(docs, bothRead, 'manual:req-2')).not.toBe(salted); // unique across requests
  });
  it('salted hash fits the widened VarChar(128) column (sha256 + ":manual:" + uuid = 108)', () => {
    const salted = computeTriggerHash(docs, bothRead, 'manual:123e4567-e89b-12d3-a456-426614174000');
    expect(salted.length).toBe(108);
    expect(salted.length).toBeLessThanOrEqual(128);
  });
});

describe('runMatchesHash (forced-run prefix match)', () => {
  it('matches exact and salted-prefix, rejects a different doc set', () => {
    const base = computeTriggerHash(docs, bothRead);
    const other = computeTriggerHash([docs[0]!], [bothRead[0]!]);
    expect(runMatchesHash(base, base)).toBe(true);
    expect(runMatchesHash(`${base}:manual:req-1`, base)).toBe(true);
    expect(runMatchesHash(other, base)).toBe(false);
    expect(runMatchesHash(`${other}:manual:req-1`, base)).toBe(false);
  });
});

describe('deriveChartBuildState', () => {
  it('no_documents when there are no docs', () => {
    expect(deriveChartBuildState([], [], []).state).toBe('no_documents');
  });
  it('ocr_in_progress while any doc is not yet read', () => {
    expect(deriveChartBuildState(docs, [bothRead[0]!], []).state).toBe('ocr_in_progress');
  });
  it('extracting when all read but no run yet (just enqueued / about to)', () => {
    expect(deriveChartBuildState(docs, bothRead, []).state).toBe('extracting');
  });
  it('extracting when the run for the current hash is queued/running', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'running' }]).state).toBe('extracting');
  });
  it('chart_ready when the run for the current hash is complete', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'complete' }]).state).toBe('chart_ready');
  });
  it('extract_failed when the current-hash run failed', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'failed' }]).state).toBe('extract_failed');
  });
  it('chart_ready when the run completed WITH GAPS — the door still opens (audit 2026-06-13)', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'complete_with_gaps' }]).state).toBe('chart_ready');
  });
  it('is extracting (NOT chart_ready) when a complete run is STALE (new upload changed the hash)', () => {
    const staleHash = computeTriggerHash([docs[0]!], [bothRead[0]!]);
    // current set is both docs, but the complete run was for only the first doc → stale → re-extract
    const s = deriveChartBuildState(docs, bothRead, [{ triggerHash: staleHash, status: 'complete' }]);
    expect(s.state).toBe('extracting');
  });
  it('treats a failed-OCR (manual_summary_required) doc as terminal, not stuck in ocr_in_progress', () => {
    const rs = [bothRead[0]!, { filePath: 'cases/c/k2', terminalStatus: 'manual_summary_required' }];
    const h = computeTriggerHash(docs, rs);
    expect(deriveChartBuildState(docs, rs, [{ triggerHash: h, status: 'complete' }]).state).toBe('chart_ready');
  });

  // Keystone 4b DOOR-WEDGE GUARD: a completed FORCED (salted) run of the current doc set must
  // count as chart_ready — without the prefix match it would strand the door in 'extracting'
  // forever (the salted hash never equals the unsalted currentHash).
  it('chart_ready when a FORCED (salted) run of the current doc set is complete', () => {
    const salted = computeTriggerHash(docs, bothRead, 'manual:req-1');
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: salted, status: 'complete' }]).state).toBe('chart_ready');
  });
  it('extracting while the forced (salted) run is queued/running; extract_failed when it failed', () => {
    const salted = computeTriggerHash(docs, bothRead, 'manual:req-1');
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: salted, status: 'queued' }]).state).toBe('extracting');
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: salted, status: 'failed' }]).state).toBe('extract_failed');
  });
  it('a forced run from a STALE doc set does not count for the current one', () => {
    const staleSalted = computeTriggerHash([docs[0]!], [bothRead[0]!], 'manual:req-1');
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: staleSalted, status: 'complete' }]).state).toBe('extracting');
  });

  // STICKY-COMPLETION GUARD (Ewell CLM-A867B8C128, 2026-06-14). The headline bug: the chart extracted
  // successfully, then a DUPLICATE run was enqueued (queued) and later swept to 'failed' by the stuck-run
  // watcher. Keying on the latest run alone showed 'extracting' then 'extract_failed' and froze/un-readied
  // an already-ready chart. A completed run for the current doc set MUST win over any later duplicate.
  it('chart_ready when a completed run coexists with LATER duplicate queued + swept-failed runs (any order)', () => {
    const h = computeTriggerHash(docs, bothRead);
    const failed = { triggerHash: h, status: 'failed' };
    const queued = { triggerHash: h, status: 'queued' };
    const complete = { triggerHash: h, status: 'complete' };
    // newest-first as the route passes them, plus a couple of shuffles to prove order-independence
    expect(deriveChartBuildState(docs, bothRead, [failed, queued, complete]).state).toBe('chart_ready');
    expect(deriveChartBuildState(docs, bothRead, [complete, queued, failed]).state).toBe('chart_ready');
    expect(deriveChartBuildState(docs, bothRead, [queued, complete, failed]).state).toBe('chart_ready');
  });
  it('extracting when only queued/running runs match (no completed run yet)', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'failed' }, { triggerHash: h, status: 'queued' }]).state).toBe('extracting');
  });
  it('extract_failed when ALL matching runs failed (no queued/running/complete)', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: h, status: 'failed' }, { triggerHash: h, status: 'failed' }]).state).toBe('extract_failed');
  });
  it('still keys on the CURRENT hash — a complete current-hash run wins, a complete stale-hash run is ignored', () => {
    const h = computeTriggerHash(docs, bothRead);
    const staleHash = computeTriggerHash([docs[0]!], [bothRead[0]!]);
    // current-set complete + a stale-set complete present → chart_ready (the current one counts)
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: staleHash, status: 'complete' }, { triggerHash: h, status: 'complete' }]).state).toBe('chart_ready');
    // ONLY a stale complete + a current queued → the stale complete must NOT make it ready → extracting
    expect(deriveChartBuildState(docs, bothRead, [{ triggerHash: staleHash, status: 'complete' }, { triggerHash: h, status: 'queued' }]).state).toBe('extracting');
  });
});
