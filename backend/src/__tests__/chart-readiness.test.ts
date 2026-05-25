import { describe, expect, it } from 'vitest';
import {
  CHART_READINESS_GATE_VERSION,
  classifyReadAttempt,
  corruptedTokenRatio,
  evaluateChartReadiness,
  isValidManualSummary,
  MANUAL_SUMMARY_MIN_LEN,
  READ_THRESHOLD_RATIO,
  READ_THRESHOLD_WORDS,
  wordCount,
} from '../services/chart-readiness.js';
import type { FileReadStatusRecord } from '../services/db-types.js';

const now = new Date('2026-05-26T00:00:00.000Z');

function row(overrides: Partial<FileReadStatusRecord> = {}): FileReadStatusRecord {
  return {
    id: overrides.id ?? `FRS-${Math.random().toString(36).slice(2, 8)}`,
    caseId: 'CASE-1',
    filePath: 'records/test.pdf',
    fileSha256: 'a'.repeat(64),
    terminalStatus: 'read',
    attemptsJson: [],
    manualSummary: null,
    manualSummaryAt: null,
    manualSummaryBy: null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

describe('corruptedTokenRatio', () => {
  it('returns 0 for empty / non-text input', () => {
    expect(corruptedTokenRatio('')).toBe(0);
    expect(corruptedTokenRatio(undefined as unknown as string)).toBe(0);
  });

  it('returns 0 for clean prose', () => {
    const clean = 'The patient is a 45 year old male presenting with right knee pain and limited range of motion in the affected joint.';
    expect(corruptedTokenRatio(clean)).toBeLessThan(0.02);
  });

  it('returns 0 for clean medical codes (L4-L5, M47.817, T2DM)', () => {
    const codes = 'Lumbar spine MRI showed L4-L5 disc protrusion. ICD-10 M47.817 documented. T2DM was a comorbidity.';
    expect(corruptedTokenRatio(codes)).toBeLessThan(0.05);
  });

  it('flags garbled tokens (OCR signature)', () => {
    const garbled = 'Pati$nt is a 4@ year ol# male p#esent!ng w-i-t-h r!ght kn$e p$in and lim%ted r@nge of m0t!on';
    expect(corruptedTokenRatio(garbled)).toBeGreaterThan(0.08);
  });

  it('crosses the 0.08 threshold cleanly for clearly-garbled text', () => {
    const veryGarbled = 'TH$ pa%ti#en+t wa@s ad!mit-ted f0r r$evi^ew of c$ompl#aint of l@umb%ar p@a!n';
    expect(corruptedTokenRatio(veryGarbled)).toBeGreaterThan(0.14);
  });
});

describe('wordCount', () => {
  it('counts space-separated words', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\n   ')).toBe(0);
  });
});

describe('classifyReadAttempt', () => {
  it('rejects too-few-words (< MIN_WORDS_FOR_READ)', () => {
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: 'only a few words here just shy of forty' });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('too-few-words');
    expect(r.wordCount).toBeLessThan(READ_THRESHOLD_WORDS);
  });

  it('rejects garbled text even with high word count', () => {
    const garbled = ('Pati$nt is a 4@ year ol# male p#esent!ng w-i-t-h r!ght kn$e p$in and lim%ted r@nge of m0t!on ' + 'and disp%@yed n0 ev!d#nce of im+pro!vement following six weeks of phys-ic@l ther+apy ad-min-is-ter-ed').repeat(2);
    const r = classifyReadAttempt({ method: 'tesseract_ocr', extractedText: garbled });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('garbled');
    expect(r.corruptedTokenRatio).toBeGreaterThan(READ_THRESHOLD_RATIO);
  });

  it('accepts clean text above thresholds', () => {
    const clean = 'The veteran is a fifty year old male with documented right knee pain. He served on active duty from two thousand one to two thousand eight in the United States Army with a primary military occupational specialty in infantry. He reports gradual onset of symptoms during service with progression after separation. Imaging confirms degenerative changes in the right knee compartment.';
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: clean });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });
});

describe('isValidManualSummary', () => {
  it('rejects short summaries (< 40 chars)', () => {
    expect(isValidManualSummary('short')).toBe(false);
    expect(isValidManualSummary('exactly thirty nine characters here.')).toBe(false);
    expect(isValidManualSummary('   trimmed-blank-' + 'x'.repeat(10) + '   ')).toBe(false);
  });

  it('accepts >= 40 chars after trim', () => {
    const s = 'This file shows a rating decision dated 2024 confirming PTSD service connection at 70 percent.';
    expect(isValidManualSummary(s)).toBe(true);
    expect(s.length).toBeGreaterThanOrEqual(MANUAL_SUMMARY_MIN_LEN);
  });

  it('rejects non-string values', () => {
    expect(isValidManualSummary(null)).toBe(false);
    expect(isValidManualSummary(undefined)).toBe(false);
    expect(isValidManualSummary(123)).toBe(false);
  });
});

describe('evaluateChartReadiness', () => {
  it('ready=true on empty input (no files yet)', () => {
    const r = evaluateChartReadiness([]);
    expect(r.ready).toBe(true);
    expect(r.totalFiles).toBe(0);
    expect(r.blockingFiles).toEqual([]);
    expect(r.gateVersion).toBe(CHART_READINESS_GATE_VERSION);
  });

  it('ready=true when all rows are read', () => {
    const r = evaluateChartReadiness([row({ terminalStatus: 'read' }), row({ terminalStatus: 'read', filePath: 'records/b.pdf' })]);
    expect(r.ready).toBe(true);
    expect(r.readFiles).toBe(2);
  });

  it('ready=true when rows are read or have valid manual summaries', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'read' }),
      row({ terminalStatus: 'manual_summary_provided', manualSummary: 'This file is a rating decision dated 2024 showing PTSD service connection at 70 percent.' }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.readFiles).toBe(1);
    expect(r.manualSummaryProvided).toBe(1);
  });

  it('ready=false when any row is manual_summary_required', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'read', filePath: 'records/a.pdf' }),
      row({ terminalStatus: 'manual_summary_required', filePath: 'records/b.pdf' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
    expect(r.blockingFiles[0]?.filePath).toBe('records/b.pdf');
  });

  it('treats manual_summary_provided with empty/short summary as still-required (defense-in-depth)', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'manual_summary_provided', manualSummary: 'too short', filePath: 'records/c.pdf' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
    expect(r.manualSummaryRequired).toBe(1);
  });

  it('captures lastAttempt context for blocking rows when available', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        attemptsJson: [
          { method: 'native_pdf_text', wordCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-05-26T00:00:00Z', note: 'too-few-words (5 < 40)' },
          { method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.21, attemptedAt: '2026-05-26T00:01:00Z', note: 'garbled' },
        ],
      }),
    ]);
    expect(r.blockingFiles[0]?.lastAttempt?.method).toBe('tesseract_ocr');
    expect(r.blockingFiles[0]?.lastAttempt?.note).toBe('garbled');
  });
});
