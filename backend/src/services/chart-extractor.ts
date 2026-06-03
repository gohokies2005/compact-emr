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
 * Normalized dedup key for the non-destructive merge. Lowercase, collapse whitespace, strip
 * trailing punctuation, and fold a small synonym set so "OSA" and "Obstructive sleep apnea"
 * dedup together. The worker uses (category + normalizeName) to skip manual + prior-auto rows.
 */
const NAME_SYNONYMS: Record<string, string> = {
  osa: 'obstructive sleep apnea',
  ptsd: 'post-traumatic stress disorder',
  'chronic post-traumatic stress disorder': 'post-traumatic stress disorder',
  htn: 'hypertension',
  dm2: 'diabetes mellitus type 2',
  hld: 'hyperlipidemia',
};

export function normalizeName(name: string): string {
  const base = name.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
  return NAME_SYNONYMS[base] ?? base;
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
