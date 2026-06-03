import { describe, it, expect } from 'vitest';
import { computeTriggerHash, deriveChartBuildState, EXTRACTED_SOURCE } from '../chart-build-state.js';

const docs = [{ id: 'd1', s3Key: 'cases/c/k1' }, { id: 'd2', s3Key: 'cases/c/k2' }];
const bothRead = [
  { filePath: 'cases/c/k1', terminalStatus: 'read' },
  { filePath: 'cases/c/k2', terminalStatus: 'read' },
];

describe('EXTRACTED_SOURCE', () => {
  it('is the single non-manual provenance value', () => expect(EXTRACTED_SOURCE).toBe('extracted'));
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
});

describe('deriveChartBuildState', () => {
  it('no_documents when there are no docs', () => {
    expect(deriveChartBuildState([], [], null).state).toBe('no_documents');
  });
  it('ocr_in_progress while any doc is not yet read', () => {
    expect(deriveChartBuildState(docs, [bothRead[0]!], null).state).toBe('ocr_in_progress');
  });
  it('extracting when all read but no run yet (just enqueued / about to)', () => {
    expect(deriveChartBuildState(docs, bothRead, null).state).toBe('extracting');
  });
  it('extracting when the run for the current hash is queued/running', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, { triggerHash: h, status: 'running' }).state).toBe('extracting');
  });
  it('chart_ready when the run for the current hash is complete', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, { triggerHash: h, status: 'complete' }).state).toBe('chart_ready');
  });
  it('extract_failed when the current-hash run failed', () => {
    const h = computeTriggerHash(docs, bothRead);
    expect(deriveChartBuildState(docs, bothRead, { triggerHash: h, status: 'failed' }).state).toBe('extract_failed');
  });
  it('is extracting (NOT chart_ready) when a complete run is STALE (new upload changed the hash)', () => {
    const staleHash = computeTriggerHash([docs[0]!], [bothRead[0]!]);
    // current set is both docs, but the complete run was for only the first doc → stale → re-extract
    const s = deriveChartBuildState(docs, bothRead, { triggerHash: staleHash, status: 'complete' });
    expect(s.state).toBe('extracting');
  });
  it('treats a failed-OCR (manual_summary_required) doc as terminal, not stuck in ocr_in_progress', () => {
    const rs = [bothRead[0]!, { filePath: 'cases/c/k2', terminalStatus: 'manual_summary_required' }];
    const h = computeTriggerHash(docs, rs);
    expect(deriveChartBuildState(docs, rs, { triggerHash: h, status: 'complete' }).state).toBe('chart_ready');
  });
});
