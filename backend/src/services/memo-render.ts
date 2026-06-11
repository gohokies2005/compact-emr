/**
 * Cover-memo → PDF renderer (Chunk E4, decision E-4b): SELF-CONTAINED in the EMR backend, built on
 * pdf-lib (already a direct dependency — intake-summary-pdf.ts uses it; pure JS, bundles into the
 * Lambda cleanly). Deliberately NOT the FRN render Lambda: that image only knows the nexus-letter
 * shape (signature compositing, letter chrome, credential substitution) and would inject letter
 * furniture into a plain transmittal memo (delivery-templates.ts header comment).
 *
 * The memo is plain prose ending in a [SIGNATURE] placeholder + credential block, so the render is
 * simple: US Letter, 1" margins, Times-Roman 12, greedy word-wrap, top-down pagination, "Page X of
 * Y" footers.
 *
 * DETERMINISTIC by construction: pdf-lib's only nondeterminism for a text-only document is the
 * creation/modification dates (it stamps "now"), so we pin both to a fixed epoch and pin
 * producer/creator strings. Same memo text in → byte-identical PDF out (memo-render.test.ts
 * asserts this), which keeps the artifact diffable and the route cache-friendly.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// US Letter in PDF points.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72; // 1 inch
const FONT_SIZE = 12;
const LINE_HEIGHT = 16; // 12pt Times with comfortable leading
const PARAGRAPH_GAP = 8;
const FOOTER_Y = 40; // page-number baseline, inside the bottom margin zone
const MAX_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Pinned metadata epoch — the ONLY date pdf-lib would otherwise stamp with "now".
const PINNED_DATE = new Date('2000-01-01T00:00:00.000Z');
const PRODUCER = 'Aegis EMR memo-render';

// Times-Roman is a WinAnsi-encoded standard font: characters outside the codepage make
// pdf-lib throw mid-render. Normalize the common typographic characters and drop the rest
// (same approach as intake-summary-pdf.ts toWinAnsi). The memo builder already strips em
// dashes, but veteran names can carry anything.
function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
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

/**
 * Render memo text to PDF bytes. Source line structure is preserved (the memo builder controls
 * paragraph breaks via blank lines); long lines word-wrap; pages break at the bottom margin.
 */
export async function renderMemoPdf(memoText: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(PINNED_DATE);
  doc.setModificationDate(PINNED_DATE);
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setTitle('Physician Cover Memorandum');

  const font = await doc.embedFont(StandardFonts.TimesRoman);

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPageIfNeeded = (): void => {
    if (y - LINE_HEIGHT < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  for (const sourceLine of toWinAnsi(memoText).split('\n')) {
    if (sourceLine.trim() === '') {
      // Blank source line = paragraph gap (no glyphs to draw, half a line of air).
      y -= PARAGRAPH_GAP;
      continue;
    }
    for (const line of wrapLine(sourceLine, font)) {
      newPageIfNeeded();
      page.drawText(line, { x: MARGIN, y: y - FONT_SIZE, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
  }

  // "Page X of Y" centered footers — drawn last so Y (total) is known.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(label, 10);
    p.drawText(label, { x: (PAGE_WIDTH - w) / 2, y: FOOTER_Y, size: 10, font, color: rgb(0.35, 0.35, 0.35) });
  });

  return doc.save();
}
