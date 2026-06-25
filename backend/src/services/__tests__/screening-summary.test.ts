import { describe, it, expect } from 'vitest';
import { formatScreeningSummary } from '../screening-summary.js';
import type { ScreeningResult } from '../chart-extract-llm.js';

function s(instrument: string, score: string, date: string | null, page = 1): ScreeningResult {
  return { instrument, score, date, sourceDocumentId: 'd', sourcePage: page, sourceQuote: `${instrument} ${score}`, confidence: 0.9 };
}
const meta = { caseId: 'CLM-1', veteranName: 'Doe, John', runId: 'RUN-1', extractedAtIso: '2026-06-13T00:00:00.000Z' };

describe('formatScreeningSummary', () => {
  it('returns empty string when there are no screenings', () => {
    expect(formatScreeningSummary([], meta)).toBe('');
  });

  it('groups by instrument family and sorts each section chronologically (undated last)', () => {
    const out = formatScreeningSummary([
      s('PHQ-9', '16', '2020-01-31'),
      s('PHQ-9', '26', '2022-01-27'),
      s('GAD-7', '20', '2022-09-21'),
      s('AUDIT-C', '1', '2025-12-17'),
      s('PCL-5', '72', null),       // undated → end of its section
      s('PHQ-9', '14', '2020-06-05'),
    ], meta);
    // Section headers present.
    expect(out).toContain('DEPRESSION (PHQ-9 / PHQ-2)');
    expect(out).toContain('ANXIETY (GAD-7 / GAD-2)');
    expect(out).toContain('PTSD (PCL-5 / PC-PTSD-5)');
    expect(out).toContain('ALCOHOL / SUBSTANCE (AUDIT-C / CAGE)');
    // PHQ-9 entries are chronological within the depression section.
    const dep = out.slice(out.indexOf('DEPRESSION'));
    expect(dep.indexOf('2020-01-31')).toBeLessThan(dep.indexOf('2020-06-05'));
    expect(dep.indexOf('2020-06-05')).toBeLessThan(dep.indexOf('2022-01-27'));
    // The "not a diagnosis" guard line is present.
    expect(out).toContain('NOT diagnoses');
    // Count + case in the header.
    expect(out).toContain('6 results');
    expect(out).toContain('CLM-1');
  });

  it('renders "date not documented" (not silently empty) for a screening with no date', () => {
    const out = formatScreeningSummary([s('PCL-5', '72', null)], meta);
    expect(out).toContain('date not documented - PCL-5 72');
    expect(out).not.toContain('(undated)');
  });

  it('routes an unknown instrument to OTHER SCREENS', () => {
    const out = formatScreeningSummary([s('Epworth Sleepiness Scale', '11', '2020-10-15'), s('Mystery Screen', 'pos', '2021-01-01')], meta);
    expect(out).toContain('SLEEP (Epworth / STOP-BANG)'); // Epworth matched
    expect(out).toContain('OTHER SCREENS');               // Mystery → other
    expect(out).toContain('Mystery Screen pos');
  });
});
