import type { KeyDocClassification, KeyDocType } from './db-types.js';
import { isIntakeSummaryPath } from './chart-readiness.js';

/**
 * Phase 7B: classify a record filename into a Doctor Pack signal tier + a specific doc_type.
 *
 * Ported (concept + pattern set) from FRN `app/services/keyDocsClassifier.js` (commit
 * 2026-05-17, Ricchezza TERA-miss). Three-tier classification:
 *   - high_signal: load full text into every AI context; include EVERY page in Doctor Pack.
 *     "EVERY INCH OF PAST DENIAL LETTERS, DBQs, C&P EXAMS MUST BE REFERENCED IN THEIR
 *     ENTIRETY." (Ryan 2026-05-17 HARD RULE — Ricchezza incident; Phase 7B locks this in.)
 *   - bulk: 200K+ word bundles (Blue Button, full health records). Subject to summarization
 *     for AI context; included in Doctor Pack only when downstream IMO cites them.
 *   - normal: default. Per-file budget cap; included in Doctor Pack at importance >= 50.
 *
 * On top of classification, we attach a structured `docType` label so the Doctor Pack
 * assembler can rank documents (e.g. rating_decision > c_and_p_exam > dbq > nexus_letter_prior).
 */

interface PatternMatcher {
  readonly pattern: RegExp;
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly importance: number; // 0-100; higher = more important
}

const PATTERNS: readonly PatternMatcher[] = [
  // ===== HIGH-SIGNAL: rating + decision documents =====
  { pattern: /claim.?letter/i,              docType: 'rating_decision',          classification: 'high_signal', importance: 100 },
  { pattern: /rating.?decision/i,           docType: 'rating_decision',          classification: 'high_signal', importance: 100 },
  { pattern: /rated.?disabilit/i,           docType: 'rated_disabilities_view',  classification: 'high_signal', importance: 95 },
  { pattern: /disability.?rating/i,         docType: 'rated_disabilities_view',  classification: 'high_signal', importance: 95 },
  { pattern: /view.?your.?va.?disability/i, docType: 'rated_disabilities_view',  classification: 'high_signal', importance: 95 },
  { pattern: /combined.?rating/i,           docType: 'rated_disabilities_view',  classification: 'high_signal', importance: 90 },
  { pattern: /denial.?letter/i,             docType: 'denial_letter',            classification: 'high_signal', importance: 100 },
  { pattern: /sup(plemental)?.?claim.?(decision|letter)/i, docType: 'supplemental_decision', classification: 'high_signal', importance: 95 },
  { pattern: /benefit.?summary/i,           docType: 'benefit_summary',          classification: 'high_signal', importance: 85 },

  // ===== HIGH-SIGNAL: clinical exams + DBQs =====
  // Note: JS regex \b treats underscore as a word character, so DBQ_OSA / CandP_Exam etc. need
  // explicit non-alphanumeric boundary patterns rather than \b. (?:^|[\W_]) / (?:[\W_]|$) handle
  // both filesystem separators (underscores, hyphens, dots, slashes) and string boundaries.
  { pattern: /(?:^|[\W_])dbq(?:[\W_]|$)/i,                  docType: 'dbq',                      classification: 'high_signal', importance: 90 },
  { pattern: /c[._-]?and[._-]?p(?:[\W_]|$)/i,               docType: 'c_and_p_exam',             classification: 'high_signal', importance: 90 },
  { pattern: /c[._-]?p[._-]?exam/i,                         docType: 'c_and_p_exam',             classification: 'high_signal', importance: 90 },
  { pattern: /c&p(?:[\W_]|$)/i,                             docType: 'c_and_p_exam',             classification: 'high_signal', importance: 90 },
  { pattern: /compensation.?and.?pension/i,                 docType: 'c_and_p_exam',             classification: 'high_signal', importance: 90 },

  // ===== HIGH-SIGNAL: toxic exposure docs =====
  { pattern: /tera.?memo/i,                                 docType: 'tera_memo',                classification: 'high_signal', importance: 95 },
  { pattern: /individual.?exposure.?summary/i,              docType: 'individual_exposure_summary', classification: 'high_signal', importance: 95 },
  { pattern: /(?:^|[\W_])iles?(?:[\W_]|$)/i,                docType: 'individual_exposure_summary', classification: 'high_signal', importance: 90 },
  { pattern: /(?:^|[\W_])ies(?:[\W_]|$)/i,                  docType: 'individual_exposure_summary', classification: 'high_signal', importance: 90 },

  // ===== HIGH-SIGNAL: prior nexus / IMOs =====
  // Assessment 2026-06-12 §2: the bare /nexus/i subsumes the old nexus.?letter / nexus.?opinion
  // forms — real uploads arrive as "Jr_AAD_Nexus.pdf" and the stricter forms missed them.
  // Importance is MODEST (~70): a PRIOR nexus letter is context for the physician, not primary
  // evidence; the include-policy is small-doc-all via the page-selector's SMALL_DOC_ALWAYS_ALL
  // set (these run 1-3pp), so modest importance never costs us the document itself.
  { pattern: /nexus/i,                      docType: 'nexus_letter_prior',       classification: 'high_signal', importance: 70 },
  { pattern: /medical.?opinion/i,           docType: 'medical_opinion',          classification: 'high_signal', importance: 75 },
  { pattern: /imo[._-]/i,                   docType: 'medical_opinion',          classification: 'high_signal', importance: 75 },

  // ===== HIGH-SIGNAL: service + military records =====
  { pattern: /dd[._-]?214/i,                                docType: 'dd_214',                   classification: 'high_signal', importance: 95 },
  { pattern: /personnel.?record/i,                          docType: 'personnel_record',         classification: 'high_signal', importance: 75 },
  { pattern: /service.?treatment.?record.?summary/i,        docType: 'service_treatment_record_summary', classification: 'high_signal', importance: 80 },
  { pattern: /separation.?exam/i,                           docType: 'separation_exam',          classification: 'high_signal', importance: 85 },
  { pattern: /entrance.?exam/i,                             docType: 'entrance_exam',            classification: 'high_signal', importance: 85 },

  // ===== HIGH-SIGNAL: condition-specific clinical evidence =====
  { pattern: /audiogram/i,                                  docType: 'audiogram',                classification: 'high_signal', importance: 80 },
  { pattern: /polysomnogr/i,                                docType: 'sleep_study',              classification: 'high_signal', importance: 80 },
  { pattern: /sleep.?study/i,                               docType: 'sleep_study',              classification: 'high_signal', importance: 80 },
  { pattern: /(?:^|[\W_])psg(?:[\W_]|$)/i,                  docType: 'sleep_study',              classification: 'high_signal', importance: 80 },
  { pattern: /(?:^|[\W_])pft(?:[\W_]|$)/i,                  docType: 'pulmonary_function_test',  classification: 'high_signal', importance: 80 },
  { pattern: /pulmonary.?function/i,                        docType: 'pulmonary_function_test',  classification: 'high_signal', importance: 80 },

  // ===== HIGH-SIGNAL: veteran-authored statements =====
  { pattern: /statement.?in.?support/i,     docType: 'statement_in_support',     classification: 'high_signal', importance: 70 },
  { pattern: /lay.?statement/i,             docType: 'lay_statement',            classification: 'high_signal', importance: 70 },
  { pattern: /buddy.?statement/i,           docType: 'buddy_statement',          classification: 'high_signal', importance: 70 },
  // Chunk D (2026-06-11): commanding-officer / command letters are statements (small-doc-all in
  // the selector). No dedicated docType - Ryan's spec treats them as buddy statements ("in-service
  // documentation ... CO letter"). Matches "CO_Letter.pdf", "Commanding_Officer_Statement.pdf".
  { pattern: /(?:^|[\W_])co[\W_]?letter/i,                  docType: 'buddy_statement',          classification: 'high_signal', importance: 70 },
  { pattern: /command(?:ing)?[\W_]?(officer|letter|statement)/i, docType: 'buddy_statement',     classification: 'high_signal', importance: 70 },

  // ===== HIGH-SIGNAL: imaging / radiology (Chunk D - Ryan's "most recent/pertinent imaging") =====
  { pattern: /(?:^|[\W_])mri(?:[\W_]|$)/i,                  docType: 'imaging',                  classification: 'high_signal', importance: 75 },
  { pattern: /(?:^|[\W_])ct[\W_]?scan/i,                    docType: 'imaging',                  classification: 'high_signal', importance: 75 },
  { pattern: /x[\W_]?ray/i,                                 docType: 'imaging',                  classification: 'high_signal', importance: 75 },
  { pattern: /radiolog/i,                                   docType: 'imaging',                  classification: 'high_signal', importance: 75 },
  { pattern: /ultrasound/i,                                 docType: 'imaging',                  classification: 'high_signal', importance: 75 },
  { pattern: /imaging/i,                                    docType: 'imaging',                  classification: 'high_signal', importance: 75 },

  // ===== Intake summary (our own generated intake-form summary) =====
  { pattern: /intake[\W_]?(form|summary)/i,                 docType: 'intake_summary',           classification: 'high_signal', importance: 65 },

  // ===== BULK: long-tail bundles (summarized for AI; included in Doctor Pack only on direct citation) =====
  { pattern: /blue[\s_-]*button/i,          docType: 'blue_button',              classification: 'bulk', importance: 30 },
  { pattern: /full.?health.?record/i,       docType: 'blue_button',              classification: 'bulk', importance: 30 },
  { pattern: /complete.?medical.?record/i,  docType: 'blue_button',              classification: 'bulk', importance: 30 },
  { pattern: /progress.?notes/i,            docType: 'progress_notes',           classification: 'bulk', importance: 35 },
];

export interface ClassificationResult {
  readonly classification: KeyDocClassification;
  readonly docType: KeyDocType;
  readonly importance: number;
  readonly matchedPattern: string | null;
}

/**
 * Classify a filename. The first matching pattern wins (HIGH-SIGNAL patterns are listed first
 * so they take precedence over BULK matches when both could match — preserves the FRN HARD RULE
 * that "claim_letter" inside a "blue_button" bundle name still classifies as high-signal).
 *
 * Returns `'normal'` / `'unspecified'` / `importance=50` when no pattern matches — a generic
 * default that places the document mid-pack.
 */
export function classifyFile(filePath: string): ClassificationResult {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { classification: 'normal', docType: 'unspecified', importance: 0, matchedPattern: null };
  }
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  for (const matcher of PATTERNS) {
    if (matcher.pattern.test(base)) {
      return {
        classification: matcher.classification,
        docType: matcher.docType,
        importance: matcher.importance,
        matchedPattern: matcher.pattern.source,
      };
    }
  }
  return { classification: 'normal', docType: 'unspecified', importance: 50, matchedPattern: null };
}

/**
 * INGEST_OCR_SPEC requirement #6 (2026-05-25): classify documents by CONTENT, not filename.
 * Veterans name files arbitrarily — "back pages for va letters.pdf" can be a rating decision;
 * filename-based classification gets these wrong.
 *
 * Resolution path:
 *   1. If the worker provides a content-derived `contentHint` (from Textract/BDA classification
 *      of the extracted text), use it. Importance gets a +5 boost over the filename heuristic
 *      because content-based labels are more trustworthy.
 *   2. Otherwise fall back to filename classification (the LEGACY path; still useful when
 *      content classification is unavailable or low-confidence).
 *
 * The contentHint shape is `{ docType, classification, confidence }`; the worker decides
 * when to omit it (low Textract/BDA confidence -> trust filename instead).
 */
export interface ContentClassificationHint {
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly confidence: number; // 0..1; treat <0.6 as "use filename instead"
}

const CONTENT_HINT_MIN_CONFIDENCE = 0.6;
// At/above this confidence a content guess is "certain" (a phrase that essentially only appears in
// that artifact — the 0.9 tier in CONTENT_PATTERNS) and OVERRIDES even an explicit filename match.
// Below it, an explicit high-signal filename wins the tie-break (see classifyFileWithContentHint).
const CONTENT_HINT_HIGH_CONFIDENCE = 0.9;

// Canonical per-docType importance for CONTENT-classified documents, derived from the filename
// pattern table (max importance per docType). Chunk D fix: the prior `max(filenameImportance, 50)+5`
// gave a content-classified rating decision inside "Misc_3.pdf" importance 55 - below a filename-
// classified audiogram (80) - which inverted every downstream ranking (manifest sort, budget trim).
const DOCTYPE_BASE_IMPORTANCE: ReadonlyMap<KeyDocType, number> = (() => {
  const m = new Map<KeyDocType, number>();
  for (const p of PATTERNS) {
    m.set(p.docType, Math.max(m.get(p.docType) ?? 0, p.importance));
  }
  return m;
})();

export function classifyFileWithContentHint(
  filePath: string,
  contentHint: ContentClassificationHint | null | undefined,
): ClassificationResult {
  if (contentHint && contentHint.confidence >= CONTENT_HINT_MIN_CONFIDENCE) {
    const filenameResult = classifyFile(filePath);
    // Filename tie-break (assessment 2026-06-26 §3): when the FILENAME is an explicit high-signal
    // match (a specific docType, e.g. "Denial_Letter.pdf") and a MID-confidence content guess
    // (< 0.9) DISAGREES with it, trust the filename. A veteran who names a file "Denial_Letter.pdf"
    // is giving a deliberate, high-quality signal; a 0.7 content guess that says otherwise is more
    // likely an OCR/phrasing artifact (a denial letter's body quotes "...is service-connected...",
    // a DBQ cites AHI, etc.). A 0.9 content guess (a phrase essentially unique to one artifact)
    // still wins — those are near-certain. Pinned in key-docs-classifier.test.ts.
    const filenameIsExplicit =
      filenameResult.classification === 'high_signal' && filenameResult.docType !== 'unspecified';
    const disagrees = filenameResult.docType !== contentHint.docType;
    if (filenameIsExplicit && disagrees && contentHint.confidence < CONTENT_HINT_HIGH_CONFIDENCE) {
      return filenameResult;
    }
    // Content-derived classification supersedes filename. Importance: the docType's canonical
    // importance (so "Misc_3.pdf" content-classified as rating_decision ranks like a rating
    // decision, not like a generic upload), never below what the filename already earned,
    // +5 content boost, capped at 100.
    const canonical = DOCTYPE_BASE_IMPORTANCE.get(contentHint.docType) ?? 50;
    return {
      classification: contentHint.classification,
      docType: contentHint.docType,
      importance: Math.min(100, Math.max(filenameResult.importance, canonical) + 5),
      matchedPattern: 'content_classification',
    };
  }
  return classifyFile(filePath);
}

/**
 * Chunk D (2026-06-11): content-TEXT classification - THE production fix for the filename-only
 * curation bug. Real veteran uploads arrive as Misc_1.pdf...Misc_12.pdf, so classifyFile()
 * returned 'unspecified' for everything, the first-8-pages rule fired for every doc, and the
 * page-selector's entire VA-letter/statement/STR rule set never ran. This derives a
 * ContentClassificationHint from the document's own first pages of OCR text (document_pages
 * rows - populated for every current-era upload by the intake parse copy-forward).
 *
 * Deterministic, ordered, first-match-wins. Confidence encodes pattern strength:
 *   0.9 - a phrase that essentially only ever appears in that artifact (DD-214 certificate
 *         line, "we have made a decision on your claim", VA Form 21-4138 header).
 *   0.7 - strong but conceivably-quotable phrasing (denial verbs, DBQ title, STR markers).
 * Both clear CONTENT_HINT_MIN_CONFIDENCE (0.6); the two tiers exist so a future caller can
 * distinguish "certain" from "probable" without re-deriving.
 *
 * ORDER MATTERS: decision letters are checked before imaging because a C&P exam or rating
 * narrative can contain "findings:"; grant phrasings before denial (a mixed grant+denial
 * letter is a rating_decision - the selector keeps both kinds of decision pages either way).
 */
interface ContentPatternMatcher {
  readonly test: (text: string) => boolean;
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly confidence: number;
}

const reTest = (r: RegExp) => (text: string) => r.test(text);
const allOf = (...rs: RegExp[]) => (text: string) => rs.every((r) => r.test(text));
const anyOf = (...rs: RegExp[]) => (text: string) => rs.some((r) => r.test(text));

// nexus_letter_prior content markers (assessment 2026-06-12 §2). The title/citation phrases
// ("nexus letter", "independent medical opinion") plus the signature sentence every private
// IMO carries ("it is my [independent] medical opinion"). C_AND_P_EXAM_MARKERS is the negative
// guard: those phrases appear on VA C&P exams/DBQs — which also say "medical opinion" — and
// essentially never on a private nexus letter, so their presence routes the doc to the C&P/DBQ
// matchers instead.
const NEXUS_LETTER_PHRASES = /\b(nexus|independent medical) (letter|opinion)\b/i;
const NEXUS_OPINION_SENTENCE = /it is my (independent )?medical opinion/i;
const C_AND_P_EXAM_MARKERS = /compensation\s*(and|&)\s*pension|c\s*&\s*p\s*examination|disability benefits questionnaire/i;

const CONTENT_PATTERNS: readonly ContentPatternMatcher[] = [
  // Rating decision (grant or mixed). "We have made a decision on your claim" is the canonical
  // VA decision-letter opener; "Reasons for Decision" is its section header; entitlement/
  // evaluation verbs cover the decision-table phrasings.
  { test: reTest(/we (have )?made a decision on your (claim|appeal)/i), docType: 'rating_decision', classification: 'high_signal', confidence: 0.9 },
  { test: reTest(/reasons? for decision/i), docType: 'rating_decision', classification: 'high_signal', confidence: 0.9 },
  { test: reTest(/entitlement to .{0,80}\bis (established|granted)/i), docType: 'rating_decision', classification: 'high_signal', confidence: 0.9 },
  { test: reTest(/evaluation of .{0,120}\bis (continued|increased|decreased|assigned)/i), docType: 'rating_decision', classification: 'high_signal', confidence: 0.9 },
  { test: allOf(/rating decision/i, /service[\s-]?connect/i), docType: 'rating_decision', classification: 'high_signal', confidence: 0.7 },

  // Denial letter. Checked AFTER the grant phrasings (see ORDER MATTERS above).
  { test: reTest(/entitlement to .{0,80}\bis (denied|not established)/i), docType: 'denial_letter', classification: 'high_signal', confidence: 0.9 },
  { test: anyOf(/we (have )?denied your claim/i, /we (are denying|cannot grant) (your claim|service connection)/i), docType: 'denial_letter', classification: 'high_signal', confidence: 0.9 },
  { test: allOf(/service[\s-]?connect/i, /\bis denied\b/i), docType: 'denial_letter', classification: 'high_signal', confidence: 0.7 },

  // DD-214 - the certificate line is unique to the form. MOVED to AFTER the denial block
  // (assessment 2026-06-26 §3): a combined bundle (a DD-214 stapled in front of a denial letter,
  // a common veteran upload) carries BOTH the certificate line AND the denial verbs; the denial
  // is the document the physician needs surfaced as a decision, so the denial matchers must win.
  // A STANDALONE DD-214 has no decision phrasing, so it still lands here. Pinned both ways in
  // key-docs-classifier.test.ts.
  { test: reTest(/certificate of release or discharge from active duty/i), docType: 'dd_214', classification: 'high_signal', confidence: 0.9 },

  // Rated-disabilities view / benefit summary (va.gov self-service pages the veteran prints).
  // Checked AFTER the rating_decision + denial blocks so a real decision letter (which also lists
  // rated disabilities and says "service-connected") stays a rating_decision. PHRASE-ANCHORED on
  // the page chrome ("your rated disabilities", the rated-disabilities table triad, benefit-summary
  // phrasing) — NEVER on bare "service-connected", which appears on nearly every VA document.
  { test: reTest(/your rated disabilities/i), docType: 'rated_disabilities_view', classification: 'high_signal', confidence: 0.9 },
  { test: allOf(/rated disabilities/i, /effective date/i, /combined (?:disability )?rating/i), docType: 'rated_disabilities_view', classification: 'high_signal', confidence: 0.7 },
  { test: anyOf(/benefit summary/i, /summary of (?:va )?benefits/i, /benefit verification letter/i), docType: 'benefit_summary', classification: 'high_signal', confidence: 0.7 },

  // Statement in support / lay-buddy statements - VA form numbers are unambiguous.
  { test: anyOf(/statement in support of claim/i, /VA Form 21[\s-]?4138/i, /VA Form 21[\s-]?10210/i), docType: 'statement_in_support', classification: 'high_signal', confidence: 0.9 },
  { test: anyOf(/buddy statement/i, /lay statement/i, /lay witness statement/i), docType: 'lay_statement', classification: 'high_signal', confidence: 0.7 },
  // CO / command letter -> statement (small-doc-all in the selector).
  { test: anyOf(/commanding officer/i, /\bcompany commander\b/i, /letter from .{0,40}\bcommand/i), docType: 'buddy_statement', classification: 'high_signal', confidence: 0.7 },

  // Prior nexus / IMO letter (assessment 2026-06-12 §2). MUST be evaluated BEFORE the C&P and
  // STR matchers below — both directions of the trap are real:
  //   - a nexus letter's body cites STRs ("review of his service treatment records shows...")
  //     so the STR marker would otherwise win (the Jr_AAD_Nexus.pdf -> "Service treatment
  //     records" misfire that started this fix);
  //   - C&P exams ALSO say "medical opinion", so an explicit C&P-marker guard (compensation
  //     and pension / C&P examination / disability benefits questionnaire — phrases a C&P or
  //     DBQ carries and a private nexus letter does not) sends those to the C&P/DBQ matchers.
  // Both directions are pinned in key-docs-classifier.test.ts.
  {
    test: (text) =>
      !C_AND_P_EXAM_MARKERS.test(text)
      && (NEXUS_LETTER_PHRASES.test(text) || NEXUS_OPINION_SENTENCE.test(text)),
    docType: 'nexus_letter_prior', classification: 'high_signal', confidence: 0.7,
  },

  // DBQ / C&P exam.
  { test: reTest(/disability benefits questionnaire/i), docType: 'dbq', classification: 'high_signal', confidence: 0.9 },
  { test: anyOf(/compensation\s*(and|&)\s*pension exam/i, /c\s*&\s*p examination/i), docType: 'c_and_p_exam', classification: 'high_signal', confidence: 0.9 },

  // Objective test results (sleep study / audiogram / PFT). ORDERED AFTER the DBQ + C&P matchers
  // ON PURPOSE: a sleep-apnea DBQ quotes the AHI, a hearing-loss DBQ quotes puretone thresholds,
  // a respiratory DBQ quotes FEV1/FVC — those stay a DBQ (the physician wants the DBQ's opinion,
  // not just the raw values). Only a STANDALONE test report (no DBQ/C&P chrome) reaches here.
  // Sleep study: polysomnography / "apnea-hypopnea index" / "respiratory disturbance index" are
  // study-specific on their own (0.9); bare "AHI"/"RDI" also appear in narratives, so they only
  // fire when GUARDED by a per-hour rate (0.7).
  { test: anyOf(/polysomnogr/i, /apnea[\s-]?hypopnea index/i, /respiratory disturbance index/i), docType: 'sleep_study', classification: 'high_signal', confidence: 0.9 },
  { test: reTest(/\b(?:ahi|rdi)\b[\s:=]*\d{1,3}(?:\.\d+)?\s*(?:events?\s*)?(?:per\s*hour|\/\s*hr?|\/\s*hour)/i), docType: 'sleep_study', classification: 'high_signal', confidence: 0.7 },
  // Audiogram: Maryland CNC + puretone are VA-audiometry-specific (0.9); the air+bone conduction
  // pair is a strong audiogram triad (0.7).
  { test: anyOf(/maryland\s*cnc/i, /pure[\s-]?tone (?:threshold|average)/i), docType: 'audiogram', classification: 'high_signal', confidence: 0.9 },
  { test: allOf(/air conduction/i, /bone conduction/i), docType: 'audiogram', classification: 'high_signal', confidence: 0.7 },
  // Pulmonary function test: spirometry / DLCO / the FEV1+FVC pair.
  { test: anyOf(/spirometry/i, /\bDLCO\b/i, /pulmonary function test/i), docType: 'pulmonary_function_test', classification: 'high_signal', confidence: 0.7 },
  { test: allOf(/\bFEV1\b/i, /\bFVC\b/i), docType: 'pulmonary_function_test', classification: 'high_signal', confidence: 0.7 },

  // Service treatment records - SF-600 header ("Chronological Record of Medical Care") is the
  // workhorse marker; "service treatment record" appears on VA-produced STR bundles.
  { test: anyOf(/chronological record of medical care/i, /service treatment records?\b/i), docType: 'service_treatment_record_summary', classification: 'high_signal', confidence: 0.7 },

  // Intake summary - our own generated artifact, the header is ours.
  { test: anyOf(/flat rate nexus intake/i, /\bintake summary\b/i, /\bintake form\b/i), docType: 'intake_summary', classification: 'high_signal', confidence: 0.7 },

  // Imaging / radiology - needs a section-header pair so a single "findings:" inside a C&P
  // narrative (checked above anyway) can't claim the doc. impression: + (findings:|technique:|
  // comparison:|exam:) or an explicit modality-report title.
  { test: allOf(/\bimpression\s*:/i, /\b(findings|technique|comparison|exam)\s*:/i), docType: 'imaging', classification: 'high_signal', confidence: 0.7 },
  { test: reTest(/\b(mri|ct|x-?ray|ultrasound|radiology|radiographic) (report|examination|study)\b/i), docType: 'imaging', classification: 'high_signal', confidence: 0.7 },

  // Progress / clinical notes. LAST-BUT-ONE (before blue_button) so every more-specific document
  // — decision, DBQ, test report, STR — is claimed first; a generic clinical note is the residual.
  // Classification 'normal' (NOT high_signal): a routine SOAP note is mid-pack context, not a
  // primary evidence document, and the page-LLM picker trims it to the diagnosis + plan pages.
  // Signal = the four-part SOAP header quad OR an explicit CPRS / "progress note" marker.
  {
    test: (text) =>
      (/\bsubjective\b/i.test(text) && /\bobjective\b/i.test(text) && /\bassessment\b/i.test(text) && /\bplan\b/i.test(text))
      || /\bCPRS\b/.test(text)
      || /progress note/i.test(text),
    docType: 'progress_notes', classification: 'normal', confidence: 0.7,
  },

  // Blue Button / bulk dumps - content marker so a "Misc_9.pdf" 500-page dump still excludes.
  { test: anyOf(/blue button/i, /my healthevet/i), docType: 'blue_button', classification: 'bulk', confidence: 0.7 },
];

export function classifyContentText(text: string | null | undefined): ContentClassificationHint | null {
  if (typeof text !== 'string' || text.trim().length < 20) return null;
  for (const matcher of CONTENT_PATTERNS) {
    if (matcher.test(text)) {
      return { docType: matcher.docType, classification: matcher.classification, confidence: matcher.confidence };
    }
  }
  return null;
}

/**
 * Map a human-set Document.docTag to a KeyDocType. docTag is the UPLOADER'S explicit label
 * (UI options: 'STR' | 'DBQ' | 'C&P' | 'Lay Statement' | 'Other') - when present and not the
 * default 'Other', it is a HUMAN OVERRIDE and outranks both content and filename heuristics.
 * Current uploads all carry null/'Other' (the UI defaults to 'Other'), so in practice this is
 * the future-proof hook, not the workhorse.
 */
export function mapDocTagToDocType(docTag: string | null | undefined): KeyDocType | null {
  if (typeof docTag !== 'string') return null;
  const tag = docTag.trim().toLowerCase();
  switch (tag) {
    case 'str': return 'service_treatment_record_summary';
    case 'dbq': return 'dbq';
    case 'c&p': return 'c_and_p_exam';
    case 'lay statement': return 'lay_statement';
    default: return null; // 'Other', '', unknown -> no signal
  }
}

/**
 * Chunk D composition - the generate route's single entry point.
 * Precedence: human docTag override > content-text classification > filename heuristic.
 */
export function classifyDocument(input: {
  readonly filePath: string;
  readonly docTag?: string | null;
  readonly contentText?: string | null;
}): ClassificationResult {
  // NEVER-CLASSIFY-OWN-ARTIFACTS (assessment 2026-06-12 §2.3 — "a system asking a human to
  // review its own output is the purest waste in the building"). System-minted documents have
  // a KNOWN identity at creation, so heuristics must never run on them — the generated intake
  // summary's Q&A text echoes decision-letter phrasing ("...service connection...denied...")
  // and can misclassify as a denial letter, then queue an RN to confirm our own PDF.
  // Smallest correct mechanism per artifact:
  //   - Intake_Summary.pdf: minted ONLY as `cases/<id>/<uuid>-Intake_Summary.pdf`
  //     (routes/intakes.ts assign step). Recognize the reserved key suffix FIRST — the same
  //     isIntakeSummaryPath predicate the chart-readiness gate already trusts — and return the
  //     stamped type deterministically. docTag/content/filename heuristics are never consulted.
  //   - The Doctor Pack PDF itself: structurally excluded — it uploads to the SEPARATE
  //     doctor-packs bucket (`doctor-packs/<case>/v<N>/<id>.pdf`) and never becomes a case
  //     Document row, so it can never reach classification. No guard needed; documented here.
  if (isIntakeSummaryPath(input.filePath)) {
    return {
      classification: 'high_signal',
      docType: 'intake_summary',
      importance: DOCTYPE_BASE_IMPORTANCE.get('intake_summary') ?? 65,
      matchedPattern: 'system_artifact',
    };
  }
  const tagged = mapDocTagToDocType(input.docTag);
  if (tagged !== null) {
    const canonical = DOCTYPE_BASE_IMPORTANCE.get(tagged) ?? 50;
    return {
      classification: 'high_signal',
      docType: tagged,
      importance: Math.min(100, canonical + 5),
      matchedPattern: 'doc_tag_override',
    };
  }
  return classifyFileWithContentHint(input.filePath, classifyContentText(input.contentText));
}

export function isHighSignal(filePath: string): boolean {
  return classifyFile(filePath).classification === 'high_signal';
}

/**
 * Sort filenames by Doctor Pack inclusion priority: high_signal > normal > bulk; within tier,
 * by importance descending; within importance, by alphabetic file path ascending. Returns a
 * fresh sorted copy.
 */
export function sortByDoctorPackPriority(filePaths: readonly string[]): readonly string[] {
  return [...filePaths].sort((a, b) => {
    const ca = classifyFile(a);
    const cb = classifyFile(b);
    const tierOrder: Record<KeyDocClassification, number> = { high_signal: 0, normal: 1, bulk: 2 };
    if (tierOrder[ca.classification] !== tierOrder[cb.classification]) {
      return tierOrder[ca.classification] - tierOrder[cb.classification];
    }
    if (ca.importance !== cb.importance) return cb.importance - ca.importance;
    return a.localeCompare(b);
  });
}

// 1.1.0 (Chunk D 2026-06-11): content-text classification + docTag override + imaging/intake_summary
// docTypes + CO-letter patterns + canonical content-hint importance.
// 1.2.0 (assessment 2026-06-12 §2): nexus_letter_prior content pattern evaluated BEFORE C&P/STR
// (with C&P-marker guard) + bare /nexus/i filename pattern at modest importance 70 + the
// system-artifact guard (generated Intake_Summary.pdf is stamped intake_summary at the top of
// classifyDocument, never heuristically classified).
// 1.3.0 (doctor-pack classifier lane 2026-06-26): CONTENT_PATTERNS gain (a) dd_214 MOVED to after
// the denial block (combined DD-214+denial bundle -> denial_letter; standalone DD-214 still dd_214);
// (b) rated_disabilities_view + benefit_summary phrase-anchored content patterns (after the
// rating/denial blocks, never bare "service-connected"); (c) sleep_study / audiogram /
// pulmonary_function_test content patterns ORDERED AFTER dbq/c_and_p_exam (a DBQ citing AHI/
// puretone/FEV1 stays a DBQ); (d) progress_notes content pattern (SOAP quad OR CPRS/note header,
// classification 'normal', last-but-one before blue_button). Plus a filename tie-break in
// classifyFileWithContentHint: an explicit high-signal filename beats a <0.9 content guess that
// disagrees; a 0.9 content guess still wins.
export const CLASSIFIER_VERSION = 'key-docs-classifier-1.3.0';

// Monotonic INTEGER mirror of CLASSIFIER_VERSION, stamped onto key_docs.classifier_version by
// the doctor-pack-generate KeyDoc upsert. Exists so stored rows can be compared against the
// running classifier: rows with classifier_version < CLASSIFIER_VERSION_NUM were classified by
// older code and are candidates for POST /rn/key-docs/reclassify-stale (the assessment-§2
// backfill — classifier upgrades must retrofit the installed base, not just future uploads).
// History: 0 = legacy/pre-stamping rows (the DB column default — anything written before this
// column existed); 1 is reserved-unused so "0 vs nonzero" cleanly separates legacy from
// stamped; 2 = 1.2.0, the first stamped version; 3 = 1.3.0 (the doctor-pack lane: dd_214 reorder +
// rated/benefit/test/progress_notes content patterns + filename tie-break — these CAN change an
// existing row's docType, so installed rows at < 3 are reclassify-stale candidates). BUMP THIS
// whenever a pattern/order change could alter an existing row's docType.
export const CLASSIFIER_VERSION_NUM = 3;
