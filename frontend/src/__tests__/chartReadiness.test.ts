// Pure chart-readiness derivations (Phase 2 de-risk, 2026-06-16). Locks the load-bearing rules
// independent of render: the P0 extract_failed gate + the poll predicate + query-only completeness.
import { describe, it, expect } from 'vitest';
import { deriveReadiness, readinessPollInterval } from '../lib/chartReadiness';

describe('readinessPollInterval', () => {
  it('polls (8000) while extracting / ocr_in_progress', () => {
    expect(readinessPollInterval({ ready: false, extractionState: 'extracting' })).toBe(8000);
    expect(readinessPollInterval({ ready: false, extractionState: 'ocr_in_progress' })).toBe(8000);
  });
  it('stops (false) once settled / failed / unknown', () => {
    expect(readinessPollInterval({ ready: true, extractionState: 'chart_ready' })).toBe(false);
    expect(readinessPollInterval({ ready: true, extractionState: 'extract_failed' })).toBe(false);
    expect(readinessPollInterval(undefined)).toBe(false);
  });
});

describe('deriveReadiness', () => {
  it('P0: extract_failed sets extractFailed=true EVEN WHEN ready=true (anti-hollow-letter gate)', () => {
    const r = deriveReadiness({ ready: true, extractionState: 'extract_failed' });
    expect(r.extractFailed).toBe(true);
    expect(r.ready).toBe(true); // OCR readiness can still be true — the panel gates on extractFailed
  });

  it('buildingFromExtraction is RAW query truth (extracting/ocr only), never folds in anything else', () => {
    expect(deriveReadiness({ ready: true, extractionState: 'extracting' }).buildingFromExtraction).toBe(true);
    expect(deriveReadiness({ ready: false, extractionState: 'ocr_in_progress' }).buildingFromExtraction).toBe(true);
    expect(deriveReadiness({ ready: true, extractionState: 'chart_ready' }).buildingFromExtraction).toBe(false);
    expect(deriveReadiness({ ready: true, extractionState: 'extract_failed' }).buildingFromExtraction).toBe(false);
  });

  it('completeness is null while building, else counts from blockingFiles + gaps', () => {
    expect(deriveReadiness({ ready: false, extractionState: 'extracting' }).completeness).toBeNull();
    const r = deriveReadiness({
      ready: true,
      extractionState: 'chart_ready',
      blockingFiles: [{ filePath: 'a.pdf', terminalStatus: 'manual_summary_required' }],
      extractionGaps: { uncoveredPages: 3, truncatedWindows: 1 },
    });
    expect(r.completeness).toEqual({ unreadFileCount: 1, uncoveredPages: 3, truncatedWindows: 1 });
    expect(r.hasGaps).toBe(true);
  });

  it('blockingFiles falls back to the legacy `blockers` field', () => {
    const r = deriveReadiness({ ready: false, blockers: [{ filePath: 'b.pdf', terminalStatus: 'manual_summary_required' }] });
    expect(r.blockingFiles).toHaveLength(1);
  });

  it('undefined payload → safe defaults (not ready, not building, not failed)', () => {
    const r = deriveReadiness(undefined);
    expect(r.ready).toBe(false);
    expect(r.buildingFromExtraction).toBe(false);
    expect(r.extractFailed).toBe(false);
    expect(r.completeness).not.toBeNull(); // settled-but-empty → zeroed completeness, not null
  });
});
