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
 * producer/creator strings. Same memo text + same signature bytes in → byte-identical PDF out
 * (memo-render.test.ts asserts this), which keeps the artifact diffable and the route cache-friendly.
 *
 * SIGNATURE (E4 bug fix 2026-06-14): the memo is NO LONGER text-only. The [SIGNATURE] placeholder
 * line is replaced by the assigned physician's signature PNG (embedPng + drawImage), mirroring how
 * the FRN coverMemo.js composites samples/R_Kasky_signature.png above the credential block. The
 * signature is REQUIRED: if the memo text carries the [SIGNATURE] placeholder but no signature bytes
 * are supplied, the render THROWS rather than shipping a memo with a literal "[SIGNATURE]" or a blank
 * where the signature belongs. The caller (delivery.ts memo.pdf route) fetches the bytes from the
 * physician's signatureImageS3Key in the PHI bucket.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

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

// The sentinel line in the memo text where the signature image goes (matches delivery-templates.ts
// buildCoverMemoText closing block + coverMemo.js SIG_PLACEHOLDER).
const SIG_PLACEHOLDER = '[SIGNATURE]';
// Drawn signature size, mirroring coverMemo.js writePdfMinimal ({ width: 160, height: 56 }).
const SIG_WIDTH = 160;
const SIG_HEIGHT = 56;

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
    // eslint-disable-next-line no-irregular-whitespace -- literal NBSP normalized to a plain space
    .replace(/ /g, ' ')
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

export interface RenderMemoOptions {
  /**
   * The assigned physician's signature PNG bytes. REQUIRED whenever the memo text contains the
   * [SIGNATURE] placeholder (which buildCoverMemoText always emits): if the placeholder is present
   * and this is null/undefined, the render throws (no memo ships with a literal "[SIGNATURE]" or a
   * blank where the signature belongs). Must be PNG (matches the physician signature upload + the
   * FRN R_Kasky_signature.png).
   */
  readonly signaturePng?: Uint8Array | null;
}

/**
 * Render memo text to PDF bytes. Source line structure is preserved (the memo builder controls
 * paragraph breaks via blank lines); long lines word-wrap; pages break at the bottom margin.
 *
 * The [SIGNATURE] placeholder line is replaced by the physician's embedded signature PNG (drawn at
 * SIG_WIDTH x SIG_HEIGHT). If the placeholder is present and no signaturePng is supplied, this
 * throws — signature is REQUIRED on a cover memo.
 */
export async function renderMemoPdf(memoText: string, options: RenderMemoOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(PINNED_DATE);
  doc.setModificationDate(PINNED_DATE);
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setTitle('Physician Cover Memorandum');

  const font = await doc.embedFont(StandardFonts.TimesRoman);

  // Embed the signature once (reused if the placeholder ever appeared more than once). A present
  // placeholder with no bytes is a hard error — see RenderMemoOptions.signaturePng.
  const hasPlaceholder = toWinAnsi(memoText).split('\n').some((l) => l.trim() === SIG_PLACEHOLDER);
  let signatureImage: PDFImage | null = null;
  if (hasPlaceholder) {
    if (options.signaturePng == null || options.signaturePng.length === 0) {
      throw new Error(
        'renderMemoPdf: the memo contains a [SIGNATURE] placeholder but no signature image was ' +
        'supplied. A cover memo must carry the assigned physician\'s signature.',
      );
    }
    signatureImage = await doc.embedPng(options.signaturePng);
  }

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPageIfNeeded = (heightNeeded = LINE_HEIGHT): void => {
    if (y - heightNeeded < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  for (const sourceLine of toWinAnsi(memoText).split('\n')) {
    if (sourceLine.trim() === SIG_PLACEHOLDER && signatureImage !== null) {
      // Replace the placeholder line with the drawn signature image (above the credential block).
      newPageIfNeeded(SIG_HEIGHT);
      page.drawImage(signatureImage, { x: MARGIN, y: y - SIG_HEIGHT, width: SIG_WIDTH, height: SIG_HEIGHT });
      y -= SIG_HEIGHT + PARAGRAPH_GAP;
      continue;
    }
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
