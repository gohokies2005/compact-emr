import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildRecordRenderHeader,
  previewRecordTextLayout,
  renderRecordTextPdf,
} from '../services/record-text-render.js';

// WAVE 2 (assessment 2026-06-12 §1b): non-PDF record text → PDF renderer. The PCP's acceptance
// conditions are pinned here: deterministic bytes (idempotent regeneration), the mandatory
// provenance header, VERBATIM text, and 'page N of source' footers. Layout assertions go
// through previewRecordTextLayout (the exact plan the renderer draws) because pdf-lib encodes
// drawn text as hex strings — byte-grepping the PDF for prose is not viable.

const PSYCH_NOTE_INPUT = {
  originalFilename: 'PsychNote.txt',
  sourceUploadedAt: new Date('2026-05-01T15:30:00.000Z'),
  pages: [
    { sourcePageNumber: 1, text: 'Veteran presents with persistent anxiety.\n\nDiagnosis: generalized anxiety disorder.' },
    { sourcePageNumber: 2, text: 'Plan: continue sertraline 50mg daily. Follow up in 3 months.' },
  ],
} as const;

describe('buildRecordRenderHeader', () => {
  it('produces the exact PCP-mandated provenance sentence', () => {
    expect(buildRecordRenderHeader('PsychNote.txt', new Date('2026-05-01T15:30:00.000Z'))).toBe(
      'Rendered verbatim from: PsychNote.txt — source uploaded 2026-05-01. Converted for inclusion; text unmodified.',
    );
  });

  it('renders "unknown date" when the upload date is missing or invalid', () => {
    expect(buildRecordRenderHeader('Note.txt', null)).toContain('source uploaded unknown date');
    expect(buildRecordRenderHeader('Note.txt', new Date('garbage'))).toContain('source uploaded unknown date');
  });
});

describe('renderRecordTextPdf', () => {
  it('renders non-empty real PDF bytes', async () => {
    const { bytes, pageCount } = await renderRecordTextPdf(PSYCH_NOTE_INPUT);
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(pageCount).toBe(2); // two short source pages → one PDF page each
  });

  it('is DETERMINISTIC: same input renders byte-identical PDFs (idempotent S3 overwrite)', async () => {
    const a = await renderRecordTextPdf(PSYCH_NOTE_INPUT);
    const b = await renderRecordTextPdf(PSYCH_NOTE_INPUT);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('different text produces different bytes (determinism is content-keyed)', async () => {
    const a = await renderRecordTextPdf(PSYCH_NOTE_INPUT);
    const b = await renderRecordTextPdf({
      ...PSYCH_NOTE_INPUT,
      pages: [{ sourcePageNumber: 1, text: 'Entirely different note body.' }],
    });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
  });

  it('produces a loadable Letter-size document with PINNED metadata (no "now" timestamps)', async () => {
    const { bytes } = await renderRecordTextPdf(PSYCH_NOTE_INPUT);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getWidth()).toBe(612);
    expect(doc.getPage(0).getHeight()).toBe(792);
    expect(doc.getProducer()).toBe('Aegis EMR record-text-render');
    expect(doc.getCreationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  it('throws when there is no page text to render (the generate path fails open per entry)', async () => {
    await expect(renderRecordTextPdf({ ...PSYCH_NOTE_INPUT, pages: [] })).rejects.toThrow(/no extracted page text/);
  });

  it('survives non-WinAnsi characters without throwing', async () => {
    const { bytes } = await renderRecordTextPdf({
      ...PSYCH_NOTE_INPUT,
      pages: [{ sourcePageNumber: 1, text: '“Smart quotes” — em dash … ellipsis 🦅 nightmares' }],
    });
    expect(bytes.length).toBeGreaterThan(500);
  });
});

describe('previewRecordTextLayout (the exact plan the renderer draws)', () => {
  it('page 1 starts with the mandatory provenance header block', async () => {
    const plan = await previewRecordTextLayout(PSYCH_NOTE_INPUT);
    const firstLines = (plan[0]?.items ?? []).filter((i): i is string => i !== null);
    // The header may wrap; rejoining the leading lines must reconstruct the full sentence.
    const rejoined = firstLines.join(' ');
    expect(rejoined).toContain('Rendered verbatim from: PsychNote.txt');
    expect(rejoined).toContain('source uploaded 2026-05-01');
    expect(rejoined).toContain('Converted for inclusion; text unmodified.');
  });

  it('carries the source text VERBATIM (no cleanup, no truncation)', async () => {
    const plan = await previewRecordTextLayout(PSYCH_NOTE_INPUT);
    const allText = plan.flatMap((p) => p.items).filter((i): i is string => i !== null).join(' ');
    expect(allText).toContain('Veteran presents with persistent anxiety.');
    expect(allText).toContain('Diagnosis: generalized anxiety disorder.');
    expect(allText).toContain('Plan: continue sertraline 50mg daily. Follow up in 3 months.');
  });

  it('each source page starts a new PDF page mapped for its "page N of source" footer', async () => {
    const input = {
      ...PSYCH_NOTE_INPUT,
      pages: [
        { sourcePageNumber: 3, text: 'Selected source page three.' },
        { sourcePageNumber: 7, text: 'Selected source page seven.' },
      ],
    };
    const plan = await previewRecordTextLayout(input);
    expect(plan.map((p) => p.sourcePageNumber)).toEqual([3, 7]);
  });

  it('a long source page that wraps across PDF pages repeats its source mapping', async () => {
    const longText = 'This sentence pads a single source page until it overflows the rendered page. '.repeat(120);
    const plan = await previewRecordTextLayout({
      ...PSYCH_NOTE_INPUT,
      pages: [{ sourcePageNumber: 5, text: longText }],
    });
    expect(plan.length).toBeGreaterThanOrEqual(2);
    expect(new Set(plan.map((p) => p.sourcePageNumber))).toEqual(new Set([5]));
  });
});

// ROUND 2 (backlog §Doctor-pack round 2 C/D): non-document pages — the veteran's intake
// statement and the cover index — carry their OWN header line and no 'page N of source' footer.
describe('provenanceHeader override + omitSourceFooters (Round 2)', () => {
  const STATEMENT_INPUT = {
    originalFilename: 'Veteran statement (from intake)',
    pages: [{ sourcePageNumber: 1, text: 'My back pain started after the 2009 convoy accident.' }],
    provenanceHeader: "Veteran's statement as submitted at intake on 2026-03-15",
    omitSourceFooters: true,
  } as const;

  it('the override REPLACES the document-conversion header verbatim', async () => {
    const plan = await previewRecordTextLayout(STATEMENT_INPUT);
    const rejoined = (plan[0]?.items ?? []).filter((i): i is string => i !== null).join(' ');
    expect(rejoined).toContain("Veteran's statement as submitted at intake on 2026-03-15");
    expect(rejoined).not.toContain('Rendered verbatim from');
    expect(rejoined).toContain('My back pain started after the 2009 convoy accident.');
  });

  it('renders + stays deterministic with footers omitted', async () => {
    const a = await renderRecordTextPdf(STATEMENT_INPUT);
    const b = await renderRecordTextPdf(STATEMENT_INPUT);
    expect(new TextDecoder().decode(a.bytes.slice(0, 5))).toBe('%PDF-');
    expect(a.pageCount).toBe(1);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('omitting footers changes the bytes vs the footered render (the flag is live)', async () => {
    const withFooter = await renderRecordTextPdf({ ...STATEMENT_INPUT, omitSourceFooters: false });
    const withoutFooter = await renderRecordTextPdf(STATEMENT_INPUT);
    expect(Buffer.from(withFooter.bytes).equals(Buffer.from(withoutFooter.bytes))).toBe(false);
  });
});
