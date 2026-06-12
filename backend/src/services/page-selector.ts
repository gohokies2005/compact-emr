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
 *     fall back to "include all NON-boilerplate pages + needsRnReview=true". The selector
 *     cannot be wrong
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
// 1.2.0 (Assessment 2026-06-12 §1, golden-pack red->green): BENEFITS_ENCLOSURE_PATTERNS folded
// with the appeal patterns into pageIsBoilerplate() (runs BEFORE includes, outranks them,
// >=2-distinct-hits density); rating/denial/supplemental includes TIERED into strong anchors
// (include alone) vs weak tokens (count only when a strong anchor fired somewhere in the doc);
// high-signal fallback now returns all NON-boilerplate pages instead of all pages.
// 1.3.0 (Round 2 backlog item B, 2026-06-12): kill-list gains the notification-letter species
// that survived the first live pack — VALife, VSignals survey, VA Form 20-0998 QR appeal page,
// monthly-entitlement table, commissary/travel/state-benefits enclosure. Patterns only; no
// rule-flow change.
export const PAGE_SELECTOR_VERSION = 'page-selector-1.3.0';

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
  // STRONG anchors: a match on a page includes it on its own. For the VA decision-letter
  // types these are the phrasings ONLY a real decision page carries (reasons-for-decision,
  // entitlement-to-X-is, evaluation-of-X, decision-table rows) — never the enclosures.
  readonly include: readonly RegExp[];
  // WEAK tokens (assessment 2026-06-12 §1a): bare granted / denied / service-connect(ed).
  // The VA "Additional Benefits" enclosures say these words on every page, so a weak match
  // counts ONLY on a page in a doc where >= 1 strong anchor also fired somewhere.
  readonly weakInclude?: readonly RegExp[];
  readonly exclude: readonly RegExp[];
  readonly smallDocPageCutoff?: number; // include-all if pageCount <= cutoff
}

const RULES: Partial<Record<KeyDocType, RuleSet>> = {
  // Assessment 2026-06-12 §1a: the rating/denial/supplemental includes are TIERED. Strong
  // anchors = real-decision-page phrasings, include alone. Weak tokens = words the benefits
  // enclosures also say on every page; they count only when a strong anchor fired somewhere
  // in the same doc (and pageIsBoilerplate has already vetoed the enclosure pages outright).
  rating_decision: {
    include: [
      /reasons? and bases?/i,
      // Chunk D: real-world VA decision-letter phrasings (D2 table row 1).
      /reasons? for decision/i,
      /we (have )?made a decision on your (claim|appeal)/i,
      /entitlement to .{0,80}\bis (established|granted|denied)/i,
      /evaluation of .{0,120}\bis (continued|increased|decreased|assigned)/i,
      /we (have )?(granted|denied|continued)/i,
      /we (cannot |are )?(granting|denying)/i,
      /evidence considered/i,
      /granted at \d/i,
      /with an evaluation of/i,
      /\b\d{1,3}\s?(%|percent) (disabling|evaluation)/i,
    ],
    weakInclude: [
      /\bdecision\b/i,
      /service[\s-]?connect(ion|ed)/i,
      /\b(is|has been|have been|are) (granted|denied|continued|established)/i,
      /\bgranted\b/i,
      /\bdenied\b/i,
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
      /reasons? and bases?/i,
      // Chunk D: real-world VA decision-letter phrasings (D2 table row 1).
      /reasons? for decision/i,
      /we (have )?made a decision on your (claim|appeal)/i,
      /entitlement to .{0,80}\bis (denied|not established)/i,
      /we (have )?(denied|are denying)/i,
      /we cannot grant/i,
      /evidence considered/i,
    ],
    weakInclude: [
      /\bdecision\b/i,
      /\b(is|are|have been|has been) (denied|not granted)/i,
      /service[\s-]?connect(ion|ed) (is )?(not )?(granted|denied|established)/i,
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
      /reasons? and bases?/i,
      /supplemental claim/i,
      /we (have )?(granted|denied|continued)/i,
      /evidence considered/i,
    ],
    weakInclude: [
      /\bdecision\b/i,
      /\b(is|are|has been|have been) (granted|denied|continued)/i,
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
// Small My-HealtheVet/blue-button exports (≤15pp) get condition-keyed selection instead of the
// bulk-dump hard-exclude — a 6-page text export can BE the diagnosing note (Perez 2026-06-12).
const SMALL_BLUE_BUTTON_MAX_PAGES = 15;

const APPEAL_BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /how to (appeal|file)/i,
  /your (appeal )?rights/i,
  /notice of disagreement/i,
  /VA[\s-]?Form[\s-]?9\b/i,
  /appellate review/i,
  /right to (appeal|representation)/i,
];

// Assessment 2026-06-12 §1a (golden-pack): the VA decision-letter ENCLOSURES — "Additional
// Benefits", mental-health counseling, home loan, life insurance, crisis line, fraud box,
// combined-rating math — say "service-connected" and "granted" on every page, which is how
// they sailed into the first live pack. The PCP's NEVER list. These fold with the appeal
// patterns into one pageIsBoilerplate() that runs BEFORE the include rules and outranks them.
const BENEFITS_ENCLOSURE_PATTERNS: readonly RegExp[] = [
  /additional benefits/i,
  /mental health (counsel|care)/i,
  /vocational rehabilitation/i,
  /home loan guaranty/i,
  /government life insurance/i,
  /\bS-?DVI\b/i,
  // "priority group" split into its own concept: a dedicated VA-medical-care enrollment page
  // always pairs the two, while a decision page mentioning "VA medical care" in passing only
  // trips one — the >=2-distinct-hits density rule then keeps the decision page.
  /VA medical care|health care enrollment/i,
  /priority group/i,
  /veterans crisis line|dial 988|1-800-273/i,
  // Second crisis-page concept (same rationale as priority group): the dedicated crisis-line
  // enclosure always carries the "in crisis" / text-line language alongside the hotline number.
  /\bin crisis\b|text 838255/i,
  /commissary|exchange privileges/i,
  /how to contact|where to send|toll-free/i,
  /what you should know|your rights and responsibilities/i,
  // Combined-rating math table pages — explicitly on the PCP NEVER list (assessment §1).
  /combined ratings? table|how va combines ratings/i,
  /enclosure\s*\d?\b/i,
  // ── Round 2 (backlog §Doctor-pack round 2 B, PCP re-review 2026-06-12): the notification-
  // letter species that SURVIVED the first kill-list (5pp in the live pack). Each species is
  // split into separate concept patterns so a real enclosure page trips the >=2-distinct-hits
  // density floor on its own content — never on a single passing mention. ──
  // VALife insurance enclosure.
  /\bVALife\b/i,
  /veterans affairs life insurance|guaranteed acceptance whole life/i,
  // VSignals customer-survey page.
  /\bVSignals\b/i,
  /(customer|veteran) (experience|satisfaction) survey|tell us about your experience/i,
  // VA Form 20-0998 / "how do I disagree" QR appeal page (the per-spec pattern + the page's
  // companion phrasings as a second concept).
  /VA Form 20-?0998|decision review request|opt.?in.{0,20}appeals modernization/i,
  /how do I disagree|decision review options|scan (the|this) QR code/i,
  // Monthly-entitlement payment table (two concepts: a real table page carries both).
  /monthly entitlement amount/i,
  /payment start date/i,
  // Commissary / beneficiary-travel / state-benefits enclosure (commissary|exchange privileges
  // already exists above; these are the page's companion concepts).
  /beneficiary travel|state veterans benefits/i,
];

const PAGE_BOILERPLATE_PATTERNS: readonly RegExp[] = [
  ...APPEAL_BOILERPLATE_PATTERNS,
  ...BENEFITS_ENCLOSURE_PATTERNS,
];

// >=2 DISTINCT pattern hits = boilerplate. The density floor keeps a REAL decision page that
// mentions one phrase in passing ("See the enclosure for more information.") in the pack,
// while every actual enclosure/appeal page — header + body phrasing — trips 2+.
const BOILERPLATE_MIN_DISTINCT_HITS = 2;

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

// One folded boilerplate gate (appeal + benefits-enclosure patterns). Runs BEFORE the include
// rules and OUTRANKS them: a boilerplate page is excluded no matter how many include patterns
// it matches. Replaces the old pageHasAppealBoilerplate (appeal-only, effectively >=3 hits).
function pageIsBoilerplate(text: string): boolean {
  let hits = 0;
  for (const re of PAGE_BOILERPLATE_PATTERNS) {
    if (re.test(text)) {
      hits++;
      if (hits >= BOILERPLATE_MIN_DISTINCT_HITS) return true;
    }
  }
  return false;
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

// `docHasStrongAnchor`: did any STRONG include fire on a usable page anywhere in this doc?
// Weak tokens only count when it did (assessment 2026-06-12 §1a tiering).
function pageMatchesRule(text: string, rule: RuleSet, docHasStrongAnchor: boolean): { include: boolean; reason: string } {
  for (const re of rule.exclude) {
    if (re.test(text)) return { include: false, reason: `excluded by ${re.source}` };
  }
  for (const re of rule.include) {
    if (re.test(text)) return { include: true, reason: `matched ${re.source}` };
  }
  if (docHasStrongAnchor) {
    for (const re of rule.weakInclude ?? []) {
      if (re.test(text)) return { include: true, reason: `weak ${re.source} (doc has strong anchor)` };
    }
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
 *   8. High-signal confidence fallback: if rules selected < 2 pages, include all
 *      NON-boilerplate pages + flag for RN (1.2.0: was all pages).
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
    // SMALL blue-button exception (live Perez finding 2026-06-12): veterans upload My HealtheVet
    // TEXT exports a few pages long whose content IS the clinical evidence (the PCMHI consult
    // carrying the anxiety dx classified blue_button → hard-excluded → the regenerated pack
    // shipped with NO clinical documentation). The 500-page-dump guard must not nuke a 6-page
    // export. Small blue-button docs fall through to the SAME condition/recent-encounter
    // selection progress notes use (next branch); genuinely-bulk dumps stay default-excluded.
    // Format/source must never silently decide clinical inclusion (PCP panel spec line 3).
    const isSmallBlueButton = input.docType === 'blue_button' && input.pageCount <= SMALL_BLUE_BUTTON_MAX_PAGES;
    if (!isSmallBlueButton) {
      return {
        pageRanges: [],
        selectorRationale: `default_exclude (${input.docType}); drafter-cited pages add post-hoc`,
        needsRnReview: false,
        selectorVersion: PAGE_SELECTOR_VERSION,
      };
    }
  }

  // Chunk D: progress notes are no longer default-excluded. Ryan's spec (P2.4 rule 2) wants the
  // "most recent/pertinent office visit notes" IN: include a page when it mentions the claimed
  // condition OR belongs to the most recent encounter (= carries the doc's max parsed date).
  // Nothing matches -> empty ranges (the old exclusion, now earned rather than blanket).
  // Small blue_button exports ride the same branch (see the exception above).
  if (input.docType === 'progress_notes' || input.docType === 'blue_button') {
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
    // Rationale prefix carries the REAL docType so blue-button exports don't masquerade as
    // progress notes in the RN tooltip (both prefixes mapped in the frontend label table).
    return {
      pageRanges: rangesFromIncluded(includedPages),
      selectorRationale: includedPages.length > 0
        ? `${input.docType}_condition_or_recent: ${reasons.join('; ')}`
        : `${input.docType}_no_condition_or_recent_match (excluded)`,
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

  // Per-page evaluation. Boilerplate runs FIRST and outranks every include (assessment §1a).
  // Pre-pass: find whether any strong anchor fires on a usable (non-blank, non-boilerplate)
  // page — weak tokens only count in a doc where one did.
  let docHasStrongAnchor = false;
  for (const page of input.pages) {
    if (pageIsBlank(page.text) || pageIsBoilerplate(page.text)) continue;
    if (rule.include.some((re) => re.test(page.text))) {
      docHasStrongAnchor = true;
      break;
    }
  }

  const includedPages: number[] = [];
  const perPageRationales: string[] = [];
  const boilerplatePageNumbers = new Set<number>();
  for (const page of input.pages) {
    if (pageIsBlank(page.text)) {
      perPageRationales.push(`p${page.pageNumber}: blank_or_image_only`);
      continue;
    }
    if (pageIsBoilerplate(page.text)) {
      boilerplatePageNumbers.add(page.pageNumber);
      perPageRationales.push(`p${page.pageNumber}: boilerplate (appeal/benefits-enclosure, excluded)`);
      continue;
    }
    const decision = pageMatchesRule(page.text, rule, docHasStrongAnchor);
    if (decision.include) {
      includedPages.push(page.pageNumber);
      perPageRationales.push(`p${page.pageNumber}: ${decision.reason}`);
    }
  }

  // High-signal confidence fallback. Assessment §1a: the fallback is now all NON-boilerplate
  // pages — "the decision is in here somewhere" never justified shipping the VA's benefits
  // enclosures or appeal instructions.
  if (HIGH_SIGNAL_FALLBACK_TYPES.has(input.docType) && includedPages.length < 2) {
    const nonBoilerplate = input.pages
      .filter((page) => !boilerplatePageNumbers.has(page.pageNumber))
      .map((page) => page.pageNumber);
    return {
      pageRanges: rangesFromIncluded(nonBoilerplate),
      selectorRationale: `high_signal_fallback (only ${includedPages.length} match(es); included all non-boilerplate pages + RN review). Pages: ${perPageRationales.join('; ')}`,
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
