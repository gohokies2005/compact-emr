import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderMemoPdf } from '../services/memo-render.js';
import { buildCoverMemoText } from '../services/delivery-templates.js';
import { KASKY_CREDENTIALS } from '../services/credential-block.js';

// E4 (decision E-4b): self-contained memo→PDF renderer. Letter-size, 1in margins, Times-Roman 12,
// page numbers, an EMBEDDED physician signature (E4 bug fix 2026-06-14), and — critically —
// DETERMINISTIC: same memo text + same signature bytes in, byte-identical PDF out (creation/
// modification dates and producer are pinned).

// A valid 1x1 PNG (the smallest real PNG pdf-lib.embedPng accepts) standing in for the physician's
// signature image. Generated deterministically; reused everywhere a signature is needed.
const SIGNATURE_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0,
  0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1,
  246, 23, 56, 85, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const MEMO_TEXT = buildCoverMemoText({
  pathway: 'supplemental',
  veteranFullName: 'Armand Frank',
  veteranLastName: 'Frank',
  claimedCondition: 'Obstructive Sleep Apnea',
  priorDecisionDate: '2026-01-15',
  signer: KASKY_CREDENTIALS,
  letterDate: '2026-06-11',
});

const render = (text: string = MEMO_TEXT): Promise<Uint8Array> =>
  renderMemoPdf(text, { signaturePng: SIGNATURE_PNG });

describe('renderMemoPdf', () => {
  it('renders non-empty PDF bytes (a real %PDF document)', async () => {
    const bytes = await render();
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('is DETERMINISTIC: the same memo text + signature renders byte-identical PDFs', async () => {
    const a = await render();
    const b = await render();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces a loadable Letter-size document with pinned metadata', async () => {
    const bytes = await render();
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
    const doc = await PDFDocument.load(await render(long));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('survives non-WinAnsi characters (smart quotes, em dashes, emoji) without throwing', async () => {
    const tricky = 'PHYSICIAN COVER MEMORANDUM\n\nRe: “Smart quotes” — em dash – en dash … ellipsis 🦅\n\n[SIGNATURE]';
    const bytes = await render(tricky);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('different memo text produces different bytes (the determinism is content-keyed)', async () => {
    const a = await render();
    const b = await render(`${MEMO_TEXT}\nOne more line.`);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  // ── E4 signature bug fix (2026-06-14): the memo is no longer text-only ──────────────────────────
  it('embeds the signature image (an image XObject) ONLY because the [SIGNATURE] placeholder is present', async () => {
    // The real memo (carries [SIGNATURE]) embeds a PDF image XObject — the embedded PNG.
    const withSig = Buffer.from(await render()).toString('latin1');
    expect(withSig).toContain('/Subtype /Image');

    // A memo with NO [SIGNATURE] placeholder embeds NO image — proving the XObject above is the
    // signature drawn at the placeholder, not incidental chrome. (pdf-lib FlateDecodes content
    // streams, so the placeholder TEXT never leaks into raw bytes either way — the image XObject
    // dict is the load-bearing, observable signal that the signature was actually composited.)
    const noPlaceholder = MEMO_TEXT.split('\n').filter((l) => l.trim() !== '[SIGNATURE]').join('\n');
    const withoutSig = Buffer.from(await renderMemoPdf(noPlaceholder)).toString('latin1');
    expect(withoutSig).not.toContain('/Subtype /Image');
  });

  it('an embedded image is loadable back as exactly one PDF image in the saved memo', async () => {
    const doc = await PDFDocument.load(await render());
    // pdf-lib indexes embedded images; the memo should carry exactly the one signature image.
    expect(doc.getPages().length).toBeGreaterThanOrEqual(1);
    const raw = Buffer.from(await render()).toString('latin1');
    const imageDicts = (raw.match(/\/Subtype \/Image/g) ?? []).length;
    expect(imageDicts).toBe(1);
  });

  it('REQUIRES a signature: a memo with [SIGNATURE] and no signature bytes THROWS (never ships blank)', async () => {
    await expect(renderMemoPdf(MEMO_TEXT)).rejects.toThrow(/signature/i);
    await expect(renderMemoPdf(MEMO_TEXT, { signaturePng: null })).rejects.toThrow(/signature/i);
    await expect(renderMemoPdf(MEMO_TEXT, { signaturePng: new Uint8Array() })).rejects.toThrow(/signature/i);
  });

  it('the memo text carries NO unfilled [BRACKET] tokens (e.g. [PRIOR_DECISION_DATE])', () => {
    expect(MEMO_TEXT).not.toMatch(/\[PRIOR_DECISION_DATE\]/);
    // The ONLY legitimate bracket token in the memo text is the [SIGNATURE] render sentinel (the
    // renderer replaces it with the embedded image). No OTHER unfilled ALL-CAPS bracket survives.
    const brackets = MEMO_TEXT.match(/\[[A-Z0-9_]+\]/g) ?? [];
    expect(brackets).toEqual(['[SIGNATURE]']);
  });
});
