import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderMemoPdf } from '../services/memo-render.js';
import { buildCoverMemoText } from '../services/delivery-templates.js';
import { KASKY_CREDENTIALS } from '../services/credential-block.js';

// E4 (decision E-4b): self-contained memo→PDF renderer. Letter-size, 1in margins, Times-Roman 12,
// page numbers, and — critically — DETERMINISTIC: same memo text in, byte-identical PDF out
// (creation/modification dates and producer are pinned).

const MEMO_TEXT = buildCoverMemoText({
  pathway: 'supplemental',
  veteranFullName: 'Armand Frank',
  veteranLastName: 'Frank',
  claimedCondition: 'Obstructive Sleep Apnea',
  priorDecisionDate: '2026-01-15',
  signer: KASKY_CREDENTIALS,
  letterDate: '2026-06-11',
});

describe('renderMemoPdf', () => {
  it('renders non-empty PDF bytes (a real %PDF document)', async () => {
    const bytes = await renderMemoPdf(MEMO_TEXT);
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('is DETERMINISTIC: the same memo text renders byte-identical PDFs', async () => {
    const a = await renderMemoPdf(MEMO_TEXT);
    const b = await renderMemoPdf(MEMO_TEXT);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces a loadable Letter-size document with pinned metadata', async () => {
    const bytes = await renderMemoPdf(MEMO_TEXT);
    // updateMetadata: false — load() otherwise overwrites Producer/ModDate with pdf-lib's own.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBe(612);
    expect(page.getHeight()).toBe(792);
    expect(doc.getProducer()).toBe('Aegis EMR memo-render');
    expect(doc.getCreationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  it('paginates long memos onto multiple pages', async () => {
    const long = `${MEMO_TEXT}\n\n${'This paragraph pads the memo to force pagination. '.repeat(200)}`;
    const doc = await PDFDocument.load(await renderMemoPdf(long));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('survives non-WinAnsi characters (smart quotes, em dashes, emoji) without throwing', async () => {
    const tricky = 'PHYSICIAN COVER MEMORANDUM\n\nRe: “Smart quotes” — em dash – en dash … ellipsis 🦅\n\n[SIGNATURE]';
    const bytes = await renderMemoPdf(tricky);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('different memo text produces different bytes (the determinism is content-keyed)', async () => {
    const a = await renderMemoPdf(MEMO_TEXT);
    const b = await renderMemoPdf(`${MEMO_TEXT}\nOne more line.`);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
