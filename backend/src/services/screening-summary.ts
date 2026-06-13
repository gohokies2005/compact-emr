/**
 * Consolidated screening-summary document (Ryan 2026-06-13). The full-read extractor captures every
 * mental-health / substance screening result (PHQ-9, GAD-7, PCL-5/PC-PTSD-5, AUDIT-C/CAGE, etc.)
 * with its date + page. Rather than clutter the chart with dozens of screen rows, we render them
 * into ONE plain-text file attached under the case's Documents — a quick manual reference for the
 * RN/physician AND a single consolidated artifact the drafter can scan to correlate score trends
 * (e.g. a climbing PHQ-9) with worsening conditions. Screens are NOT diagnoses (stated on the file).
 *
 * PURE: formatting only. The internal route does the S3 write + Document upsert.
 */

import type { ScreeningResult } from './chart-extract-llm.js';

// Instrument → section. Order = display order. A screen matching none lands in OTHER.
const SECTIONS: { title: string; test: RegExp }[] = [
  { title: 'DEPRESSION (PHQ-9 / PHQ-2)', test: /\bphq/i },
  { title: 'ANXIETY (GAD-7 / GAD-2)', test: /\bgad/i },
  { title: 'PTSD (PCL-5 / PC-PTSD-5)', test: /pcl|pc[-\s]?ptsd|ptsd/i },
  { title: 'ALCOHOL / SUBSTANCE (AUDIT-C / CAGE)', test: /audit|cage|dast/i },
  { title: 'SUICIDE RISK (C-SSRS)', test: /c[-\s]?ssrs|columbia|suicide/i },
  { title: 'SLEEP (Epworth / STOP-BANG)', test: /epworth|stop[-\s]?bang/i },
];

function sectionFor(instrument: string): string {
  for (const s of SECTIONS) if (s.test.test(instrument)) return s.title;
  return 'OTHER SCREENS';
}

/** Sort key for a date string: epoch ms when parseable, else +Infinity (undated sinks to the end). */
function dateSortKey(date: string | null): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const t = Date.parse(date);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export interface ScreeningSummaryMeta {
  caseId: string;
  veteranName?: string | null;
  runId: string;
  /** ISO timestamp passed in (the worker stamps it — this module must stay deterministic). */
  extractedAtIso: string;
}

/** Render the consolidated screening summary as plain text. Returns '' when there are no screenings. */
export function formatScreeningSummary(screenings: readonly ScreeningResult[], meta: ScreeningSummaryMeta): string {
  if (screenings.length === 0) return '';

  // Bucket by section, sort each chronologically (undated last), then by instrument for stability.
  const bySection = new Map<string, ScreeningResult[]>();
  for (const s of screenings) {
    const sec = sectionFor(s.instrument);
    (bySection.get(sec) ?? bySection.set(sec, []).get(sec)!).push(s);
  }

  const lines: string[] = [];
  lines.push('SCREENING SUMMARY — auto-extracted from the records');
  lines.push(`Case ${meta.caseId}${meta.veteranName ? ` · ${meta.veteranName}` : ''}`);
  lines.push(`Extracted ${meta.extractedAtIso} · ${screenings.length} result${screenings.length === 1 ? '' : 's'} · run ${meta.runId}`);
  lines.push('');
  lines.push('Reference only — screening scores are NOT diagnoses. Each line: date — instrument score [source page].');
  lines.push('');

  // Emit sections in the declared order, then OTHER last.
  const order = [...SECTIONS.map((s) => s.title), 'OTHER SCREENS'];
  for (const title of order) {
    const rows = bySection.get(title);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => dateSortKey(a.date) - dateSortKey(b.date) || a.instrument.localeCompare(b.instrument));
    lines.push(title);
    for (const r of rows) {
      lines.push(`  ${r.date ?? '(undated)'} — ${r.instrument} ${r.score} [p.${r.sourcePage}]`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
