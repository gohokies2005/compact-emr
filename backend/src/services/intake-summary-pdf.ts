/**
 * Render a Jotform intake submission's question/answer set into a clean, readable PDF so the FULL
 * intake (Stage 1 AND Stage 2 — service history, diagnosis/onset answers, prior-denial reason, the
 * "why connected" narrative, etc.) lands in the case chart. Without this, a no-file submission carried
 * nothing into the chart and the drafter had no intake content to work from.
 *
 * The PDF is attached to the case on assign; the normal S3 -> OCR -> chart-extract path then makes its
 * text part of the chart (and the physician can open/download it). Built with pdf-lib (pure JS, no
 * native deps, bundles into the Lambda cleanly).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface IntakeSummaryMeta {
  readonly veteranName?: string;
  readonly condition?: string;
  readonly formTitle?: string;
  readonly submittedAt?: string;
}

type RawAnswer = { type?: string; name?: string; text?: string; answer?: unknown; prettyFormat?: string; order?: string | number };

// Field types that are layout/instruction only — never a real answer.
const SKIP_TYPES = new Set([
  'control_text', 'control_button', 'control_pagebreak', 'control_head', 'control_widget',
  'control_captcha', 'control_divider', 'control_collapse', 'control_image', 'control_fileupload',
]);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => ENTITIES[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
// pdf-lib's WinAnsi fonts throw on characters outside the codepage — normalize the common ones.
function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    // eslint-disable-next-line no-irregular-whitespace -- literal NBSP normalized to a plain space
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
    // eslint-disable-next-line no-control-regex -- strips control chars the PDF font can't render
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function formatAnswer(a: RawAnswer): string {
  const ans = a.answer;
  if (ans === null || ans === undefined) return '';
  if (typeof ans === 'string') return stripHtml(ans);
  if (Array.isArray(ans)) return ans.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  if (typeof ans === 'object') {
    const o = ans as Record<string, unknown>;
    if (o['first'] !== undefined || o['last'] !== undefined) return [o['first'], o['middle'], o['last']].filter(Boolean).join(' ').trim();
    if (o['area'] !== undefined || o['phone'] !== undefined) return a.prettyFormat || `(${o['area'] ?? ''}) ${o['phone'] ?? ''}`.trim();
    if (o['year'] !== undefined && o['month'] !== undefined) return a.prettyFormat || `${o['month']}/${o['day'] ?? ''}/${o['year']}`;
    if (a.prettyFormat) return a.prettyFormat;
    return Object.entries(o).filter(([k]) => k !== 'datetime').map(([k, v]) => `${k}: ${String(v)}`).join(', ');
  }
  return String(ans);
}

/** Ordered, cleaned list of answered questions worth showing. */
export function intakeQuestionPairs(rawAnswers: unknown): Array<{ q: string; a: string }> {
  if (!rawAnswers || typeof rawAnswers !== 'object') return [];
  const entries = Object.entries(rawAnswers as Record<string, RawAnswer>)
    .filter(([, a]) => a && typeof a === 'object' && !SKIP_TYPES.has((a.type ?? '').toLowerCase()))
    .sort(([ka, a], [kb, b]) => (Number(a.order ?? ka) || 0) - (Number(b.order ?? kb) || 0));
  const pairs: Array<{ q: string; a: string }> = [];
  for (const [, a] of entries) {
    const ans = formatAnswer(a);
    if (!ans) continue;
    const q = stripHtml(a.text ?? '') || (a.name ?? 'Question');
    pairs.push({ q, a: ans });
  }
  return pairs;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) > maxWidth && line) { out.push(line); line = word; }
      else line = trial;
    }
    out.push(line);
  }
  return out;
}

export async function renderIntakeSummaryPdf(rawAnswers: unknown, meta: IntakeSummaryMeta = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const MARGIN = 54;
  const PW = 612; const PH = 792;
  const maxW = PW - MARGIN * 2;
  let page: PDFPage = doc.addPage([PW, PH]);
  let y = PH - MARGIN;

  const newPageIfNeeded = (needed: number) => { if (y - needed < MARGIN) { page = doc.addPage([PW, PH]); y = PH - MARGIN; } };
  const draw = (text: string, f: PDFFont, size: number, color = rgb(0.1, 0.1, 0.1)) => {
    for (const line of wrap(toWinAnsi(text), f, size, maxW)) {
      newPageIfNeeded(size + 3);
      page.drawText(line, { x: MARGIN, y: y - size, size, font: f, color });
      y -= size + 3;
    }
  };

  draw('Intake Summary', bold, 16, rgb(0.13, 0.27, 0.42));
  y -= 4;
  const sub = [meta.veteranName, meta.condition, meta.formTitle].filter(Boolean).join('  |  ');
  if (sub) draw(sub, font, 10, rgb(0.35, 0.35, 0.35));
  if (meta.submittedAt) draw(`Submitted: ${meta.submittedAt}`, font, 9, rgb(0.5, 0.5, 0.5));
  y -= 6;
  newPageIfNeeded(2);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PW - MARGIN, y }, thickness: 0.75, color: rgb(0.8, 0.8, 0.8) });
  y -= 14;

  const pairs = intakeQuestionPairs(rawAnswers);
  if (pairs.length === 0) {
    draw('(No intake answers were captured for this submission.)', font, 11, rgb(0.5, 0.2, 0.2));
  }
  for (const { q, a } of pairs) {
    newPageIfNeeded(28);
    draw(q, bold, 10, rgb(0.2, 0.2, 0.2));
    y -= 1;
    draw(a, font, 11);
    y -= 9;
  }

  return doc.save();
}
