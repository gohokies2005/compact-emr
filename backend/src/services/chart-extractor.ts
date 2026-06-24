/**
 * Chart auto-extractor — Phase A (DARK): deterministic section-targeting over a case's OCR'd
 * documents, isolating ONLY the structured list sections (Problem List, Medications, granted
 * Service-Connected disabilities) so an LLM parse sees pre-isolated structured text, never the
 * 1M+ chars of clinical narrative it could hallucinate from.
 *
 * Design constraints (Ryan, 2026-06-03 — "without messing it up"):
 *   - The VA document is the SOURCE OF TRUTH; the vet's verbal report is a lead, not a grant.
 *     (see memory feedback_va_document_is_source_of_truth)
 *   - Every extracted item must be GROUNDABLE to a verbatim quote on a known page. The grounding
 *     check (groundExtractedItem) rejects anything whose quote is not a substring of the cited
 *     page — structural anti-fabrication, not model trust.
 *   - This module is PURE (no DB, no network, no LLM). The worker wires the LLM call + the
 *     non-destructive merge around it. Phase A runs locateExtractionInputs against the real
 *     bundle and eyeballs the windows before any chart write is enabled.
 *
 * Validated against the real Armand bundle (CLM-96CD9FDFCB): a 1,182-page Blue Button collapses
 * to a handful of header-anchored windows; the granted-SC list is NOT cleanly itemized in that
 * case (benefit-summary letter states only "70% combined"), so SC inputs draw from the small
 * rating-type docs whole and the worker flags "obtain rating decision" when none itemize grants.
 */

import { createHash } from 'node:crypto';

export type ExtractCategory = 'sc_condition' | 'active_problem' | 'active_medication';

export interface BundleDocumentPage {
  pageNumber: number;
  text: string;
  confidence?: number | null;
}

export interface BundleDocument {
  id: string;
  filename: string;
  docTag?: string | null;
  pages: BundleDocumentPage[];
}

/** A pre-isolated slice of one document's text, tagged with the pages it spans, fed to the LLM. */
export interface SectionWindow {
  documentId: string;
  filename: string;
  category: ExtractCategory;
  /** Page numbers this window covers, ascending. */
  pageNumbers: number[];
  /** Windowed text with inline [p.N] markers so the model returns the page with each item. */
  text: string;
  /** Which header anchored this window ('whole_document' for small docs sent entire). */
  headerMatched: string;
}

/** Docs at or under this many chars are sent whole rather than header-windowed. */
export const SMALL_DOC_CHARS = 25_000;
/** Hard cap on a single header-anchored window so one section can't balloon the LLM input. */
export const WINDOW_CAP_CHARS = 40_000;

/**
 * CONTENT anchors per category. These match against document TEXT only — never the filename.
 * Filenames have ZERO bearing on whether a document is read: a file called `image0.png` or
 * `document1` can hold the entire VA rating breakdown (Armand 2026-06-03 — his SC ratings arrived
 * as phone screenshots named image0-2.png and a filename gate skipped them). Every document's
 * content is reviewed for every category.
 *
 * SC patterns are intentionally broad — VA rating data appears as "Service-connected ratings",
 * "10% rating for lumbar strain", "rating decision", "combined ... evaluation", "service
 * connection for X is denied", etc. Over-matching is safe: the per-category LLM prompt + the
 * verbatim-quote grounding gate drop anything that isn't an actual rating entry.
 */
const HEADER_PATTERNS: Record<ExtractCategory, RegExp[]> = {
  sc_condition: [
    /service[- ]connected/i,
    /\b\d{1,3}\s*%\s*(?:rating|disabling|evaluation)/i,
    /\brating\s+for\b/i,
    /rating decision/i,
    /combined\s+.{0,30}evaluation/i,
    /service connection for/i,
    /individual ratings/i,
    /rated disabilit/i,
  ],
  active_problem: [
    /active problems?\s*[-:]/i,
    /computerized problem list/i,
    /problem list\b/i,
  ],
  active_medication: [
    /active\s+(?:out)?patient\s+medications?/i,
    /active\s+medications?\b/i,
  ],
};

function docCharCount(doc: BundleDocument): number {
  let n = 0;
  for (const p of doc.pages) n += p.text.length;
  return n;
}

/**
 * Build one window over a document's pages starting at the page containing `startCharInJoined`,
 * walking forward until WINDOW_CAP_CHARS or the next different header. Page-aware: tracks which
 * pageNumber each emitted line belongs to and prefixes [p.N] markers.
 */
function windowFromPages(
  doc: BundleDocument,
  category: ExtractCategory,
  headerRe: RegExp,
  headerMatched: string,
): SectionWindow | null {
  // Find the first page whose text matches the header.
  const startIdx = doc.pages.findIndex((p) => headerRe.test(p.text));
  if (startIdx < 0) return null;

  const pieces: string[] = [];
  const pageNumbers: number[] = [];
  let total = 0;
  for (let i = startIdx; i < doc.pages.length; i++) {
    const page = doc.pages[i]!;
    // Stop if a LATER page starts a different known structured section (avoid bleeding into the
    // next section). Only check pages after the first.
    if (i > startIdx) {
      const otherHeaders = Object.entries(HEADER_PATTERNS)
        .filter(([cat]) => cat !== category)
        .flatMap(([, res]) => res);
      if (otherHeaders.some((re) => re.test(page.text))) break;
    }
    if (total + page.text.length > WINDOW_CAP_CHARS && pieces.length > 0) break;
    pieces.push(`[p.${page.pageNumber}]\n${page.text}`);
    pageNumbers.push(page.pageNumber);
    total += page.text.length;
  }
  if (pieces.length === 0) return null;
  return {
    documentId: doc.id,
    filename: doc.filename,
    category,
    pageNumbers,
    text: pieces.join('\n'),
    headerMatched,
  };
}

/** Wrap a small doc's whole text as a single window, page-marked. */
function wholeDocWindow(doc: BundleDocument, category: ExtractCategory): SectionWindow {
  return {
    documentId: doc.id,
    filename: doc.filename,
    category,
    pageNumbers: doc.pages.map((p) => p.pageNumber),
    text: doc.pages.map((p) => `[p.${p.pageNumber}]\n${p.text}`).join('\n'),
    headerMatched: 'whole_document',
  };
}

const CATEGORIES: readonly ExtractCategory[] = ['sc_condition', 'active_problem', 'active_medication'];

/**
 * Decide which document slices to send to the LLM, per category. Deterministic, no model, and
 * NEVER keyed on filename — only on size + content.
 *   - SMALL docs (<= SMALL_DOC_CHARS): sent WHOLE to all three category extractors. Every small
 *     document is reviewed for every category regardless of name or type — a screenshot, a
 *     "document1.pdf", a benefit summary, all get read. Small docs are cheap and the per-category
 *     prompt + grounding gate discard anything not actually present, so over-inclusion is free
 *     insurance against ever skipping a document that holds the answer.
 *   - LARGE docs (e.g. a 1,182-page Blue Button) can't be sent whole three times, so they are
 *     windowed by CONTENT headers for each category. Still purely content-based.
 */
export function locateExtractionInputs(documents: BundleDocument[]): SectionWindow[] {
  const windows: SectionWindow[] = [];

  for (const doc of documents) {
    if (!doc.pages || doc.pages.length === 0) continue;
    const small = docCharCount(doc) <= SMALL_DOC_CHARS;

    for (const category of CATEGORIES) {
      if (small) {
        // Review the WHOLE small doc for this category. No filename gate, no content pre-filter —
        // the LLM reads it and returns nothing if there's nothing of this type.
        windows.push(wholeDocWindow(doc, category));
      } else {
        // Large doc: window by content header for this category (first match is enough).
        for (const re of HEADER_PATTERNS[category]) {
          const w = windowFromPages(doc, category, re, re.source);
          if (w) {
            windows.push(w);
            break;
          }
        }
      }
    }
  }

  return windows;
}

/**
 * Grounding gate: an extracted item is only valid if its verbatim quote appears on the cited page
 * of the cited document. Returns true iff grounded. The worker drops un-grounded items entirely
 * (requirement 1 — no source line, no item).
 */
export function groundExtractedItem(
  documents: BundleDocument[],
  item: { sourceDocumentId: string; sourcePage: number; sourceQuote: string },
): boolean {
  if (!item.sourceQuote || item.sourceQuote.trim().length < 3) return false;
  const doc = documents.find((d) => d.id === item.sourceDocumentId);
  if (!doc) return false;
  const page = doc.pages.find((p) => p.pageNumber === item.sourcePage);
  if (!page) return false;
  return normalizeForQuoteMatch(page.text).includes(normalizeForQuoteMatch(item.sourceQuote));
}

/** Normalize text for a tolerant verbatim-substring match (OCR whitespace/case noise). */
export function normalizeForQuoteMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalized dedup key for the non-destructive merge (keystone pkg 6 extends this layer — the
 * dedup correctness of planMerge lives HERE). Lowercase, collapse whitespace, strip trailing
 * punctuation, strip a trailing single-token parenthetical abbreviation ("(PTSD)"), strip
 * identity-neutral qualifier suffixes (", chronic"), then fold the synonym table — so the
 * CLM-A355D7A822 explosion ("PTSD" / "PTSD, chronic" / "Posttraumatic stress disorder (PTSD)")
 * collapses to ONE key. The worker uses (category + normalizeName) to skip manual + prior-auto rows.
 *
 * SCOPE GUARD — compound labels are NOT split: "PTSD and anxiety" is TWO conditions; splitting
 * on "and" would silently drop the anxiety. It stays its own honest row, deduping only against an
 * identical compound (decision (a), build plan pkg 6; the ICD-10/DC-keyed split is the explicitly
 * deferred later phase). Every synonym entry must be reviewed against false-merge: prefer
 * under-collapsing (a cosmetic dup row) to over-collapsing (a LOST condition — letter-correctness).
 */

/**
 * Trailing qualifier suffixes that don't change condition identity. Applied repeatedly so
 * "ptsd, chronic, unspecified" still reduces. Data-driven so the LATER ICD-10 model can supersede.
 */
const QUALIFIER_SUFFIXES: readonly string[] = [', chronic', ', acute', ', unspecified', ', nos', ' nos'];

/**
 * Synonym fold table (data-driven; the LATER ICD-10/DC-keyed model supersedes this). Keys are the
 * post-strip lowercase form; values are the canonical label. Direction notes:
 *   - abbreviation ↔ expansion entries (osa/htn/gerd/tbi/copd) are identity-safe.
 *   - PTSD spelling variants (posttraumatic / post traumatic / post-traumatic) are ONE condition.
 *   - mental-health umbrella: depression/MDD variants fold to major depressive disorder; anxiety
 *     variants fold to anxiety disorder. GAD is kept SEPARATE from bare "anxiety" (an anxiety-NOS
 *     row is not necessarily GAD — folding would over-claim a specific diagnosis).
 *   - dm2 folds; "diabetes mellitus type 1" deliberately has NO entry (must never fold into type 2).
 */
const NAME_SYNONYMS: Record<string, string> = {
  osa: 'obstructive sleep apnea',
  ptsd: 'post-traumatic stress disorder',
  'chronic post-traumatic stress disorder': 'post-traumatic stress disorder',
  'posttraumatic stress disorder': 'post-traumatic stress disorder',
  'post traumatic stress disorder': 'post-traumatic stress disorder',
  htn: 'hypertension',
  dm2: 'diabetes mellitus type 2',
  'diabetes mellitus, type 2': 'diabetes mellitus type 2',
  'type 2 diabetes mellitus': 'diabetes mellitus type 2',
  hld: 'hyperlipidemia',
  mdd: 'major depressive disorder',
  'major depression': 'major depressive disorder',
  depression: 'major depressive disorder',
  'depressive disorder': 'major depressive disorder',
  anxiety: 'anxiety disorder',
  'anxiety state': 'anxiety disorder',
  gad: 'generalized anxiety disorder',
  gerd: 'gastroesophageal reflux disease',
  'gastro-esophageal reflux disease': 'gastroesophageal reflux disease',
  tbi: 'traumatic brain injury',
  copd: 'chronic obstructive pulmonary disease',
};

/**
 * Strip ONE trailing parenthetical abbreviation: a single token of 2-12 letters/digits with no
 * internal spaces — "(ptsd)", "(gerd)", "(copd)". A spaced parenthetical like "(type 2)" is NOT
 * stripped (it can be identity-bearing). Anchored at end-of-string so a mid-name parenthetical
 * survives.
 */
function stripTrailingAbbrevParen(s: string): string {
  return s.replace(/\s*\([a-z0-9&./-]{2,12}\)$/, '').trim();
}

export function normalizeName(name: string): string {
  let base = name.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
  // Reduce to a fixed point: qualifier and parenthetical strips can unmask each other
  // ("posttraumatic stress disorder (ptsd), chronic" needs the paren strip AFTER ", chronic").
  let prev: string;
  do {
    prev = base;
    base = stripTrailingAbbrevParen(base).replace(/[.,;:]+$/, '').trim();
    for (const suffix of QUALIFIER_SUFFIXES) {
      if (base.endsWith(suffix)) base = base.slice(0, -suffix.length).replace(/[.,;:]+$/, '').trim();
    }
  } while (base !== prev);
  return NAME_SYNONYMS[base] ?? base;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FULL-READ CHUNKER (PR-1, behind CHART_EXTRACT_FULLREAD). The header-windower above MISSES items
// that live outside a matched section or past WINDOW_CAP_CHARS — on a 1,182-page Blue Button a
// service-connected grant stated once deep in the rating decision never reaches the LLM (Woodley
// F43.8 70% SC). The chunker instead reads EVERY page: it splits each document into overlapping,
// page-boundary chunks sized to a char budget, and the worker runs ONE combined-category pass per
// chunk (the model tags each item's category) then dedups across chunks. Pure: no model, no I/O.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A complete-read slice of one document spanning a contiguous page range (category-agnostic). */
export interface DocumentChunk {
  documentId: string;
  filename: string;
  /** Page numbers this chunk covers, ascending. */
  pageNumbers: number[];
  /** Page-marked text ([p.N] prefixes) so the model cites the page + the grounding gate can verify. */
  text: string;
  /** Global, stable index across all documents — used to order raw items deterministically. */
  chunkIndex: number;
}

/** Char budget per chunk (~12K input tokens for Sonnet). Whole pages only — never split mid-page,
 *  EXCEPT a single page that ALONE exceeds the budget (see splitOversizedPage). */
export const CHUNK_CHARS = 48_000;
/** Re-include the last N pages of the prior chunk so an item straddling a page boundary isn't lost. */
export const CHUNK_OVERLAP_PAGES = 1;

/**
 * OVERSIZED-PAGE CAP (2026-06-23). A VA Blue Button .txt can carry 65k–80k-char PAGES. The chunker
 * used to "always take at least one page even if it alone exceeds the budget" → that one giant page
 * became a single ~20k-output-token chunk that, being a single unsplittable page, FORCED the
 * extractOneChunk escalation to the 32k output ceiling (and, before the streaming fix, crashed the
 * whole run). This splits a single page whose marked text exceeds CHAR_OFFSET_SPLIT into contiguous
 * char-offset slices, each re-prefixed with the SAME [p.N] marker so provenance/grounding still work
 * (groundExtractedItem matches the sourceQuote against the WHOLE page.text, so a quote inside any one
 * slice still grounds). Normal-sized pages return a single [marked] piece — behavior UNCHANGED. The
 * split point is a char offset, NOT a token boundary, and we accept that a quote straddling a slice
 * boundary may not ground in that one slice; the slices overlap by SPLIT_OVERLAP_CHARS to make a
 * boundary-straddling line recoverable, mirroring the page-overlap rationale. Pure.
 */
const CHAR_OFFSET_SPLIT = CHUNK_CHARS; // a page longer than one chunk budget gets sliced
const SPLIT_OVERLAP_CHARS = 2_000; // re-include the tail of the prior slice so a boundary line isn't lost

/** Split ONE page's marked text into <=CHAR_OFFSET_SPLIT char slices, each carrying the [p.N] marker.
 *  Returns a single-element array for a normal page (no behavior change). Exported for unit testing. */
export function splitOversizedPage(pageNumber: number, marked: string): string[] {
  if (marked.length <= CHAR_OFFSET_SPLIT) return [marked];
  const header = `[p.${pageNumber}]\n`;
  // Strip the leading marker, slice the body, re-prefix every slice so each chunk cites the page.
  const body = marked.startsWith(header) ? marked.slice(header.length) : marked;
  const slices: string[] = [];
  const step = CHAR_OFFSET_SPLIT - header.length - SPLIT_OVERLAP_CHARS;
  for (let off = 0; off < body.length; off += step) {
    const piece = body.slice(off, off + (CHAR_OFFSET_SPLIT - header.length));
    slices.push(`${header}${piece}`);
    if (off + (CHAR_OFFSET_SPLIT - header.length) >= body.length) break;
  }
  return slices;
}

/**
 * Dedupe BYTE-IDENTICAL-CONTENT documents before extraction (Ryan 2026-06-17 cost-safety: "there
 * should never be a need to process the same file twice ... make a way to not process identical
 * files"). The same file uploaded twice (Woodley CLM-B543F8D0BD: Misc_2.pdf == Misc_3.pdf, byte-
 * identical) would otherwise each be chunked and sent to the model — doubling the EXPENSIVE extract
 * leg AND double-counting items into the bundle. Key on a sha256 of the document's CONCATENATED PAGE
 * TEXT (content, not filename), keep the FIRST occurrence (input order is deterministic), drop later
 * identical ones. Empty/no-page docs are passed through untouched (the chunker skips them anyway and
 * we never want to collapse two unread files into one). NEVER silent — the caller logs every drop.
 * The survivor's pages fully cover the dropped twin's content, so chunking/coverage/grounding stay
 * correct when computed over the KEPT set. Pure + unit-tested. (NOTE: this dedups the extract leg;
 * the upstream OCR re-read of an identical UPLOAD is separately bounded by ocr-start reserved
 * concurrency + the vision spend alarm — the full upload/OCR-side skip is a specced follow-up.)
 */
export function dedupeIdenticalDocuments(
  documents: BundleDocument[],
): { kept: BundleDocument[]; dropped: { id: string; filename: string; duplicateOfId: string }[] } {
  const firstByContent = new Map<string, BundleDocument>();
  const kept: BundleDocument[] = [];
  const dropped: { id: string; filename: string; duplicateOfId: string }[] = [];
  for (const doc of documents) {
    const content = (doc.pages ?? []).map((p) => p.text).join('\n');
    if (content.trim().length === 0) { kept.push(doc); continue; } // no readable content → never collapse
    const hash = createHash('sha256').update(content).digest('hex');
    const first = firstByContent.get(hash);
    if (first) { dropped.push({ id: doc.id, filename: doc.filename, duplicateOfId: first.id }); continue; }
    firstByContent.set(hash, doc);
    kept.push(doc);
  }
  return { kept, dropped };
}

/**
 * Split every document into overlapping page-boundary chunks covering ALL pages. A single page
 * larger than CHUNK_CHARS becomes its own chunk (never dropped). Deterministic: chunkIndex is
 * assigned in document then page order, so raw items collected in chunk order are already stable.
 */
export function chunkDocuments(documents: BundleDocument[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let globalIdx = 0;
  for (const doc of documents) {
    if (!doc.pages || doc.pages.length === 0) continue;
    const pages = doc.pages;
    let i = 0;
    while (i < pages.length) {
      const firstPage = pages[i]!;
      const firstMarked = `[p.${firstPage.pageNumber}]\n${firstPage.text}`;
      // OVERSIZED SINGLE PAGE: a page that ALONE exceeds the budget is sliced by char offset (each
      // slice keeps the same [p.N] marker) so no chunk forces the 32k-output escalation. Each slice
      // becomes its OWN chunk covering that one page; advance past the page (no page-overlap step —
      // the slice overlap already covers boundary lines within the page).
      if (firstMarked.length > CHUNK_CHARS) {
        for (const slice of splitOversizedPage(firstPage.pageNumber, firstMarked)) {
          chunks.push({ documentId: doc.id, filename: doc.filename, pageNumbers: [firstPage.pageNumber], text: slice, chunkIndex: globalIdx++ });
        }
        i = i + 1;
        continue;
      }
      const pieces: string[] = [];
      const pageNumbers: number[] = [];
      let total = 0;
      let j = i;
      while (j < pages.length) {
        const page = pages[j]!;
        const marked = `[p.${page.pageNumber}]\n${page.text}`;
        // A later page that alone exceeds the budget ends THIS chunk; it is handled as an oversized
        // single page on the next outer iteration (so it gets char-sliced, not jammed in whole).
        if (j > i && marked.length > CHUNK_CHARS) break;
        // Always take at least one page, even if it alone exceeds the budget (handled above for j===i).
        if (total + marked.length > CHUNK_CHARS && pieces.length > 0) break;
        pieces.push(marked);
        pageNumbers.push(page.pageNumber);
        total += marked.length;
        j++;
      }
      chunks.push({ documentId: doc.id, filename: doc.filename, pageNumbers, text: pieces.join('\n'), chunkIndex: globalIdx++ });
      if (j >= pages.length) break;
      // Advance to the next window, stepping back CHUNK_OVERLAP_PAGES for boundary overlap. The
      // max(i+1, …) guarantees forward progress even when a single oversized page filled the chunk.
      i = Math.max(i + 1, j - CHUNK_OVERLAP_PAGES);
    }
  }
  return chunks;
}

/**
 * Coverage check: every page of every document must appear in at least one chunk. Returns the list
 * of uncovered { documentId, pageNumber } (empty = full coverage). The worker logs any gap LOUD —
 * a missed page is a silent extraction hole, the exact failure class this rebuild exists to kill.
 */
export function uncoveredPages(documents: BundleDocument[], chunks: DocumentChunk[]): { documentId: string; pageNumber: number }[] {
  const covered = new Set<string>();
  for (const c of chunks) for (const p of c.pageNumbers) covered.add(`${c.documentId}#${p}`);
  const gaps: { documentId: string; pageNumber: number }[] = [];
  for (const doc of documents) for (const p of doc.pages ?? []) {
    if (!covered.has(`${doc.id}#${p.pageNumber}`)) gaps.push({ documentId: doc.id, pageNumber: p.pageNumber });
  }
  return gaps;
}

/**
 * Split a chunk's page-marked text into two halves at a [p.N] boundary nearest the midpoint, for
 * the truncation split-retry. Returns null when the chunk holds a single page (can't split without
 * orphaning the page marker — the caller accepts the truncation + logs loud instead). Each half
 * keeps its own [p.N] markers so grounding still works.
 */
export function splitChunkText(text: string): [string, string] | null {
  const markers: number[] = [];
  const re = /(^|\n)\[p\.\d+\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) markers.push(m.index === 0 ? 0 : m.index + 1); // index of '['
  if (markers.length < 2) return null;
  const mid = text.length / 2;
  let best = markers[1]!; // never split before the first page
  for (const idx of markers) {
    if (idx === 0) continue;
    if (Math.abs(idx - mid) < Math.abs(best - mid)) best = idx;
  }
  return [text.slice(0, best).trimEnd(), text.slice(best)];
}

/** Confidence gate thresholds (Ryan chose AUTO-FILL: write high-confidence; flag the middle band). */
export const CONFIDENCE_AUTOFILL = 0.85;
export const CONFIDENCE_FLOOR = 0.6;

export type ConfidenceDisposition = 'autofill' | 'needs_review' | 'drop';

export function dispositionForConfidence(confidence: number): ConfidenceDisposition {
  if (confidence >= CONFIDENCE_AUTOFILL) return 'autofill';
  if (confidence >= CONFIDENCE_FLOOR) return 'needs_review';
  return 'drop';
}

/** First 4-digit year found across the given dates, '' if none (year-granularity: OCR'd VA dates
 *  are unreliable at day precision and a day-level key would shatter true duplicates). */
export function yearOf(...dates: (string | undefined)[]): string {
  for (const d of dates) { const m = d?.match(/\b(?:19|20)\d{2}\b/); if (m) return m[0]; }
  return '';
}

/**
 * Shared dedup key for both the extract-time dedup (groundAndDispose) and the write-time merge
 * (planMerge), so they can never drift. Conditions/problems key on (category, normalizedName) —
 * UNCHANGED. MEDS additionally key on medStatus + start/last-seen year, so chunk-overlap copies of
 * one drug collapse but a treatment TIMELINE survives (active vs historical, 2015 vs 2022). The
 * medStatus default is 'active' to MATCH the active_medications.med_status column default, so an
 * extracted med with no status keys the same as the row it will be stored as. normalizeName is NOT
 * touched (test-locked + shared with conditions/problems).
 */
export interface DedupKeyInput {
  category: ExtractCategory;
  name: string;
  medStatus?: string | null;
  startDate?: string | null;
  lastSeenDate?: string | null;
}
export function chartDedupKey(it: DedupKeyInput): string {
  const base = `${it.category}::${normalizeName(it.name)}`;
  if (it.category !== 'active_medication') return base;
  return `${base}::${it.medStatus ?? 'active'}::${yearOf(it.startDate ?? undefined, it.lastSeenDate ?? undefined)}`;
}
