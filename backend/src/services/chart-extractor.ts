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
 * Header anchors per category. Problem List and Medications have tight, consistent VA headers.
 * SC grants deliberately have NO Blue-Button anchor: "service-connected" appears dozens of times
 * in prose, so windowing it surfaces noise. Granted SCs come from the small rating-type docs
 * (handled in locateExtractionInputs), never from windowing the Blue Button narrative.
 */
const HEADER_PATTERNS: Record<Exclude<ExtractCategory, 'sc_condition'>, RegExp[]> = {
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

/** Filename heuristics for the small rating-type docs that carry granted SC conditions. */
const SC_SOURCE_FILENAME = /(rating\s*decision|benefit\s*summary|code\s*sheet|disabilit|award)/i;
/** A denial doc names the CLAIMED (often denied) condition — useful context, status=denied. */
const DENIAL_FILENAME = /(denial|denied|decision)/i;

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

/**
 * Decide, per category, which document slices to send to the LLM. Deterministic, no model.
 *   - active_problem / active_medication: header-window large docs; send small clinical docs whole.
 *   - sc_condition: send the small rating-type docs (benefit summary / rating decision / denial)
 *     whole — never window the Blue Button prose for grants.
 */
export function locateExtractionInputs(documents: BundleDocument[]): SectionWindow[] {
  const windows: SectionWindow[] = [];

  for (const doc of documents) {
    if (!doc.pages || doc.pages.length === 0) continue;
    const size = docCharCount(doc);
    const small = size <= SMALL_DOC_CHARS;

    // ---- Problems + Medications ----
    for (const category of ['active_problem', 'active_medication'] as const) {
      if (small) {
        // Small docs: only include if they actually mention the section (avoids feeding a DD-214
        // into the meds parser). Cheap relevance gate.
        const anyHeader = HEADER_PATTERNS[category].some((re) =>
          doc.pages.some((p) => re.test(p.text)),
        );
        if (anyHeader) windows.push(wholeDocWindow(doc, category));
      } else {
        for (const re of HEADER_PATTERNS[category]) {
          const w = windowFromPages(doc, category, re, re.source);
          if (w) {
            windows.push(w);
            break; // first matching header per category per doc is enough
          }
        }
      }
    }

    // ---- SC conditions (granted) ----
    // Only from small rating-type / benefit-summary / denial docs, sent whole.
    if (small && (SC_SOURCE_FILENAME.test(doc.filename) || DENIAL_FILENAME.test(doc.filename))) {
      windows.push(wholeDocWindow(doc, 'sc_condition'));
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
