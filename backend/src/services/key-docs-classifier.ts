import type { KeyDocClassification, KeyDocType } from './db-types.js';

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
  { pattern: /nexus.?letter/i,              docType: 'nexus_letter_prior',       classification: 'high_signal', importance: 80 },
  { pattern: /nexus.?opinion/i,             docType: 'nexus_letter_prior',       classification: 'high_signal', importance: 80 },
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

export const CLASSIFIER_VERSION = 'key-docs-classifier-1.0.0';
