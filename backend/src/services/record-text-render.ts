/**
 * WAVE 2 (assessment 2026-06-12 §1b): record-text → PDF renderer.
 *
 * THE PCP CONDITION this exists for: "a pack without the diagnosing note is never acceptable.
 * Not ever." The diagnosing note frequently arrives as a .txt/.rtf/.doc upload, and the Python
 * assembler (workers/doctor-pack-assembler/handler.py) is deliberately PDF-only — non-PDF
 * manifest entries were skipped, so the one document the physician refuses to sign without
 * could structurally never reach the pack. This module renders the SELECTED pages'
 * document_pages.text into a real PDF at manifest time (backend side), so the assembler stays
 * dumb and the dx note ships.
 *
 * Modeled EXACTLY on services/memo-render.ts (decision in the assessment: reuse the existing
 * pdf-lib path; rejected alternatives were fpdf2/reportlab vendored into the worker — a second
 * rendering stack — and weasyprint — the already-fragile optional layer, never load-bearing).
 *
 * PCP acceptance conditions, enforced here:
 *   - VERBATIM text. No cleanup, no truncation beyond the already-selected pages. The only
 *     transformation is WinAnsi normalization (smart quotes → ASCII etc.) because Times-Roman
 *     is a WinAnsi font and pdf-lib throws on out-of-codepage glyphs — same as memo-render.
 *   - A mandatory provenance header block: 'Rendered verbatim from: <original filename> —
 *     source uploaded <date>. Converted for inclusion; text unmodified.'
 *   - Per-page footers 'page N of source' so the physician always knows which source page a
 *     rendered page came from. Each SOURCE page starts on a fresh PDF page; a source page that
 *     wraps across multiple PDF pages repeats its footer.
 *
 * DETERMINISTIC by construction (same contract as memo-render): pinned creation/modification
 * dates, pinned producer/creator, fixed font + layout constants. Same input → byte-identical
 * PDF out (record-text-render.test.ts asserts this), which makes the generate path idempotent:
 * re-generating a pack overwrites the _rendered/ S3 object with the identical bytes.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// US Letter in PDF points — identical constants to memo-render.ts.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72; // 1 inch
const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const PARAGRAPH_GAP = 8;
const FOOTER_Y = 40;
const MAX_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Pinned metadata epoch — the ONLY date pdf-lib would otherwise stamp with "now".
const PINNED_DATE = new Date('2000-01-01T00:00:00.000Z');
const PRODUCER = 'Aegis EMR record-text-render';

// WinAnsi normalization — copied from memo-render.ts (Times-Roman is WinAnsi-encoded; pdf-lib
// throws mid-render on out-of-codepage characters). This is encoding survival, not cleanup:
// every kept character renders exactly as stored.
function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    // eslint-disable-next-line no-control-regex -- strips control chars the PDF font can't render
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

/** Greedy word-wrap of ONE source line into rendered lines that fit MAX_WIDTH. */
function wrapLine(line: string, font: PDFFont): string[] {
  if (line.trim() === '') return [''];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/\s+/)) {
    const trial = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(trial, FONT_SIZE) > MAX_WIDTH && current !== '') {
      out.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  out.push(current);
  return out;
}

export interface RecordTextPage {
  // The page number in the SOURCE document (1-indexed, as stored on document_pages rows).
  readonly sourcePageNumber: number;
  readonly text: string;
}

export interface RenderRecordTextInput {
  // The human filename shown in the provenance header (e.g. 'PsychNote.txt').
  readonly originalFilename: string;
  // Document.uploadedAt — rendered into the header as an ISO date; null/invalid → 'unknown date'.
  readonly sourceUploadedAt?: Date | null;
  // The SELECTED source pages, in order. Verbatim text — the caller has already applied page
  // selection; this module never drops or trims content.
  readonly pages: readonly RecordTextPage[];
  // Round 2 (backlog §Doctor-pack round 2 C/D, 2026-06-12): pages that are not document
  // conversions (the veteran's intake statement, the cover index) carry their OWN provenance/
  // title line instead of the 'Rendered verbatim from: …' sentence. When set, this string IS
  // the header block, verbatim.
  readonly provenanceHeader?: string;
  // Same callers: 'page N of source' footers are meaningless when there is no source document.
  readonly omitSourceFooters?: boolean;
}

export interface RenderRecordTextResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

/** The mandatory PCP provenance header sentence (exported so tests pin the exact wording). */
export function buildRecordRenderHeader(originalFilename: string, sourceUploadedAt?: Date | null): string {
  const uploaded =
    sourceUploadedAt instanceof Date && !Number.isNaN(sourceUploadedAt.getTime())
      ? sourceUploadedAt.toISOString().slice(0, 10)
      : 'unknown date';
  return `Rendered verbatim from: ${originalFilename} — source uploaded ${uploaded}. Converted for inclusion; text unmodified.`;
}

// One planned PDF page: which source page its content belongs to (footer label) + the lines to
// draw, top-down. `null` items are paragraph gaps (blank source lines — vertical air, no glyphs).
export interface PlannedPdfPage {
  readonly sourcePageNumber: number;
  readonly items: readonly (string | null)[];
}

// LINKED COVER (2026-06-27, DOCTOR_PACK_LINKED_COVER): a richer plan item that also carries the
// SOURCE line index the rendered line came from (null for the provenance-header lines and for
// paragraph gaps). Used ONLY by previewRecordTextLineRects to map a cover content-row back to its
// rendered rectangle. The public PlannedPdfPage shape AND the renderer are unchanged — the legacy
// planRecordTextLayout below is a byte-identical projection of this rich plan.
interface RichPlanItem {
  readonly text: string | null; // null = paragraph gap (no glyphs)
  readonly sourceLineIndex: number | null; // index within the source page's split('\n'); null = header/gap
}
interface RichPlannedPage {
  readonly sourcePageNumber: number;
  readonly items: RichPlanItem[];
}

// Pure layout planner (rich) — the single source of truth for page breaking + item order. The
// renderer draws EXACTLY this plan (via the legacy projection), previewRecordTextLayout exposes the
// text-only view, and previewRecordTextLineRects replays the same y-walk to derive per-line rects.
function planRecordTextLayoutRich(input: RenderRecordTextInput, font: PDFFont): RichPlannedPage[] {
  if (input.pages.length === 0) {
    throw new Error('renderRecordTextPdf: no extracted page text to render');
  }
  const pages: RichPlannedPage[] = [];
  let cur: RichPlannedPage;
  let y = 0;
  const newPage = (sourcePageNumber: number): void => {
    cur = { sourcePageNumber, items: [] };
    pages.push(cur);
    y = PAGE_HEIGHT - MARGIN;
  };
  const pushLine = (line: string, sourcePageNumber: number, sourceLineIndex: number | null): void => {
    if (y - LINE_HEIGHT < MARGIN) newPage(sourcePageNumber);
    cur.items.push({ text: line, sourceLineIndex });
    y -= LINE_HEIGHT;
  };
  const pushGap = (): void => {
    cur.items.push({ text: null, sourceLineIndex: null });
    y -= PARAGRAPH_GAP;
  };

  const firstSource = input.pages[0]!.sourcePageNumber;
  newPage(firstSource);

  // Mandatory provenance header block, then a paragraph gap before the verbatim text.
  // provenanceHeader (Round 2): non-document pages (intake statement, cover index) supply
  // their own header sentence verbatim instead of the document-conversion one.
  const headerText = input.provenanceHeader ?? buildRecordRenderHeader(input.originalFilename, input.sourceUploadedAt);
  for (const headerLine of wrapLine(toWinAnsi(headerText), font)) {
    pushLine(headerLine, firstSource, null);
  }
  pushGap();

  input.pages.forEach((src, i) => {
    // Each source page starts on a fresh PDF page so every PDF page maps to exactly ONE
    // source page (unambiguous 'page N of source' footers). Source page 1 shares the header page.
    if (i > 0) newPage(src.sourcePageNumber);
    toWinAnsi(src.text).split('\n').forEach((sourceLine, lineIdx) => {
      if (sourceLine.trim() === '') {
        pushGap();
        return;
      }
      for (const line of wrapLine(sourceLine, font)) pushLine(line, src.sourcePageNumber, lineIdx);
    });
  });

  return pages;
}

// Legacy text-only projection — IDENTICAL output (page breaks + item order) to the pre-2026-06-27
// planner. The renderer and previewRecordTextLayout consume this; behavior is unchanged.
function planRecordTextLayout(input: RenderRecordTextInput, font: PDFFont): PlannedPdfPage[] {
  return planRecordTextLayoutRich(input, font).map((p) => ({
    sourcePageNumber: p.sourcePageNumber,
    items: p.items.map((it) => it.text),
  }));
}

// LINKED COVER (2026-06-27): one rendered text line + its clickable rectangle in PDF user space
// (origin bottom-left, points). sourceLineIndex is the index into the source page's split('\n')
// lines (null for header lines), so a caller that built the source text line-by-line (the cover
// index) can map a known line back to its on-page rectangle for a PDF link annotation.
export interface RenderedLineRect {
  readonly pdfPageIndex: number;
  readonly sourcePageNumber: number;
  readonly sourceLineIndex: number | null;
  readonly text: string;
  readonly rect: readonly [number, number, number, number]; // [x0, y0, x1, y1]
}

/**
 * Replay the renderer's exact per-page y-walk over the rich plan to produce a clickable rectangle
 * for every rendered (non-gap) line. The rect spans the full text column (MARGIN..PAGE_WIDTH-MARGIN)
 * and the line's vertical slot, matching where renderRecordTextPdf draws the glyphs. Pure +
 * deterministic (same constants as the renderer).
 */
export async function previewRecordTextLineRects(input: RenderRecordTextInput): Promise<readonly RenderedLineRect[]> {
  const scratch = await PDFDocument.create();
  const font = await scratch.embedFont(StandardFonts.TimesRoman);
  const plan = planRecordTextLayoutRich(input, font);
  const out: RenderedLineRect[] = [];
  plan.forEach((page, pdfPageIndex) => {
    let y = PAGE_HEIGHT - MARGIN;
    for (const item of page.items) {
      if (item.text === null) {
        y -= PARAGRAPH_GAP;
        continue;
      }
      out.push({
        pdfPageIndex,
        sourcePageNumber: page.sourcePageNumber,
        sourceLineIndex: item.sourceLineIndex,
        text: item.text,
        rect: [MARGIN, y - LINE_HEIGHT, PAGE_WIDTH - MARGIN, y],
      });
      y -= LINE_HEIGHT;
    }
  });
  return out;
}

/**
 * Test/inspection hook: the exact layout the renderer will draw — header line(s) included,
 * verbatim text lines, source-page mapping per PDF page. Embeds the font in a scratch document
 * purely for width metrics.
 */
export async function previewRecordTextLayout(input: RenderRecordTextInput): Promise<readonly PlannedPdfPage[]> {
  const scratch = await PDFDocument.create();
  const font = await scratch.embedFont(StandardFonts.TimesRoman);
  return planRecordTextLayout(input, font);
}

/**
 * Render the selected source pages' text to PDF bytes. Throws when there is nothing to render
 * (the generate path treats that as a per-entry render failure and fails open — the entry is
 * dropped into trimNotes, never the whole pack).
 */
export async function renderRecordTextPdf(input: RenderRecordTextInput): Promise<RenderRecordTextResult> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(PINNED_DATE);
  doc.setModificationDate(PINNED_DATE);
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setTitle(`Rendered record text — ${input.originalFilename}`);

  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const plan = planRecordTextLayout(input, font);

  for (const planned of plan) {
    const page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    for (const item of planned.items) {
      if (item === null) {
        y -= PARAGRAPH_GAP;
        continue;
      }
      page.drawText(item, { x: MARGIN, y: y - FONT_SIZE, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
  }

  // 'page N of source' footers — N is the SOURCE page number, repeated when a source page
  // wraps across multiple rendered pages. Suppressed for non-document pages (Round 2).
  const pages = doc.getPages();
  if (input.omitSourceFooters !== true) {
    pages.forEach((p, i) => {
      const label = `page ${plan[i]!.sourcePageNumber} of source`;
      const w = font.widthOfTextAtSize(label, 10);
      p.drawText(label, { x: (PAGE_WIDTH - w) / 2, y: FOOTER_Y, size: 10, font, color: rgb(0.35, 0.35, 0.35) });
    });
  }

  const bytes = await doc.save();
  return { bytes, pageCount: pages.length };
}
