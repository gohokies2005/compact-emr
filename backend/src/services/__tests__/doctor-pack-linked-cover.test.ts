import { describe, it, expect } from 'vitest';
import {
  buildCoverIndexLines,
  coverFriendlyLabel,
  plainTheoryLine,
  type CoverIndexEntryInput,
} from '../doctor-pack-generate.js';
import { previewRecordTextLineRects } from '../record-text-render.js';

// DOCTOR_PACK_LINKED_COVER (2026-06-27): the calm clickable table-of-contents cover. Pure-unit
// guards (the S3/DB wiring is exercised in integration). The flag-OFF byte-identity is pinned by the
// existing golden-pack-selection.test.ts "ROUND 2 (D)" + PR-3 blocks (those call the same function
// and now read `.lines`); this file covers the flag-ON layout + the link-map rect mapping.

const ENTRIES: CoverIndexEntryInput[] = [
  { displayLabel: 'Clinical notes — SleepClinic.pdf', docType: 'progress_notes', category: 'clinical', pageRanges: [{ from: 2, to: 3 }], mentionsClaimedCondition: true, assembledStartPage: 2 },
  { displayLabel: 'Rating decision — Misc_1.pdf', docType: 'rating_decision', category: 'sc_proof', pageRanges: [{ from: 1, to: 2 }], mentionsClaimedCondition: true, assembledStartPage: 4 },
  { displayLabel: 'Sleep study — PSG.pdf', docType: 'sleep_study', category: 'tests', pageRanges: [{ from: 1, to: 1 }], mentionsClaimedCondition: true, assembledStartPage: 6 },
  { displayLabel: 'Veteran statement (from intake)', docType: 'lay_statement', category: 'lay', pageRanges: [{ from: 1, to: 1 }], mentionsClaimedCondition: true, assembledStartPage: 7 },
];

function buildLinked(overrides: Partial<Parameters<typeof buildCoverIndexLines>[0]> = {}) {
  return buildCoverIndexLines({
    caseId: 'CASE-LC',
    claimedCondition: 'obstructive sleep apnea',
    claimType: 'secondary',
    framingChoice: 'secondary',
    upstreamScCondition: 'rhinitis',
    linkedCover: true,
    veteranName: 'Jane Veteran',
    serviceConnected: [
      { condition: 'rhinitis', ratingPct: 30 },
      { condition: 'PTSD', ratingPct: 70 },
    ],
    activeProblems: ['hypertension', 'insomnia'],
    entries: ENTRIES,
    notIncluded: ['Misc_8.pdf: duplicate of Misc_6.pdf (identical content) — omitted'],
    ...overrides,
  });
}

describe('coverFriendlyLabel — friendly, filename-free labels', () => {
  it('maps known docTypes to calm labels', () => {
    expect(coverFriendlyLabel('dd_214', 'service')).toBe('DD-214 (service record)');
    expect(coverFriendlyLabel('progress_notes', 'clinical')).toBe('Office visit note');
    expect(coverFriendlyLabel('blue_button', 'clinical')).toBe('Office visit note');
    expect(coverFriendlyLabel('rating_decision', 'sc_proof')).toBe('VA rating decision');
    expect(coverFriendlyLabel('denial_letter', 'denial')).toBe('VA denial');
    expect(coverFriendlyLabel('sleep_study', 'tests')).toBe('Sleep study');
    expect(coverFriendlyLabel('audiogram', 'tests')).toBe('Hearing test');
    expect(coverFriendlyLabel('pulmonary_function_test', 'tests')).toBe('Lung function test');
    expect(coverFriendlyLabel('c_and_p_exam', 'clinical')).toBe('C&P exam');
    expect(coverFriendlyLabel('dbq', 'clinical')).toBe('DBQ exam');
    expect(coverFriendlyLabel('buddy_statement', 'lay')).toBe('Buddy statement');
  });
  it('derives unspecified/unknown from the category', () => {
    expect(coverFriendlyLabel('unspecified', 'other')).toBe('Supporting record');
    expect(coverFriendlyLabel('unspecified', 'sc_proof')).toBe('Service-connection proof');
    expect(coverFriendlyLabel('something_new', 'tests')).toBe('Test result');
  });
  it('NEVER returns a filename or a docType code', () => {
    for (const dt of ['dd_214', 'progress_notes', 'rating_decision', 'unspecified', 'sleep_study']) {
      const label = coverFriendlyLabel(dt, 'clinical');
      expect(label).not.toMatch(/\.pdf/i);
      expect(label).not.toBe(dt);
    }
  });
});

describe('plainTheoryLine', () => {
  it('prefers the upstream SC condition as secondary prose', () => {
    expect(plainTheoryLine('secondary', 'secondary', 'rhinitis')).toBe('Secondary to service-connected rhinitis');
  });
  it('humanizes the framingChoice when no upstream', () => {
    expect(plainTheoryLine('direct_service_connection', 'initial', null)).toBe('Direct service connection');
  });
  it('falls back to claimType then "not set"', () => {
    expect(plainTheoryLine(null, 'initial', null)).toBe('Initial');
    expect(plainTheoryLine(null, null, null)).toBe('not set');
  });
});

describe('linked cover — calm clickable TOC layout', () => {
  const built = buildLinked();
  const body = built.lines.join('\n');

  it('leads with the title block: Doctor Pack / name · case / claimed / theory', () => {
    expect(built.lines[0]).toBe('Doctor Pack');
    expect(built.lines[1]).toBe('Jane Veteran · CASE-LC');
    expect(built.lines[2]).toBe('Claimed: obstructive sleep apnea');
    expect(built.lines[3]).toBe('Theory: Secondary to service-connected rhinitis');
  });

  it('carries a case snapshot with SC (cond + pct) and active problems', () => {
    expect(body).toContain('Case snapshot');
    expect(body).toContain('Service-connected: rhinitis 30% · PTSD 70%');
    expect(body).toContain('Active problems: hypertension · insomnia');
  });

  it('groups contents under calm section headers in must-have order', () => {
    expect(body).toContain('CLINICAL');
    expect(body).toContain('SERVICE-CONNECTION PROOF');
    expect(body).toContain('DEFINING STUDY');
    expect(body).toContain('LAY EVIDENCE');
    // PRIOR DENIAL has no doc here but is a must-have → shows the calm empty line.
    expect(body).toMatch(/PRIOR DENIAL\n {2}None on file/);
  });

  it('each content row has a friendly label and exactly ONE page ref, no filename', () => {
    // One row per entry.
    expect((built.contentRows ?? []).length).toBe(ENTRIES.length);
    // Friendly labels present.
    expect(body).toContain('Office visit note');
    expect(body).toContain('VA rating decision');
    expect(body).toContain('Sleep study');
    // No filenames anywhere on the cover.
    expect(body).not.toMatch(/\.pdf/i);
    // ONE page ref per content row; the contents rows print "p. N".
    for (const row of built.contentRows ?? []) {
      const line = built.lines[row.sourceLineIndex]!;
      const refs = line.match(/p\. \d+/g) ?? [];
      expect(refs.length).toBe(1);
    }
    // No legacy "pinned pN" dump, no page-range soup.
    expect(body).not.toMatch(/pinned p\d+/);
    expect(body).not.toMatch(/p\d+-\d+/);
  });

  it('collapses Not-included to ONE calm line (count + brief)', () => {
    const notInc = built.lines.filter((l) => l.startsWith('Not included:'));
    expect(notInc.length).toBe(1);
    expect(notInc[0]).toContain('1 record');
    // Not the per-note dump.
    expect(body).not.toContain('Misc_8.pdf: duplicate');
  });

  it('shows the calm "Not found in chart" line for a missing must-have (denial here)', () => {
    const onlyClinical = buildLinked({
      entries: [ENTRIES[0]!],
      notIncluded: [],
    });
    const b = onlyClinical.lines.join('\n');
    expect(b).toMatch(/SERVICE-CONNECTION PROOF\n {2}Not found in chart/);
    expect(b).toMatch(/DEFINING STUDY\n {2}Not found in chart/);
  });

  it('truncates a long SC list with "+N more"', () => {
    const many = buildLinked({
      serviceConnected: [
        { condition: 'a', ratingPct: 10 },
        { condition: 'b', ratingPct: 20 },
        { condition: 'c', ratingPct: 30 },
        { condition: 'd', ratingPct: 40 },
        { condition: 'e', ratingPct: 50 },
        { condition: 'f', ratingPct: 60 },
      ],
    });
    expect(many.lines.join('\n')).toContain('+2 more');
  });
});

describe('linked cover — link-map rects map each content row to a rendered rectangle', () => {
  it('every content row resolves to exactly one rendered line with a plausible rect', async () => {
    const built = buildLinked();
    const rects = await previewRecordTextLineRects({
      originalFilename: 'Doctor pack cover index',
      pages: [{ sourcePageNumber: 1, text: built.lines.join('\n') }],
      provenanceHeader: 'DOCTOR PACK — COVER INDEX',
      omitSourceFooters: true,
    });
    expect((built.contentRows ?? []).length).toBeGreaterThan(0);
    for (const row of built.contentRows ?? []) {
      const lineRects = rects.filter((r) => r.sourceLineIndex === row.sourceLineIndex);
      expect(lineRects.length).toBeGreaterThanOrEqual(1);
      const [x0, y0, x1, y1] = lineRects[0]!.rect;
      // Inside the page, left-to-right and bottom-to-top ordered, within US-Letter bounds.
      expect(x0).toBeLessThan(x1);
      expect(y0).toBeLessThan(y1);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(612);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(792);
      // The rendered line that carries the row text matches its friendly label.
      expect(lineRects[0]!.text).toContain(row.label.slice(0, 8));
    }
  });

  it('header lines carry sourceLineIndex null; content rows carry a number', async () => {
    const built = buildLinked();
    const rects = await previewRecordTextLineRects({
      originalFilename: 'Doctor pack cover index',
      pages: [{ sourcePageNumber: 1, text: built.lines.join('\n') }],
      provenanceHeader: 'DOCTOR PACK — COVER INDEX',
      omitSourceFooters: true,
    });
    // The provenance header ('DOCTOR PACK — COVER INDEX') renders with a null source-line index.
    expect(rects.some((r) => r.sourceLineIndex === null)).toBe(true);
    // Title line 'Doctor Pack' is source line 0.
    const titleRect = rects.find((r) => r.text === 'Doctor Pack');
    expect(titleRect?.sourceLineIndex).toBe(0);
  });
});
