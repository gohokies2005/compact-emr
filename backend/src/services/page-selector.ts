import type { KeyDocClassification, KeyDocPageRange, KeyDocType } from './db-types.js';

/**
 * Phase 7B-revised Build 1: per-page selection rules for the Doctor Pack.
 *
 * Architect plan (commit `80caff7`, `docs/planning/2026-05-25_phase7b_revised_page_selection.md`):
 * the Doctor Pack ships page-selected, not whole-document. Per-docType regex rules over
 * per-page extracted text decide which pages of which docs land in the physician's pack.
 *
 * Two HARD-RULE-derived behaviors are baked in here:
 *   - Confidence fallback: high-signal docs (rating_decision, denial_letter, supplemental_
 *     decision, dbq, c_and_p_exam) with fewer than 2 page matches across their entire body
 *     fall back to "include all pages + needsRnReview=true". The selector cannot be wrong
 *     about "the decision is in here somewhere" for a doc the classifier marked high-signal;
 *     over-inclusion + RN review beats shipping a pack missing the actual decision.
 *   - Deterministic: regex-only, no LLM. Replayability is non-negotiable (the assembler
 *     relies on "same input → identical output" for idempotency).
 *
 * Physician override: when a `physicianIncludeAllPages` flag is supplied (a per-file
 * checkbox set in the EMR UI), the selector returns ALL pages regardless of rules and
 * stamps the rationale as `physician_override`.
 */

// 1.1.0 (Chunk D 2026-06-11): claimedCondition input + progress_notes condition/recent-encounter
// inclusion (was default-exclude) + imaging rules + widened VA decision-letter phrasings.
export const PAGE_SELECTOR_VERSION = 'page-selector-1.1.0';

const SMALL_DOC_ALWAYS_ALL_TYPES: ReadonlySet<KeyDocType> = new Set<KeyDocType>([
  'audiogram',
  'pulmonary_function_test',
  'dd_214',
  'lay_statement',
  'buddy_statement',
  'statement_in_support',
  'nexus_letter_prior',
  'medical_opinion',
  'tera_memo',
  'individual_exposure_summary',
  'entrance_exam',
  'separation_exam',
  // Chunk D: our own generated intake summary - short, always pertinent.
  'intake_summary',
]);

// Chunk D: progress_notes left this set - Ryan WANTS recent/pertinent visit notes in the pack
// (P2.4 spec rule 2). It now has its own condition/recent-encounter branch in selectPages.
// blue_button stays hard-excluded (the "500 pages" guard).
const DEFAULT_EXCLUDE_BY_DEFAULT: ReadonlySet<KeyDocType> = new Set<KeyDocType>([
  'blue_button',
]);

const HIGH_SIGNAL_FALLBACK_TYPES: ReadonlySet<KeyDocType> = new Set<KeyDocType>([
  'rating_decision',
  'denial_letter',
  'supplemental_decision',
  'dbq',
  'c_and_p_exam',
]);

interface RuleSet {
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
  readonly smallDocPageCutoff?: number; // include-all if pageCount <= cutoff
}

const RULES: Partial<Record<KeyDocType, RuleSet>> = {
  rating_decision: {
    include: [
      /\bdecision\b/i,
      /reasons? and bases?/i,
      // Chunk D: real-world VA decision-letter phrasings (D2 table row 1).
      /reasons? for decision/i,
      /we (have )?made a decision on your (claim|appeal)/i,
      /entitlement to .{0,80}\bis (established|granted|denied)/i,
      /evaluation of .{0,120}\bis (continued|increased|decreased|assigned)/i,
      /service[\s-]?connect(ion|ed)/i,
      /\b(is|has been|have been|are) (granted|denied|continued|established)/i,
      /we (have )?(granted|denied|continued)/i,
      /we (cannot |are )?(granting|denying)/i,
      /evidence considered/i,
      /\bgranted\b/i,
      /\bdenied\b/i,
      /granted at \d/i,
      /with an evaluation of/i,
      /\b\d{1,3}\s?(%|percent) (disabling|evaluation)/i,
    ],
    exclude: [
      /how to (appeal|file a notice)/i,
      /your (appeal )?rights/i,
      /notice of disagreement/i,
      /VA[\s-]?Form[\s-]?9\b/i,
      /appellate review/i,
      /right to (appeal|representation)/i,
      /board of veterans'? appeals/i,
    ],
  },
  denial_letter: {
    include: [
      /\bdecision\b/i,
      /reasons? and bases?/i,
      // Chunk D: real-world VA decision-letter phrasings (D2 table row 1).
      /reasons? for decision/i,
      /we (have )?made a decision on your (claim|appeal)/i,
      /entitlement to .{0,80}\bis (denied|not established)/i,
      /\b(is|are|have been|has been) (denied|not granted)/i,
      /we (have )?(denied|are denying)/i,
      /we cannot grant/i,
      /service[\s-]?connect(ion|ed) (is )?(not )?(granted|denied|established)/i,
      /evidence considered/i,
    ],
    exclude: [
      /how to (appeal|file)/i,
      /your (appeal )?rights/i,
      /notice of disagreement/i,
      /VA[\s-]?Form[\s-]?9\b/i,
      /appellate review/i,
    ],
  },
  supplemental_decision: {
    include: [
      /\bdecision\b/i,
      /reasons? and bases?/i,
      /supplemental claim/i,
      /\b(is|are|has been|have been) (granted|denied|continued)/i,
      /we (have )?(granted|denied|continued)/i,
      /evidence considered/i,
    ],
    exclude: [
      /how to (appeal|file)/i,
      /your (appeal )?rights/i,
      /VA[\s-]?Form[\s-]?9\b/i,
      /appellate review/i,
    ],
  },
  dbq: {
    include: [
      /\[X\]|\[x\]|☒/, // checked boxes (any one is enough)
      /^\s*signature/im,
      /diagnosis:/i,
      /findings:/i,
      /physician.{0,30}signature/i,
      /examiner.{0,30}signature/i,
    ],
    exclude: [],
    smallDocPageCutoff: 2,
  },
  c_and_p_exam: {
    include: [
      /\bdiagnosis\b/i,
      /medical opinion/i,
      /\brationale\b/i,
      /medical history/i,
      /at least as likely as not/i,
      /is more likely than not/i,
      /is due to/i,
      /current evaluation/i,
      /summary of evidence/i,
    ],
    exclude: [
      /claimant information/i,
      /claim(ant)? identification/i,
    ],
    smallDocPageCutoff: 2,
  },
  // Chunk D: imaging/radiology - the impression/findings page is the payload; small-doc-all <=2pp.
  imaging: {
    include: [
      /\bimpression\s*:/i,
      /\bfindings\s*:/i,
      /\bconclusion\s*:/i,
    ],
    exclude: [],
    smallDocPageCutoff: 2,
  },
  sleep_study: {
    include: [
      /\bimpression\b/i,
      /\bAHI\b/i,
      /\bODI\b/i,
      /\bsummary\b/i,
      /apnea[\s-]hypopnea/i,
      /total events/i,
    ],
    exclude: [],
    smallDocPageCutoff: 2,
  },
  benefit_summary: {
    include: [
      // No keyword filter — first 3 pages are summary, rest is noise.
    ],
    exclude: [],
  },
  personnel_record: {
    include: [
      /\bMOS\b/i,
      /military occupational specialty/i,
      /deployment|deployed/i,
      /decoration|award|medal/i,
      /\bbattle\b|\bcombat\b/i,
      /(back|knee|head|exposure|blast|trauma|concuss)/i,
    ],
    exclude: [],
    smallDocPageCutoff: 4,
  },
  service_treatment_record_summary: {
    include: [
      /(back|knee|head|exposure|blast|trauma|concuss|hearing|tinnitus|sinus|asthma|migraine|PTSD)/i,
      /injury|injured/i,
      /complaint/i,
      /diagnosis/i,
    ],
    exclude: [],
    smallDocPageCutoff: 4,
  },
};

// Item 3 (2026-06-11): unspecified docs at or under this page count are included in full
// (and no longer RN-flagged — see the unspecified branch in selectPages); larger ones are
// truncated to the first UNSPECIFIED_SMALL_PAGE_CUTOFF pages and DO get the RN flag.
const UNSPECIFIED_SMALL_PAGE_CUTOFF = 8;

const APPEAL_BOILERPLATE_THRESHOLD = 0.4;
const APPEAL_BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /how to (appeal|file)/i,
  /your (appeal )?rights/i,
  /notice of disagreement/i,
  /VA[\s-]?Form[\s-]?9\b/i,
  /appellate review/i,
  /right to (appeal|representation)/i,
];

export interface PageSelectorInputPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number | null;
}

export interface PageSelectorInput {
  readonly filePath: string;
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly pageCount: number;
  readonly pages: readonly PageSelectorInputPage[];
  readonly physicianIncludeAllPages?: boolean;
  // Chunk D: the case's claimed condition - lets progress_notes (and any future condition-keyed
  // rule) include pages that mention what the letter is actually about. Optional: absent keeps
  // the recent-encounter rule alone.
  readonly claimedCondition?: string;
}

export interface PageSelectorResult {
  readonly pageRanges: readonly KeyDocPageRange[];
  readonly selectorRationale: string;
  readonly needsRnReview: boolean;
  readonly selectorVersion: string;
}

function allPages(pageCount: number): readonly KeyDocPageRange[] {
  if (pageCount <= 0) return [];
  return [{ from: 1, to: pageCount }];
}

function firstNPages(n: number, pageCount: number): readonly KeyDocPageRange[] {
  if (pageCount <= 0 || n <= 0) return [];
  return [{ from: 1, to: Math.min(n, pageCount) }];
}

function rangesFromIncluded(includedPageNumbers: readonly number[]): readonly KeyDocPageRange[] {
  if (includedPageNumbers.length === 0) return [];
  const sorted = [...new Set(includedPageNumbers)].sort((a, b) => a - b);
  const ranges: KeyDocPageRange[] = [];
  let rangeStart = sorted[0] ?? 1;
  let prev = rangeStart;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] ?? prev + 1;
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push({ from: rangeStart, to: prev });
      rangeStart = cur;
      prev = cur;
    }
  }
  ranges.push({ from: rangeStart, to: prev });
  return ranges;
}

function pageHasAppealBoilerplate(text: string): boolean {
  let hits = 0;
  for (const re of APPEAL_BOILERPLATE_PATTERNS) {
    if (re.test(text)) hits++;
  }
  // Heuristic: a page dominated by appeal boilerplate matches 3+ of the canonical phrases.
  return hits >= 3 || (hits >= 1 && text.length > 0 && text.length < 2000 && hits / APPEAL_BOILERPLATE_PATTERNS.length >= APPEAL_BOILERPLATE_THRESHOLD);
}

function pageIsBlank(text: string): boolean {
  return text.replace(/\s+/g, ' ').trim().length < 10;
}

// ---------- Chunk D: progress-notes condition + recent-encounter helpers ----------

// Deterministic date extraction for "most recent encounter" detection. Returns comparable
// yyyymmdd integers. Three formats cover VA/CPRS + private-practice note headers:
// MM/DD/YYYY (and -), YYYY-MM-DD, and "Month DD, YYYY". Two-digit years are deliberately
// ignored (ambiguous).
const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function extractDateInts(text: string): number[] {
  const out: number[] = [];
  const push = (y: number, m: number, d: number) => {
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) out.push(y * 10000 + m * 100 + d);
  };
  for (const m of text.matchAll(/\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-]((?:19|20)\d{2})\b/g)) {
    push(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  for (const m of text.matchAll(/\b((?:19|20)\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(0?[1-9]|[12]\d|3[01]),?\s+((?:19|20)\d{2})\b/gi)) {
    const mon = MONTH_INDEX[(m[1] ?? '').toLowerCase()];
    if (mon !== undefined) push(Number(m[3]), mon, Number(m[2]));
  }
  return out;
}

// Condition matcher: full-phrase match OR any distinctive token (length >= 5) from the claimed
// condition. Short/common tokens ("back", "pain", "left") are dropped - the full phrase still
// catches them; budget trim catches over-inclusion.
function buildConditionMatcher(claimedCondition: string | undefined): ((text: string) => boolean) | null {
  const phrase = (claimedCondition ?? '').trim().toLowerCase();
  if (phrase.length < 3) return null;
  const tokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 5);
  return (text: string) => {
    const lower = text.toLowerCase();
    if (lower.includes(phrase)) return true;
    return tokens.some((t) => lower.includes(t));
  };
}

function pageMatchesRule(text: string, rule: RuleSet): { include: boolean; reason: string } {
  for (const re of rule.exclude) {
    if (re.test(text)) return { include: false, reason: `excluded by ${re.source}` };
  }
  for (const re of rule.include) {
    if (re.test(text)) return { include: true, reason: `matched ${re.source}` };
  }
  return { include: false, reason: 'no include match' };
}

/**
 * Decide which pages of a single document to include in the Doctor Pack.
 *
 * Decision flow:
 *   1. Empty / no pages provided → empty result (worker hasn't extracted yet).
 *   2. Physician override → all pages, rationale='physician_override'.
 *   3. Always-all docTypes (DD-214, lay statements, audiograms, etc.) → all pages.
 *   4. Always-exclude docTypes (blue_button) → empty pages.
 *   4b. progress_notes (Chunk D) → pages mentioning the claimed condition OR in the most
 *       recent encounter; nothing matches → empty.
 *   5. Small-doc shortcut (when configured): pageCount ≤ cutoff → all pages.
 *   6. benefit_summary → first 3 pages.
 *   7. Otherwise apply per-docType include/exclude rules per page.
 *   8. High-signal confidence fallback: if rules selected < 2 pages, include all + flag for RN.
 */
export function selectPages(input: PageSelectorInput): PageSelectorResult {
  if (input.physicianIncludeAllPages === true) {
    return {
      pageRanges: allPages(input.pageCount),
      selectorRationale: 'physician_override',
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (input.pages.length === 0 || input.pageCount <= 0) {
    // No per-page text yet — the OCR worker hasn't populated document_pages for this doc.
    // Return empty; the assembler will see zero ranges and either wait for the worker or
    // flag the doc as needs-extraction. Forward-compatible with the shipped whole-doc code:
    // the route currently passes pageCount-derived ranges when pages are absent.
    return {
      pageRanges: [],
      selectorRationale: 'no_per_page_text_available',
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (SMALL_DOC_ALWAYS_ALL_TYPES.has(input.docType)) {
    return {
      pageRanges: allPages(input.pageCount),
      selectorRationale: `small_doc_always_all (${input.docType})`,
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (DEFAULT_EXCLUDE_BY_DEFAULT.has(input.docType)) {
    return {
      pageRanges: [],
      selectorRationale: `default_exclude (${input.docType}); drafter-cited pages add post-hoc`,
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  // Chunk D: progress notes are no longer default-excluded. Ryan's spec (P2.4 rule 2) wants the
  // "most recent/pertinent office visit notes" IN: include a page when it mentions the claimed
  // condition OR belongs to the most recent encounter (= carries the doc's max parsed date).
  // Nothing matches -> empty ranges (the old exclusion, now earned rather than blanket).
  if (input.docType === 'progress_notes') {
    const conditionMatches = buildConditionMatcher(input.claimedCondition);
    const pageDates = new Map<number, number[]>();
    let docMaxDate = 0;
    for (const page of input.pages) {
      if (pageIsBlank(page.text)) continue;
      const dates = extractDateInts(page.text);
      pageDates.set(page.pageNumber, dates);
      for (const d of dates) docMaxDate = Math.max(docMaxDate, d);
    }
    const includedPages: number[] = [];
    const reasons: string[] = [];
    for (const page of input.pages) {
      if (pageIsBlank(page.text)) continue;
      const inRecentEncounter = docMaxDate > 0 && (pageDates.get(page.pageNumber) ?? []).includes(docMaxDate);
      const mentionsCondition = conditionMatches !== null && conditionMatches(page.text);
      if (mentionsCondition || inRecentEncounter) {
        includedPages.push(page.pageNumber);
        reasons.push(`p${page.pageNumber}: ${mentionsCondition ? 'mentions_claimed_condition' : `most_recent_encounter(${docMaxDate})`}`);
      }
    }
    return {
      pageRanges: rangesFromIncluded(includedPages),
      selectorRationale: includedPages.length > 0
        ? `progress_notes_condition_or_recent: ${reasons.join('; ')}`
        : 'progress_notes_no_condition_or_recent_match (excluded)',
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (input.docType === 'benefit_summary') {
    return {
      pageRanges: firstNPages(3, input.pageCount),
      selectorRationale: 'benefit_summary_first_3_pages',
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (input.docType === 'unspecified') {
    if (input.pageCount <= UNSPECIFIED_SMALL_PAGE_CUTOFF) {
      // Item 3 flag-volume cut (2026-06-11): small unspecified docs are included IN FULL, so
      // there is nothing for an RN to verify — no pages can have been silently dropped. This
      // branch was the bulk of the "Doc selection review" noise Ryan complained about. The
      // large-doc branch below KEEPS the flag: its first-8 truncation can drop the payload.
      return {
        pageRanges: allPages(input.pageCount),
        selectorRationale: 'unspecified_small_doc_all_pages',
        needsRnReview: false,
        selectorVersion: PAGE_SELECTOR_VERSION,
      };
    }
    return {
      pageRanges: firstNPages(UNSPECIFIED_SMALL_PAGE_CUTOFF, input.pageCount),
      selectorRationale: 'unspecified_large_doc_first_8',
      needsRnReview: true,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  const rule = RULES[input.docType];
  if (!rule) {
    // Doc type recognized but no rules defined — include all + RN flag.
    return {
      pageRanges: allPages(input.pageCount),
      selectorRationale: `no_rules_for_doctype (${input.docType}); include_all + RN review`,
      needsRnReview: true,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  if (rule.smallDocPageCutoff !== undefined && input.pageCount <= rule.smallDocPageCutoff) {
    return {
      pageRanges: allPages(input.pageCount),
      selectorRationale: `small_doc_shortcut (pageCount=${input.pageCount} <= ${rule.smallDocPageCutoff})`,
      needsRnReview: false,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  // Per-page evaluation.
  const includedPages: number[] = [];
  const perPageRationales: string[] = [];
  for (const page of input.pages) {
    if (pageIsBlank(page.text)) {
      perPageRationales.push(`p${page.pageNumber}: blank_or_image_only`);
      continue;
    }
    if (pageHasAppealBoilerplate(page.text)) {
      perPageRationales.push(`p${page.pageNumber}: appeal_boilerplate (excluded)`);
      continue;
    }
    const decision = pageMatchesRule(page.text, rule);
    if (decision.include) {
      includedPages.push(page.pageNumber);
      perPageRationales.push(`p${page.pageNumber}: ${decision.reason}`);
    }
  }

  // High-signal confidence fallback.
  if (HIGH_SIGNAL_FALLBACK_TYPES.has(input.docType) && includedPages.length < 2) {
    return {
      pageRanges: allPages(input.pageCount),
      selectorRationale: `high_signal_fallback (only ${includedPages.length} match(es); included all pages + RN review). Pages: ${perPageRationales.join('; ')}`,
      needsRnReview: true,
      selectorVersion: PAGE_SELECTOR_VERSION,
    };
  }

  return {
    pageRanges: rangesFromIncluded(includedPages),
    selectorRationale: perPageRationales.join('; ') || 'no_matches',
    needsRnReview: false,
    selectorVersion: PAGE_SELECTOR_VERSION,
  };
}
