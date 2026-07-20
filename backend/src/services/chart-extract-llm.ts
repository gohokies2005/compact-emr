/**
 * Chart auto-extractor — Phase A LLM parse step. Takes the deterministic section windows from
 * chart-extractor.locateExtractionInputs and turns each into structured chart rows via a tool-use
 * call, then GROUNDS every item (verbatim quote must be on the cited page) and applies the
 * confidence gate before anything is eligible to be written.
 *
 * Calls the model ONCE PER WINDOW: each window is one document + one category, so the source
 * documentId is unambiguous (injected from the window) and the model only has to return the page
 * (from the [p.N] markers), a verbatim quote, and the parsed fields. Smaller, focused prompts =
 * the most reliable parse, on text that's already pre-isolated to a single structured list.
 *
 * Grounding + dedup + disposition reuse the pure helpers in chart-extractor.ts. The model never
 * decides what gets written — code does, based on the verbatim-quote check + confidence.
 */

import Anthropic from '@anthropic-ai/sdk';
import { extractRatingDecisionGrants } from './rating-decision-grants.js';
import {
  locateExtractionInputs,
  chunkDocuments,
  uncoveredPages,
  dedupeIdenticalDocuments,
  splitChunkText,
  splitPageByChar,
  groundExtractedItem,
  normalizeForQuoteMatch,
  chartDedupKey,
  normalizeName,
  dispositionForConfidence,
  type BundleDocument,
  type ExtractCategory,
  type SectionWindow,
  type ConfidenceDisposition,
} from './chart-extractor.js';

// Sonnet is the right tier for "parse this pre-isolated list into rows" — cheaper than Opus, and
// the task carries no reasoning the grounding gate doesn't already re-check.
const MODEL = process.env.CHART_EXTRACT_MODEL ?? 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
// Sonnet per-MTok pricing (input $3 / output $15). Update if pricing changes.
const INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

// ── Full-read chunker config (PR-1, behind CHART_EXTRACT_FULLREAD) ──
// Default OFF: CHART_AUTOFILL already defaults 'on', so there is no shadow runway — this gate is
// the ONLY thing keeping the chunker dark until it's live-smoked on the Armand bundle and flipped.
export function fullReadEnabled(): boolean { return process.env.CHART_EXTRACT_FULLREAD === 'on'; }
// Model for the chunked pass. Ryan 2026-06-13: Sonnet 4.6; escalate rating-decision chunks to
// Opus 4.8 ONLY if the live smoke shows a miss. Per-call param so that escalation is a 1-line change.
const FULLREAD_MODEL = process.env.CHART_EXTRACT_FULLREAD_MODEL ?? MODEL;
// Higher than the windowed 2000 — a combined-category chunk legitimately emits many items; a bigger
// ceiling cuts how often we hit the split-retry. Truncation is still detected + split-retried.
const CHUNK_MAX_TOKENS = 8192;
// NOTE (2026-07-12): an UNSPLITTABLE dense single page used to re-run at a 32k ceiling — a single
// 5-9 min generation that blew the 15-min Lambda wall and DLQ'd Reckart CLM-84B137F353. That
// escalation is RETIRED: a dense single page is now char-split into base-budget halves (splitPageByChar),
// so no single call ever needs a higher ceiling. See the max_tokens branch in extractOneChunk.
// Bounded concurrency. Raised 4→8 (Ryan 2026-06-13): Woodley (2,256pp → 60 chunks) took 14-17 min at
// 4-wide, past the Lambda timeout. 8-wide ~halves wall-clock (~7-9 min) while staying within the
// Anthropic direct-API rate ceiling for these short tool calls. Timeout bumped to 15 min in tandem.
const CHUNK_CONCURRENCY = 8;
// Self-budget (audit 2026-06-13 ROOT FIX for the silent-timeout class): the worker Lambda's hard
// timeout is 15 min. If extraction is still launching batches as that ceiling approaches, the Lambda
// is killed mid-run — leaving the ChartExtractionRun stuck at 'queued' with nothing posted (the
// stuck-run watcher would eventually flip it to failed, but the work + spend are lost). Instead we
// stop launching NEW batches at this wall-clock budget and post what we have as complete_with_gaps,
// folding the un-run chunks' pages into uncoveredPages. 12.5 min leaves ~2.5 min headroom for the
// final in-flight batch to settle + grounding + the merge callback before the 15-min kill.
// Env-overridable (read per-call, like fullReadEnabled) so the A/B smoke harness can disable it with a
// large value and tests can force an early cutoff.
const DEFAULT_SELF_BUDGET_MS = 12.5 * 60 * 1000;
function selfBudgetMs(): number {
  const v = Number(process.env.CHART_EXTRACT_SELF_BUDGET_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SELF_BUDGET_MS;
}
// Split-retry depth: a truncated chunk is halved and re-run; bounded so a pathological page can't
// recurse forever (it falls through to "accept + log loud" at the floor).
const MAX_SPLIT_DEPTH = 2;
// LAMBDA-DEADLINE GUARD (Reckart CLM-84B137F353 root-cause hardening, 2026-07-12). The fixed self-budget
// above assumes a FRESH 15-min Lambda; it resets its clock at extractFullRead start and can't see time
// already consumed (cold start, doc fetch, a prior record in the batch). When the SQS handler passes the
// runtime's ABSOLUTE deadline (Date.now()+getRemainingTimeInMillis()), these margins bound the run to the
// REAL wall so it always degrades to complete_with_gaps / FLOOR (already-plumbed, RN-visible) instead of
// being killed mid-run → DLQ. All three fire only when a deadline is supplied; without one the code path
// is byte-for-byte the old behavior. Batch margin > recursion margin > 0 so we stop launching before we
// stop recursing before a call could straddle the kill; batch margin also reserves the post-extraction
// tail (grounding + merge POST + the DARK event-classifier's extra Sonnet call + screening-summary).
const DEADLINE_BATCH_MARGIN_MS = 180_000;      // stop launching NEW batches with < 3 min of Lambda left
const DEADLINE_RECURSION_MARGIN_MS = 120_000;  // stop SPLIT recursion (accept FLOOR) with < 2 min left
const DEADLINE_CALL_MARGIN_MS = 30_000;        // cap a single SDK call to finish ≥ 30 s before the kill
const PER_CALL_TIMEOUT_MS = 14 * 60 * 1000;    // the pre-existing per-request ceiling (upper bound)
const MIN_CALL_TIMEOUT_MS = 240_000;           // never cap BELOW this — a normal base call must never be cut

/** Per-call duration budget, used for BOTH the SDK `timeout` (per-attempt, time-to-headers) AND the
 *  deadline AbortSignal (wall-clock, covers the stream body): the pre-existing 14-min ceiling, tightened
 *  toward the remaining Lambda budget when a deadline is known — floored at MIN_CALL_TIMEOUT_MS so a
 *  slow-but-legit call is never spuriously aborted. The batch/recursion gates handle the graceful stop
 *  when NEW work would start near the deadline; this bounds a single in-flight call that stalls. */
export function perCallTimeoutMs(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return PER_CALL_TIMEOUT_MS;
  const remaining = deadlineMs - Date.now() - DEADLINE_CALL_MARGIN_MS;
  return Math.min(PER_CALL_TIMEOUT_MS, Math.max(remaining, MIN_CALL_TIMEOUT_MS));
}

// icd10 / dcCode are short CODE columns (icd10 = Postgres VarChar(16); manual entry validates the
// same way in chart-entry-validation.ts). A model-authored value that's over-length or not
// code-shaped is NOT a real code — DROP it (NEVER truncate: a truncated code is a WRONG code in a
// medico-legal chart; the problem/condition row still lands with its name). This also stops a long
// icd10 from overflowing VarChar(16) and aborting the whole extraction write (Ryan 2026-06-13, 2
// agents confirmed: icd10 overflow DLQ'd a 130-item Woodley run).
// Shape: letter + digit + (digit OR letter) category, then an optional dotted 1-4 subclassification.
// The 3rd char admits a LETTER so the M1A / C7A / O9A categories (chronic gout, neuroendocrine, etc.)
// are NOT silently dropped (QA 2026-06-13). Max 7 chars total = the correct ICD-10-CM ceiling. Rejects
// "G47.33 Obstructive sleep apnea" (the VARCHAR(16) crash — has a space) and dot-less blobs.
const ICD10_SHAPE = /^[A-Z][0-9][0-9A-Z](?:\.[A-Z0-9]{1,4})?$/i;
export function sanitizeIcd10(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= 16 && ICD10_SHAPE.test(t) ? t.toUpperCase() : undefined;
}
export function sanitizeCode16(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= 16 ? t : undefined; // DC code: drop if over the manual-entry limit
}

// `status` is written into the Postgres ScConditionStatus ENUM (service_connected | pending | denied).
// The tool-schema enum constrains the MODEL, but the coercers are the DEFENSIVE layer — an un-mapped
// free-text status (the prompt itself discusses "deferred → pending", so "deferred" is a plausible
// emission) would be rejected by the enum and ABORT the whole merge transaction, exactly like the
// icd10 overflow did (2 agents, 2026-06-13). Map known synonyms to the three legal values; anything
// unrecognized → undefined (the merge then applies its default). NOTE: deferred/claimed map to
// `pending`, never to service_connected — a deferred/claimed condition must not be mismarked as a
// granted SC on a medico-legal chart.
const SC_STATUS_SYNONYMS: Record<string, 'service_connected' | 'pending' | 'denied'> = {
  service_connected: 'service_connected',
  'service-connected': 'service_connected',
  'service connected': 'service_connected',
  serviceconnected: 'service_connected',
  sc: 'service_connected',
  granted: 'service_connected',
  grant: 'service_connected',
  rated: 'service_connected',
  pending: 'pending',
  claimed: 'pending',
  deferred: 'pending',
  'under review': 'pending',
  denied: 'denied',
  denial: 'denied',
  'not service-connected': 'denied',
  'not service connected': 'denied',
};
export function sanitizeScStatus(v: unknown): 'service_connected' | 'pending' | 'denied' | undefined {
  if (typeof v !== 'string') return undefined;
  return SC_STATUS_SYNONYMS[v.trim().toLowerCase()];
}

// ratingPct is written into a Postgres `Int`. A non-integer (e.g. 70.5) or out-of-range value would be
// accepted by a bare `typeof === 'number'` check but REJECTED by the integer column → transaction abort.
// Gate to a 0..100 integer; drop anything else (the row still writes without a rating). (QA 2026-06-13.)
export function sanitizeRatingPct(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : undefined;
}

/** Raw item as returned by the model for a single window, before grounding. */
export interface RawExtractedItem {
  category: ExtractCategory;
  name: string;
  status?: 'service_connected' | 'pending' | 'denied';
  dcCode?: string;
  ratingPct?: number;
  // Continuation-grant provenance (continuation-grant fix, 2026-07-19). Set to 'continued' on an SC row
  // captured deterministically from a rating-decision CONTINUATION/INCREASE recital ("Evaluation of X …
  // is continued/increased/decreased") — a form that presupposes an existing grant. Audit-only; consumers
  // treat it exactly like any other service_connected row.
  grantForm?: 'continued';
  // SC-status source-authority provenance (Woodley fix). Optional so untyped callers compile unchanged;
  // stamped by the merge layer (chart-merge-apply) before planMerge so the upgrade-on-merge promotion can
  // gate strictly on an authoritative rating-decision source. Never the model's judgment.
  sourceAuthorityTier?: string;
  scStatusAuthoritative?: boolean;
  icd10?: string;
  notes?: string;
  dose?: string;
  frequency?: string;
  indication?: string;
  // active_medication temporality (full-read combined pass). medStatus is the active-vs-history
  // discriminator; startDate = an explicitly-labeled Start/Issue date only; lastSeenDate = last-fill
  // date (active list) OR the progress-note date a past mention came from (the "Prozac 2015" signal).
  // All transcription-only — never inferred — and scrubbed to require the date appear in sourceQuote.
  medStatus?: 'active' | 'discontinued' | 'historical' | 'unknown';
  startDate?: string;
  lastSeenDate?: string;
  sourceDocumentId: string;
  sourcePage: number;
  sourceQuote: string;
  confidence: number;
}

export interface FinalExtractedItem extends RawExtractedItem {
  disposition: Exclude<ConfidenceDisposition, 'drop'>;
  needsReview: boolean;
}

/**
 * A screening-instrument data point (PHQ-9, GAD-7, PC-PTSD-5, AUDIT-C, …). Captured as labeled
 * CONTEXT for the letter narrative — NEVER as a diagnosis or chart problem (Ryan standing rule: a
 * screen confirms nor refutes a condition). Grounded like every other item (verbatim quote on the
 * cited page). Full-read path only.
 */
export interface ScreeningResult {
  instrument: string;   // e.g. "PHQ-9", "GAD-7", "PC-PTSD-5"
  score: string;        // as written: "18", "2/5", "moderate"
  date: string | null;  // screen date if stated
  sourceDocumentId: string;
  sourcePage: number;
  sourceQuote: string;
  confidence: number;
}

export interface ExtractionResult {
  items: FinalExtractedItem[];
  windowsProcessed: number;
  rawCount: number;
  droppedUngrounded: number;
  droppedLowConfidence: number;
  droppedDuplicate: number;
  // NO-SILENT-TRUNCATION (Ryan 2026-06-13, $500-stakes): count windows/chunks where the model hit
  // max_tokens and its tool-array was cut off mid-stream — those LOST items we never saw. In the
  // full-read path a truncated chunk is split-retried; this counts any that stayed truncated at the
  // floor. Surfaced loudly so a short chart is never mistaken for a complete one.
  truncatedWindows: number;
  costUsd: number;
  model: string;
  // Full-read path (CHART_EXTRACT_FULLREAD) telemetry. fullRead distinguishes the two paths;
  // chunksProcessed/uncoveredPages are 0/absent on the windowed path.
  fullRead: boolean;
  chunksProcessed?: number;
  uncoveredPages?: number;
  // Screening data points (PHQ-9/GAD-7/PC-PTSD/AUDIT-C) — labeled context for the letter, NEVER
  // written as chart problems/conditions. Full-read path only (undefined on the windowed path).
  screenings?: ScreeningResult[];
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_chart_items',
  description:
    'Record the structured chart items found VERBATIM in the provided document section. ' +
    'Only emit an item if it literally appears in the text. Never infer, never add conditions ' +
    'the veteran might have. Each item must carry the exact page it appears on and a verbatim quote.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The condition / problem / medication name, as written.' },
            status: {
              type: 'string',
              enum: ['service_connected', 'pending', 'denied'],
              description: 'SC conditions only: service_connected if granted, denied if the doc is a denial of THIS condition, pending if awaiting decision.',
            },
            ratingPct: { type: 'integer', description: 'SC conditions only: the rating percentage if explicitly stated.' },
            dcCode: { type: 'string', description: 'SC conditions only: the BARE VA diagnostic code ALONE (the digits, e.g. "6260") if explicitly stated — the code ONLY, never the condition name or any words. Omit if not shown.' },
            icd10: { type: 'string', description: 'Problems only: the BARE ICD-10 code ALONE if explicitly present, e.g. "G47.33" or "M54.50" — the code ONLY, NEVER the diagnosis name or any words (the name belongs in name). Omit entirely if no code is printed.' },
            dose: { type: 'string', description: 'Medications only: dose/strength as written (e.g. "10 mg").' },
            frequency: { type: 'string', description: 'Medications only: frequency/sig as written.' },
            indication: { type: 'string', description: 'Medications only: what the medication is for, if explicitly stated.' },
            sourcePage: { type: 'integer', description: 'The [p.N] page number this item appears on.' },
            sourceQuote: { type: 'string', description: 'A short VERBATIM substring from that page proving the item (copy exactly).' },
            confidence: { type: 'number', description: '0..1 — how clearly this is an explicit charted item (not prose mention).' },
          },
          required: ['name', 'sourcePage', 'sourceQuote', 'confidence'],
        },
      },
    },
    required: ['items'],
  },
};

const CATEGORY_GUIDANCE: Record<ExtractCategory, string> = {
  sc_condition:
    'Extract VA SERVICE-CONNECTED / rated disabilities (granted, pending, or denied). Set status. ' +
    'If this is a benefit-summary letter that only states a COMBINED percentage without itemizing ' +
    'individual conditions, do NOT invent the individual conditions — emit nothing rather than guess.',
  active_problem:
    'Extract entries from the Active Problems / Computerized Problem List only. One row per problem.',
  active_medication:
    'Extract entries from the Active Outpatient Medications list only. One row per medication, with dose/frequency if written.',
};

function systemPrompt(category: ExtractCategory): string {
  return [
    'You parse a single pre-isolated section of a veteran\'s VA medical record into structured rows.',
    'The VA document is the source of truth. Extract ONLY what is literally present in the text.',
    'NEVER infer, NEVER add items the veteran "might" have, NEVER fabricate codes or percentages.',
    'Every item needs the exact [p.N] page it appears on and a short verbatim sourceQuote copied from that page.',
    'If the section contains no extractable items of this type, return an empty items array.',
    CATEGORY_GUIDANCE[category],
  ].join('\n');
}

function windowUserPrompt(w: SectionWindow): string {
  return `CATEGORY: ${w.category}\nDOCUMENT: ${w.filename}\n\nSECTION TEXT (page-marked):\n${w.text}`;
}

/** Pure: validate + coerce the model's tool output for ONE window into RawExtractedItems. */
export function coerceRawItems(toolInput: unknown, window: SectionWindow): RawExtractedItem[] {
  const obj = toolInput as { items?: unknown };
  if (!obj || !Array.isArray(obj.items)) return [];
  const out: RawExtractedItem[] = [];
  for (const raw of obj.items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.trim().length === 0) continue;
    if (typeof r.sourcePage !== 'number' || typeof r.sourceQuote !== 'string') continue;
    if (typeof r.confidence !== 'number') continue;
    out.push({
      category: window.category,
      name: r.name.trim(),
      status: sanitizeScStatus(r.status),
      dcCode: sanitizeCode16(r.dcCode),
      ratingPct: sanitizeRatingPct(r.ratingPct),
      icd10: sanitizeIcd10(r.icd10),
      dose: typeof r.dose === 'string' ? r.dose : undefined,
      frequency: typeof r.frequency === 'string' ? r.frequency : undefined,
      indication: typeof r.indication === 'string' ? r.indication : undefined,
      sourceDocumentId: window.documentId, // injected — unambiguous, the model never sees it
      sourcePage: Math.trunc(r.sourcePage),
      sourceQuote: r.sourceQuote,
      confidence: Math.max(0, Math.min(1, r.confidence)),
    });
  }
  return out;
}

// ── Combined-category tool/prompt for the full-read chunker ──
// One pass per chunk extracts ALL THREE categories (the model tags each item's `category`), so a
// complete-read chunk is read ONCE, not three times. Same grounding contract: exact page + verbatim
// quote. The injected sourceDocumentId still comes from the chunk — the model never picks it.
const EXTRACT_TOOL_COMBINED: Anthropic.Tool = {
  name: 'record_chart_items',
  description:
    'Record EVERY structured chart item found VERBATIM in the provided document chunk — across all ' +
    'three categories. Capture every condition that carries a VA benefit-status signal (granted / ' +
    'pending / denied / deferred / a rating %) as an sc_condition, and every bare clinical diagnosis ' +
    'as an active_problem. Only emit an item if it literally appears in the text. Each item carries ' +
    'its category, exact page, and a verbatim quote.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['sc_condition', 'active_problem', 'active_medication', 'screening'],
              description: 'sc_condition = a condition the veteran is service-connected for OR claiming (any benefit status: granted/pending/denied/deferred); active_problem = a CURRENTLY ACTIVE bare clinical diagnosis/problem with no benefit-status signal (NOT a resolved/inactive entry and NOT a "history of"/"h/o" past mention); active_medication = an Active Medications entry or a drug named in a note; screening = a screening-instrument result (PHQ-9/GAD-7/PC-PTSD-5/AUDIT-C) — a DATA POINT, never a diagnosis.',
            },
            name: { type: 'string', description: 'For a condition/problem: the DIAGNOSIS as written (a body part / disease / disorder) — NEVER a percentage, the word "Combined", or the bare phrase "service-connected" (those are a rating/status, not a name; the % goes in ratingPct). For a medication: the DRUG NAME ONLY (generic or brand, e.g. "fluoxetine", "Lexapro") — do NOT include dose, strength, or form in the name; those go in dose. For a screening: the instrument name (e.g. "PHQ-9").' },
            status: { type: 'string', enum: ['service_connected', 'pending', 'denied'], description: 'sc_condition only: service_connected if granted/rated/"service-connected", denied if THIS condition is denied, pending if claimed/under review/deferred (e.g. a "Conditions claimed" or claim-status list). Always set it.' },
            ratingPct: { type: 'integer', description: 'sc_condition only: rating percentage if explicitly stated.' },
            dcCode: { type: 'string', description: 'sc_condition only: the BARE VA diagnostic code ALONE (the digits, e.g. "6260") if explicitly stated — the code ONLY, never the condition name or any words. Omit if not shown.' },
            icd10: { type: 'string', description: 'active_problem only: the BARE ICD-10 code ALONE if explicitly present, e.g. "G47.33" or "M54.50" — the code ONLY, NEVER the diagnosis name or any words (the name belongs in name). Omit entirely if no code is printed.' },
            dose: { type: 'string', description: 'active_medication only: dose/strength as written (e.g. "10 mg").' },
            frequency: { type: 'string', description: 'active_medication only: frequency/sig as written.' },
            indication: { type: 'string', description: 'active_medication only: what the medication is for, if explicitly stated.' },
            medStatus: { type: 'string', enum: ['active', 'discontinued', 'historical', 'unknown'], description: 'active_medication only: "active" if under an Active Medications list or status=ACTIVE; "discontinued" if marked discontinued/D/C/expired; "historical" if named only in a dated progress note (a past mention); "unknown" if no signal. NEVER infer from absence elsewhere.' },
            startDate: { type: 'string', description: 'active_medication only: the START/ISSUE date, verbatim, ONLY if a field labeled Start Date/Issued/Issue Date appears for THIS drug. NOT the note date, NOT the fill date. Else omit.' },
            lastSeenDate: { type: 'string', description: 'active_medication only: the Last Filled/Last Release date if labeled, OR — for a drug named inside a dated progress note — that note\'s date (when the drug was REFERENCED, not when it started/stopped). Else omit.' },
            score: { type: 'string', description: 'screening only: the score as written (e.g. "18", "2/5", "moderate").' },
            screenDate: { type: 'string', description: 'screening only: the administration/collection date of THIS screen, copied EXACTLY as written in the doc (e.g. "04/12/2026", "April 12, 2026", "2026-04-12", or a "Date of visit/administration" / header / column date next to the score). If several dates appear on the page (a DOB, a print/visit date, or a neighboring screen\'s date), use ONLY the one administering THIS screen; if you cannot tell which date is this screen\'s, omit it — never guess. Omit if no date is shown for this screen — never invent one. The date must belong to this screen on this same [p.N] page.' },
            sourcePage: { type: 'integer', description: 'The [p.N] page number this item appears on.' },
            sourceQuote: { type: 'string', description: 'A short VERBATIM substring from that page proving the item (copy exactly).' },
            confidence: { type: 'number', description: '0..1 — how clearly this is an explicit charted item (not a prose mention).' },
          },
          required: ['category', 'name', 'sourcePage', 'sourceQuote', 'confidence'],
        },
      },
    },
    required: ['items'],
  },
};

export function combinedSystemPrompt(): string {
  return [
    'You parse a chunk of a veteran\'s VA medical record into structured rows across THREE categories:',
    '  - sc_condition: a condition the veteran is service-connected for OR is claiming for VA benefits — together with its benefit status.',
    '  - active_problem: a clinical diagnosis or problem from the care record (Problem List, progress note, assessment).',
    '  - active_medication: a drug from an Active (Outpatient) Medications list or named in a note.',
    'The VA document is the source of truth. Extract ONLY what is literally present in the text — never infer a condition, code, or percentage that is not written.',
    'Set `category` correctly on every item. Every item carries the exact [p.N] page it appears on and a short verbatim sourceQuote copied from that page.',
    '',
    // ── THE ONE RULE that separates sc_condition from active_problem (Ryan 2026-06-13). The Woodley
    // miss (PTSD/Sleep Apnea/CFS dropped) AND the over-emission (H. pylori gastritis/hiatal hernia/PUD
    // emitted as SC) are the SAME failure: the old prompt keyed SC on "rated disability" instead of on
    // a benefit-status signal. A condition is SC iff it sits next to a benefit-status signal; a bare
    // clinical diagnosis with no such signal is a problem, not an SC condition.
    'CAPTURE AS sc_condition: every condition that appears next to a VA BENEFIT-STATUS SIGNAL. The signal is what makes it service-connection, not the diagnosis itself. Signals — capture the condition whenever you see one beside it:',
    '  - granted  → "Service connection for X is granted / has been established", "Service connection for X is granted with an evaluation of N percent", "an evaluation of N percent is assigned for X", "X is N percent disabling", "service-connected", "SC", a rating % or diagnostic code shown for the condition. A 0 percent GRANT ("granted with an evaluation of 0 percent") is STILL service_connected — a grant at a noncompensable rating, NOT a denial.',
    // CONTINUATION-GRANT form (continuation-grant fix, Ryan 2026-07-19). A rating decision that CONTINUES /
    // CHANGES an already-granted evaluation ("Evaluation of X … is continued/increased/decreased") was being
    // misread as pending. An *evaluation* only exists once granted, so this CONFIRMS an existing grant.
    '  - granted (continued) → "Evaluation of X, [which is] currently N percent [disabling], is continued / increased / decreased" CONFIRMS an EXISTING grant → service_connected (carry the N% into ratingPct). An evaluation exists only after a grant, so a continuation/increase/decrease of one is service_connected, NOT pending.',
    '  - denied   → "Service connection for X is denied / is not warranted / is not established", "X (denied)".',
    '  - BUT "the previous denial of service connection for X is confirmed and continued" or "X remains denied" is a CONTINUED DENIAL → denied (NOT a grant): a denial has no evaluation, so "confirmed and continued" here continues the denial, not a grant.',
    '  - pending  → a claim list or intake summary — "Claimed conditions", "Conditions claimed", a claim-status / "Your claims" page — listing the condition as claimed / pending / under review / received.',
    '  - deferred → "Service connection for X is deferred", "X — deferred pending ...".',
    'These live in MANY document types — rating decisions, code sheets, benefit/award letters, the 21-526EZ claim, AND claim-status / intake-summary lists. A claim that is only pending or denied is STILL an sc_condition; do not wait for a "granted" sentence. Capture EACH listed condition as its own row with its own status (+ ratingPct + dcCode when shown), even when a single rating-decision page itemizes many.',
    // MIXED GRANT/DENIAL RECALL (Hackworth / CLM-9925837B7B, 2026-06-20). The model read a numbered
    // DECISION page, emitted every DENIAL, and silently DROPPED all four GRANTS ("chronic headaches
    // granted 50%", tinnitus 10%, ...) — a dominant-disposition pattern-completion. A dropped grant
    // empties granted_service_connections and the drafter halts. Force item-by-item enumeration.
    'WALK EVERY NUMBERED DECISION LINE. A VA rating decision has a numbered "DECISION" section that interleaves grants AND denials ("1. ... is granted ... 2. ... is denied ... 3. ... is granted ..."). Emit one sc_condition row for EVERY numbered line, item by item — do NOT skip the grants because the page also lists denials, and do not skip the denials because the page also lists grants. A grant and a denial on the same page are EQUALLY required; a page that mixes both is the rule, not the exception. Re-read the DECISION list and confirm you emitted one row per line before moving on.',
    '  - USE THE SPECIFIC NAMED CONDITION exactly as written. "Sigmoid Colitis", "Ulcerative Colitis", and "GERD" are SEPARATE rows — never collapse distinct conditions into an umbrella like "gastrointestinal problems".',
    // NAME MUST BE A DIAGNOSIS, NEVER A RATING (extraction precision (Woodley), 2026-06-13). Woodley's
    // SC tab showed a single row "90% service-connected" — the model put the COMBINED PERCENTAGE in the
    // `name` field and captured zero named conditions. The `name` is ALWAYS the condition's diagnosis
    // (a body part / disease / disorder); a percentage, the word "combined", or the bare phrase
    // "service-connected" is a STATUS, never a name. The percentage belongs in ratingPct, the status in
    // status — never in name.
    '  - THE name FIELD IS A DIAGNOSIS, NOT A RATING. name is the medical condition (e.g. "Other Specified Trauma or Stressor-Related Disorder", "Tinnitus", "Lumbar Strain"). NEVER put a percentage, the word "Combined", or the bare phrase "service-connected" in name. If the only thing beside a percentage is "service-connected" with NO condition diagnosis attached, that is a COMBINED/total line — do NOT emit it (see below). A row whose name would be "90% service-connected" or "Combined" is WRONG: drop it and instead capture the individually-named conditions that the page itemizes.',
    '',
    'KEEP OUT of sc_condition (these are active_problem instead): a clinical diagnosis written in a progress note, assessment, problem list, or C&P narrative with NO benefit-status signal next to it. A real diagnosis like "H. pylori gastritis", "hiatal hernia", or "peptic ulcer disease" mentioned in a GI note is an active_problem — it only becomes an sc_condition if that same record shows it claimed, granted, denied, or rated. When in doubt and there is no status signal, emit it as active_problem, not sc_condition.',
    '',
    // THE COMBINED-LINE TRAP, HARDENED (extraction precision (Woodley), 2026-06-13). A VA rating decision
    // ALWAYS shows the per-condition grants (each with its own name + %) AND a single "Combined
    // evaluation: N%" / "Combined rating" total. Capture the NAMED ones; NEVER the combined total. The
    // combined % is a mathematical roll-up (VA combined-ratings table), not a disability — emitting it as
    // a condition both fabricates a non-existent "condition" AND tends to crowd out the real named rows.
    'NEVER EMIT A COMBINED / OVERALL / TOTAL RATING AS A CONDITION. A line like "Combined evaluation: 90%", "combined rating 90%", "your overall/total evaluation is 90 percent", or a bare "90% service-connected" with no condition diagnosis on it is the SUM across all disabilities — it is NOT a disability and has NO name. Do NOT emit it as an sc_condition. On a rating decision that lists named conditions AND a combined total, capture EACH NAMED condition with its own % and DROP the combined line entirely. If a letter gives ONLY a combined % and never itemizes the conditions, emit nothing for those rather than invent names.',
    'ONE MORE THING THAT IS NOT an sc_condition: a screening score (see below).',
    'EXAMPLES (sc_condition vs active_problem):',
    '  "[p.14] Conditions claimed: 1. PTSD (pending) 2. Sleep apnea (pending) 3. Chronic fatigue syndrome (denied)" → THREE sc_condition rows: {category:sc_condition,name:"PTSD",status:"pending"}, {category:sc_condition,name:"Sleep apnea",status:"pending"}, {category:sc_condition,name:"Chronic fatigue syndrome",status:"denied"}.',
    '  "[p.902] Assessment: H. pylori gastritis; hiatal hernia. Continue PPI." → TWO active_problem rows (no benefit-status signal): {category:active_problem,name:"H. pylori gastritis"}, {category:active_problem,name:"hiatal hernia"}. NOT sc_condition.',
    // The exact Woodley rating-decision shape: named grants + a combined total on one page. Forces the
    // right split — three NAMED rows, and the combined line emitted as NOTHING.
    '  "[p.5] Other Specified Trauma or Stressor-Related Disorder ... 70% ... Tinnitus ... 10% ... Lumbar Strain ... 20% ... Combined evaluation: 90%" → THREE sc_condition rows: {category:sc_condition,name:"Other Specified Trauma or Stressor-Related Disorder",status:"service_connected",ratingPct:70}, {category:sc_condition,name:"Tinnitus",status:"service_connected",ratingPct:10}, {category:sc_condition,name:"Lumbar Strain",status:"service_connected",ratingPct:20}. The "Combined evaluation: 90%" line is emitted as NOTHING — it is a total, not a condition.',
    '  "[p.3] Combined evaluation: 90%" → emit NOTHING (a combined/total, not a condition).',
    // The mixed grant/denial page the model failed on (Hackworth). Denials present must NOT suppress grants.
    '  "[p.13] DECISION: 1. Service connection for chronic headaches is granted with an evaluation of 50 percent. 2. Service connection for tinnitus is granted, 10 percent. 3. Service connection for sleep apnea is denied. 4. Service connection for a low back condition is deferred." → FOUR sc_condition rows, one per numbered line: {category:sc_condition,name:"chronic headaches",status:"service_connected",ratingPct:50}, {category:sc_condition,name:"tinnitus",status:"service_connected",ratingPct:10}, {category:sc_condition,name:"sleep apnea",status:"denied"}, {category:sc_condition,name:"low back condition",status:"deferred"}. The grants are NOT dropped because denials/deferrals appear on the same page.',
    '',
    // BLUE BUTTON STRUCTURE (Ryan 2026-06-13): VA Blue Button / CAPRI reports are templated — the
    // problem and medication lists sit under stable headers. Naming them lifts recall on the
    // routine sections the same way the rating-decision phrases do for SC grants.
    'BLUE BUTTON SECTION HEADERS — extract every row beneath these when present:',
    '  active_problem: "Problem List" / "VA Problem List" / "Computerized Problem List" — one row per listed problem (with its ICD-10 if shown).',
    '  active_medication: "Active Medications" / "Active Outpatient Medications" / "Medications" — one row per drug (with dose/frequency/sig as written).',
    '',
    // ACTIVE-PROBLEM PRECISION (extraction precision (Woodley), 2026-06-13). The full read now reads
    // every page, and the model was recording RESOLVED / historical / duplicate lines as ACTIVE — Woodley
    // came back with 147 "active problems", implausible for one veteran. active_problem means a CURRENT,
    // ACTIVE diagnosis. Bias is asymmetric on purpose: NEVER drop a real active dx (a lost dx breaks the
    // letter), but DO stop recording the obviously-resolved / "history of" / duplicate lines as active.
    'active_problem MEANS A CURRENTLY ACTIVE PROBLEM — not every diagnosis ever mentioned. Apply these rules:',
    '  - DO NOT emit a problem that is marked RESOLVED / INACTIVE / "resolved" / a struck-through or dated-resolved entry, or that is explicitly in a Resolved/Inactive/Past Medical History list. A "Date Resolved" populated for the row = resolved; do not emit it as active.',
    '  - DO NOT emit a "history of" / "h/o" / "hx of" / "s/p" (status-post) / "in remission" mention as an active problem — that phrasing states a PAST condition, not a current active one. (A genuinely current chronic dx written plainly — "Hypertension", "PTSD" — IS active; the guard is the explicit past/resolved wording, not the diagnosis itself.)',
    '  - DE-DUPLICATE: if the SAME diagnosis appears multiple times (repeated across pages, or listed once active and once resolved), emit it ONCE as active. Do not emit one row per occurrence of the same problem.',
    '  - WHEN THE STATUS IS GENUINELY UNCLEAR — a problem-list row with no resolved marker and no "history of" wording — KEEP IT as active. Never drop a real diagnosis because you are unsure; only the EXPLICIT resolved / past-tense / duplicate signals above remove a row. Under-pruning (a stray active row) is acceptable; losing a real active dx is not.',
    'EXAMPLES (active_problem precision):',
    '  "[p.20] Problem List: Hypertension (active); Tobacco use disorder, resolved 2019; History of appendectomy; Hypertension" → ONE active_problem row {category:active_problem,name:"Hypertension"} (the resolved tobacco line, the "History of appendectomy" line, and the duplicate Hypertension are all NOT emitted as active).',
    '  "[p.21] Active Problems: 1. PTSD 2. Obstructive sleep apnea 3. Chronic low back pain" → THREE active_problem rows (no resolved/past markers — all current).',
    '',
    // MEDICATION TEMPORALITY (Ryan 2026-06-13): a flat "active" list is wrong — the owner wants the
    // treatment HISTORY with dates + an active-vs-old split. Set from EXPLICIT page signals ONLY.
    'MEDICATION STATUS AND DATES (active_medication) — set from EXPLICIT page signals only, never inference:',
    '  - A medication under "Active Medications"/"Active Outpatient Medications", or whose row status reads ACTIVE, is medStatus="active".',
    '  - A medication marked DISCONTINUED / "D/C" / discontinued / EXPIRED, or under a Discontinued/Expired list, is medStatus="discontinued".',
    '  - A medication named only inside a dated progress note (not a medications list) is medStatus="historical": put that note\'s date in lastSeenDate. A past mention does NOT mean it is currently active or has stopped.',
    '  - If no status word and no list context tell you, set medStatus="unknown". Do not guess.',
    '  - DATES: copy a date into startDate ONLY if a field labeled Start Date/Issued/Issue Date appears for that drug. Copy lastSeenDate from a labeled Last Filled/Last Release date OR (for a note mention) the note\'s date. If a date is not written next to the drug, omit it — never compute, estimate, or carry a date from another drug or page.',
    '  - Any date you put in startDate or lastSeenDate MUST appear inside the sourceQuote you copy. Quote the line containing the date. If you cannot quote the date, omit that date field.',
    '  - The SAME drug may legitimately appear many times across years. Emit each dated occurrence with its own page, quote, and date — do NOT merge them or decide which is "current." Capturing every dated occurrence is the goal.',
    '  - NAME = the drug only. Put the strength/dose ("20 mg", "0.65% soln") in dose and the form in dose if needed — NEVER repeat the dose in the name, and never write the dose twice. Do NOT prefix source qualifiers like "Non-VA" into the name. "Non-VA FLUOXETINE 20MG CAP" → name="fluoxetine", dose="20 mg". This keeps the same drug from splitting into many rows.',
    'EXAMPLES (medication dating):',
    '  "[p.412] ACTIVE OUTPATIENT MEDICATIONS  FLUOXETINE 20MG CAP  Take one daily  Start Date: 03/12/2015  Last Filled: 11/02/2025" → {category:active_medication, name:"fluoxetine", dose:"20 mg", medStatus:"active", startDate:"03/12/2015", lastSeenDate:"11/02/2025", sourceQuote:"FLUOXETINE 20MG CAP ... Start Date: 03/12/2015 Last Filled: 11/02/2025"}',
    '  "[p.88] 06/14/2022 Progress Note ... Patient reports starting sertraline last month, tolerating well." → {category:active_medication, name:"sertraline", medStatus:"historical", lastSeenDate:"06/14/2022", sourceQuote:"06/14/2022 Progress Note ... starting sertraline"} (startDate omitted — "last month" is not a written date).',
    // PRECISION GUARD (Ryan standing rule: a screen is NOT a diagnosis): keep screening instruments
    // out of the problem/condition rows so a positive score never becomes a fabricated dx.
    // SCREENING DATE CAPTURE (Dr. Kasky #70, 2026-06-25; QA-tightened): the read works but dates came back
    // empty. The administration date almost always IS on the page — in a header ("Date: 04/12/2026"), a row
    // label, a "Date of visit/administration" field, or a column beside the score — just not always on the
    // same line as the score. Capture THIS screen's own date into screenDate (verbatim) — prefer a
    // sourceQuote that also contains it. A bundled mental-health page can show several dates (a DOB, a
    // print/visit date, another screen's date): use ONLY the one administering THIS screen; if you cannot
    // tell which date is this screen's, omit it — never guess (the grounding gate also requires the date to
    // be in this screen's quote OR near its instrument/score, so a far-off neighbor date is dropped anyway).
    // Common formats: MM/DD/YYYY, "Month DD, YYYY", YYYY-MM-DD. Copy it exactly — do NOT reformat.
    'SCREENS ARE NOT DIAGNOSES: PHQ-9, GAD-7, PC-PTSD-5, AUDIT-C and similar screening scores are DATA POINTS, not conditions. Capture each as category "screening" with name=instrument, score, and screenDate — the administration/collection date copied EXACTLY as written, whenever a date for that screen appears anywhere on the page (header, "Date of visit/administration" field, row label, or column beside the score). Common formats: MM/DD/YYYY, "Month DD, YYYY", YYYY-MM-DD. If several dates appear on the page (a DOB, a print/visit date, or another screen\'s date), use ONLY the date administering THIS screen; if you cannot tell which date belongs to this screen, omit it (null) — never guess. Omit screenDate only if no date is shown for the screen; never invent one. NEVER emit a screen as an active_problem or sc_condition, and never turn a positive screen into a diagnosis — only an actual charted diagnosis or a VA service-connection determination is a condition.',
    'This chunk may contain none, some, or all three categories. Return every item you find; return an empty items array if there are none.',
  ].join('\n');
}

function chunkUserPrompt(chunk: { filename: string; text: string }): string {
  return `DOCUMENT: ${chunk.filename}\n\nCHUNK TEXT (page-marked):\n${chunk.text}`;
}

/** Pure: validate + coerce the combined tool output for ONE chunk into RawExtractedItems. */
export function coerceRawItemsCombined(toolInput: unknown, documentId: string): RawExtractedItem[] {
  const obj = toolInput as { items?: unknown };
  if (!obj || !Array.isArray(obj.items)) return [];
  const valid: ExtractCategory[] = ['sc_condition', 'active_problem', 'active_medication'];
  const out: RawExtractedItem[] = [];
  for (const raw of obj.items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.category !== 'string' || !valid.includes(r.category as ExtractCategory)) continue;
    if (typeof r.name !== 'string' || r.name.trim().length === 0) continue;
    if (typeof r.sourcePage !== 'number' || typeof r.sourceQuote !== 'string') continue;
    if (typeof r.confidence !== 'number') continue;
    out.push({
      category: r.category as ExtractCategory,
      name: r.name.trim(),
      status: sanitizeScStatus(r.status),
      dcCode: sanitizeCode16(r.dcCode),
      ratingPct: sanitizeRatingPct(r.ratingPct),
      icd10: sanitizeIcd10(r.icd10),
      dose: typeof r.dose === 'string' ? r.dose : undefined,
      frequency: typeof r.frequency === 'string' ? r.frequency : undefined,
      indication: typeof r.indication === 'string' ? r.indication : undefined,
      medStatus: ['active', 'discontinued', 'historical', 'unknown'].includes(r.medStatus as string) ? (r.medStatus as RawExtractedItem['medStatus']) : undefined,
      startDate: typeof r.startDate === 'string' && r.startDate.trim() ? r.startDate.trim() : undefined,
      lastSeenDate: typeof r.lastSeenDate === 'string' && r.lastSeenDate.trim() ? r.lastSeenDate.trim() : undefined,
      sourceDocumentId: documentId, // injected — unambiguous, the model never sees it
      sourcePage: Math.trunc(r.sourcePage),
      sourceQuote: r.sourceQuote,
      confidence: Math.max(0, Math.min(1, r.confidence)),
    });
  }
  return out;
}

/** Pure: pull the screening data points (category 'screening') from a chunk's combined tool output. */
export function coerceScreenings(toolInput: unknown, documentId: string): ScreeningResult[] {
  const obj = toolInput as { items?: unknown };
  if (!obj || !Array.isArray(obj.items)) return [];
  const out: ScreeningResult[] = [];
  for (const raw of obj.items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r.category !== 'screening') continue;
    if (typeof r.name !== 'string' || r.name.trim().length === 0) continue;
    if (typeof r.sourcePage !== 'number' || typeof r.sourceQuote !== 'string') continue;
    if (typeof r.confidence !== 'number') continue;
    out.push({
      instrument: r.name.trim(),
      score: typeof r.score === 'string' ? r.score : typeof r.score === 'number' ? String(r.score) : '',
      date: typeof r.screenDate === 'string' && r.screenDate.trim().length > 0 ? r.screenDate.trim() : null,
      sourceDocumentId: documentId,
      sourcePage: Math.trunc(r.sourcePage),
      sourceQuote: r.sourceQuote,
      confidence: Math.max(0, Math.min(1, r.confidence)),
    });
  }
  return out;
}

/**
 * Date anti-fabrication for a screening (Dr. Kasky #70, 2026-06-25; tightened by QA 2-agent pass).
 * The recurring miss was NOT the read — the model captures the score — it was the DATE coming back
 * empty. Root cause: the old gate required the date to be a RAW substring of the short proving-quote
 * (`sourceQuote.includes(date)`). A screening's administration date sits on the SAME page as the score
 * but routinely on a different line (a header "Date: 04/12/2026", a row label, a separate column), so
 * the short score-quote rarely contains it — and OCR whitespace/case noise breaks even a raw match.
 *
 * The first relaxation (date anywhere on the cited page) over-corrected: a bundled VA mental-health
 * page can carry a PHQ-9 + a GAD-7 + a DOB + a visit/print date all at once. A page-scope match proves
 * "the date is ON the page" but NOT "the date belongs to THIS screen" — so the model could emit a
 * neighboring screen's date (or a DOB) and it would ground, surfacing a WRONG administration date
 * (medico-legal: a wrong date can reach the doctor's read / the letter). Same gap the SOAP measurement
 * label-proximity fix closed.
 *
 * Fix (quote-first, then proximity — mirrors isGroundedNearLabel in soap-overview):
 *   1. Prefer the screen's OWN proving-quote — if sourceQuote contains the date (tolerant/normalized),
 *      accept it. The quote is label-adjacent by construction, so this is the tightest, surest path.
 *   2. Only when the quote lacks the date, FALL BACK to the page — and require PROXIMITY: the date must
 *      appear within DATE_PROXIMITY_WINDOW chars of THIS screen's instrument NAME or score on the page.
 *      A date near "PHQ-9"/"Score: 18" is this screen's date; a DOB or a different screen's date sitting
 *      far away does NOT borrow this screen's label.
 * Ambiguity → drop: if neither the quote nor a near-anchor occurrence proves the date belongs to this
 * screen, we return false (the date is nulled → "date not documented"). Conservative: prefer dropping
 * a guessed date over surfacing a wrong one. Substring match only — never parse/normalize the date
 * value itself (that is where the Jotform-TZ class of date-format bugs creep in); we surface the date
 * verbatim as the model copied it. Fail-open: no/ambiguous date → false → null, never a crash.
 */
// Proximity window (chars) on EACH side of a date occurrence within which the screen's instrument name
// or score must appear for the date to be accepted as THIS screen's date (page-fallback only). ~70
// comfortably spans a header sitting a line or two above the score ("Date: 04/12/2026\nPHQ-9 Depression
// Screen\nScore: 18"), while being tight enough that a neighboring screen's date or a DOB elsewhere on a
// bundled mental-health page does not borrow this screen's label.
const DATE_PROXIMITY_WINDOW = 70;

function dateGroundedOnPage(documents: BundleDocument[], s: ScreeningResult): boolean {
  if (!s.date) return false;
  const needle = normalizeForQuoteMatch(s.date);
  if (needle.length === 0) return false;

  // 1. QUOTE-FIRST: the screen's own proving-quote is label-adjacent. A date inside it is unambiguously
  //    this screen's date — accept (tolerant/normalized, OCR-noise safe).
  if (normalizeForQuoteMatch(s.sourceQuote).includes(needle)) return true;

  // 2. PAGE FALLBACK with PROXIMITY: the quote lacks the date, so look on the cited page — but only
  //    accept a date occurrence that sits within the window of this screen's instrument NAME or score.
  const doc = documents.find((d) => d.id === s.sourceDocumentId);
  const page = doc?.pages.find((p) => p.pageNumber === s.sourcePage);
  if (!page) return false;
  const ctx = normalizeForQuoteMatch(page.text);

  // The anchors that mark THIS screen on the page: its instrument name and (if present) its score.
  const anchors = [normalizeForQuoteMatch(s.instrument), normalizeForQuoteMatch(s.score)]
    .filter((a) => a.length > 0);
  if (anchors.length === 0) return false; // nothing to anchor to → can't prove ownership → drop

  let from = 0;
  for (;;) {
    const at = ctx.indexOf(needle, from);
    if (at < 0) break;
    const winStart = Math.max(0, at - DATE_PROXIMITY_WINDOW);
    const winEnd = Math.min(ctx.length, at + needle.length + DATE_PROXIMITY_WINDOW);
    const win = ctx.slice(winStart, winEnd);
    if (anchors.some((a) => win.includes(a))) return true; // a date occurrence near this screen = its date
    from = at + needle.length;
  }
  return false; // date present on the page but never near THIS screen → ambiguous → drop (null)
}

/** Pure: ground screenings (verbatim quote on the cited page) + dedup on (instrument, date, score). */
export function groundScreenings(documents: BundleDocument[], raw: ScreeningResult[]): ScreeningResult[] {
  const seen = new Set<string>();
  const out: ScreeningResult[] = [];
  for (const s0 of raw) {
    if (!groundExtractedItem(documents, s0)) continue;
    // Keep the date only if it genuinely appears on the cited page (tolerant, normalized match — see
    // dateGroundedOnPage). A date present nowhere on the page is fabricated → null it (fail-open).
    const s: ScreeningResult = s0.date && !dateGroundedOnPage(documents, s0) ? { ...s0, date: null } : s0;
    const key = `${s.instrument.toLowerCase()}::${s.date ?? ''}::${s.score.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Date anti-fabrication: the grounding gate proves the QUOTE is on the page, but a med date lives in
 * a separate field the gate never inspects — a model could quote a real drug line and invent a date.
 * After grounding, null out any med date that is not a substring of the (already on-page) sourceQuote.
 * This makes the grounding gate transitively cover the date (quote on page + date in quote = date on
 * page). Substring, not date-parsing — never interpret/normalize a date (that's where fabrication and
 * the Jotform-TZ class of bug creep in). Meds only; other categories pass through untouched.
 */
function scrubUnquotedDates(it: RawExtractedItem): RawExtractedItem {
  if (it.category !== 'active_medication') return it;
  const q = it.sourceQuote;
  const keep = (d?: string): string | undefined => (d && q.includes(d) ? d : undefined);
  return { ...it, startDate: keep(it.startDate), lastSeenDate: keep(it.lastSeenDate) };
}

/**
 * Status↔quote consistency gate (audit 2026-06-13 ROOT FIX). groundExtractedItem proves the sourceQuote
 * is verbatim on the page, but NEVER checks that the emitted SC `status` is consistent with that quote —
 * so a model could quote a real "denied" line and tag it service_connected, and grounding still passes.
 * SC status is the single highest-stakes chart field (case-framing builds grantedScAnchors off
 * status==='service_connected'). This makes grounding transitively cover `status`: an sc_condition keeps
 * its status ONLY if the grounded quote actually supports it. Mismatch → drop status to undefined (the
 * merge then defaults to 'pending', never the privileged service_connected, and it surfaces for RN
 * confirmation). Precedence: a DENIAL phrasing can never validate a service_connected tag. Over-drops on
 * a terse/mixed quote fail SAFE (pending), never to a fabricated grant. (Sibling to scrubUnquotedDates.)
 */
const STATUS_QUOTE_KEYWORDS: Record<'service_connected' | 'pending' | 'denied', RegExp> = {
  service_connected: /service[- ]?connect|granted|grant\b|rated\b|\b\d{1,3}\s?%/i,
  denied: /denied|denial|not warranted|not established|not service[- ]?connect/i,
  pending: /claim|pending|under review|deferred|received/i,
};
function statusFromQuote(q: string): 'service_connected' | 'pending' | 'denied' | null {
  if (STATUS_QUOTE_KEYWORDS.denied.test(q)) return 'denied'; // denial wins — a denial line can't be read as a grant
  if (STATUS_QUOTE_KEYWORDS.service_connected.test(q)) return 'service_connected';
  if (STATUS_QUOTE_KEYWORDS.pending.test(q)) return 'pending';
  return null;
}
function scrubInconsistentStatus(it: RawExtractedItem): RawExtractedItem {
  if (it.category !== 'sc_condition' || !it.status) return it;
  return statusFromQuote(it.sourceQuote) === it.status ? it : { ...it, status: undefined };
}

/**
 * Completeness score for picking the survivor among duplicate rows (full-read preferMoreComplete
 * only; windowed keeps first-wins). A row carrying more concrete fields beats a bare mention;
 * confidence ∈ [0,1] is only the sub-unit tiebreak. Category-aware: SC scores status/rating/DC,
 * meds score status/dates/dose — so among 8 overlap copies the most complete one wins.
 */
function completenessScore(it: RawExtractedItem): number {
  if (it.category === 'active_medication') {
    const f = (it.medStatus && it.medStatus !== 'unknown' ? 1 : 0) + (it.startDate ? 1 : 0) + (it.lastSeenDate ? 1 : 0) + (it.dose ? 1 : 0);
    return f * 10 + it.confidence;
  }
  const fields = (it.status ? 1 : 0) + (it.ratingPct != null ? 1 : 0) + (it.dcCode ? 1 : 0);
  return fields * 10 + it.confidence;
}

export function groundAndDispose(
  documents: BundleDocument[],
  raw: RawExtractedItem[],
  opts: { preferMoreComplete?: boolean } = {},
): Pick<ExtractionResult, 'items' | 'droppedUngrounded' | 'droppedLowConfidence' | 'droppedDuplicate'> {
  let droppedUngrounded = 0;
  let droppedLowConfidence = 0;
  let droppedDuplicate = 0;
  const indexByKey = new Map<string, number>();
  const items: FinalExtractedItem[] = [];

  for (const it0 of raw) {
    if (!groundExtractedItem(documents, it0)) { droppedUngrounded++; continue; }
    const it = scrubInconsistentStatus(scrubUnquotedDates(it0)); // null med dates + an SC status the grounded quote doesn't support
    const disp = dispositionForConfidence(it.confidence);
    if (disp === 'drop') { droppedLowConfidence++; continue; }
    const key = chartDedupKey(it);
    const existingIdx = indexByKey.get(key);
    if (existingIdx !== undefined) {
      droppedDuplicate++;
      // Default (windowed): first-wins, exactly as before. Full-read: keep the more-complete copy
      // so a boundary SC grant doesn't end up with an arbitrary ratingPct/status from the overlap.
      if (opts.preferMoreComplete && completenessScore(it) > completenessScore(items[existingIdx]!)) {
        items[existingIdx] = { ...it, disposition: disp, needsReview: disp === 'needs_review' };
      }
      continue;
    }
    indexByKey.set(key, items.length);
    items.push({ ...it, disposition: disp, needsReview: disp === 'needs_review' });
  }

  // Cross-category collapse (QA 2026-06-13): chartDedupKey is category-scoped, so a condition that is
  // SERVICE-CONNECTED on a rating decision AND charted as a bare dx in a progress note survives as BOTH
  // `sc_condition::X` and `active_problem::X` (different keys) — on a full read of a large chart that's
  // near-certain, and it reads as two findings, undercutting the SC determination's authority. Chunks are
  // read independently so neither tag is wrong locally; this can only be resolved AFTER accumulation.
  // The SC row is authoritative + more complete (carries status/rating/DC), so DROP the duplicate
  // active_problem (its dx is preserved by the surviving SC row).
  const scNames = new Set(
    items.filter((i) => i.category === 'sc_condition').map((i) => normalizeName(i.name)),
  );
  const collapsed = items.filter((i) => {
    if (i.category === 'active_problem' && scNames.has(normalizeName(i.name))) {
      droppedDuplicate++;
      return false;
    }
    return true;
  });
  return { items: collapsed, droppedUngrounded, droppedLowConfidence, droppedDuplicate };
}

export interface ChartExtractor {
  // opts.deadlineMs = the Lambda runtime's ABSOLUTE kill time (Date.now()+getRemainingTimeInMillis()),
  // passed by the SQS handler so extraction stops early + degrades to complete_with_gaps instead of being
  // killed mid-run. Optional: omitted (tests, non-Lambda callers) → the fixed self-budget alone applies.
  extract(documents: BundleDocument[], opts?: { deadlineMs?: number }): Promise<ExtractionResult>;
}

/** Per-LLM-call result, shared by both paths' accumulation. */
interface CallResult { raw: RawExtractedItem[]; screenings: ScreeningResult[]; costUsd: number; truncated: number; }

function toolUseInput(resp: Anthropic.Message): unknown | null {
  const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  return block ? block.input : null;
}

/**
 * Extract ONE full-read chunk with the combined-category tool. On max_tokens truncation, split the
 * chunk in half at a page boundary and recurse (bounded by MAX_SPLIT_DEPTH); a single-page chunk
 * that can't split accepts the partial and counts a truncation (logged loud upstream).
 */
async function extractOneChunk(
  anthropic: Anthropic,
  unit: { documentId: string; filename: string; text: string },
  model: string,
  depth: number,
  deadlineMs?: number,
): Promise<CallResult> {
  // STREAMING (keystone fix 2026-06-23): retained on the .stream(...).finalMessage() surface even now
  // that every call runs at the base 8192 budget (no more 32k escalation) — the SDK accumulates
  // input_json_delta internally and returns the SAME stop_reason / usage / tool_use.input shape, so the
  // branch below is unchanged, and streaming keeps us clear of the SDK's "Streaming is required for
  // operations that may take longer than 10 minutes" refusal on any slow-but-legit call.
  //
  // TWO independent timers, because the SDK's per-request `timeout` only bounds time-to-RESPONSE-HEADERS
  // and is applied per-attempt (retried up to maxRetries×) — it does NOT bound the streaming BODY (SDK
  // 0.100.1, verified: the sole timer is cleared the instant headers arrive). So a mid-stream STALL — the
  // real Reckart failure — would block on `.finalMessage()` until the 900s Lambda kill. The wall-clock
  // bound is therefore a deadline-derived AbortSignal (covers the body, NOT re-entered into the retry
  // loop), added ONLY when a Lambda deadline is supplied. `timeout` stays for fast dead-on-connect
  // detection + its retry. When the signal fires we degrade THIS chunk to a FLOOR (below) so the run posts
  // complete_with_gaps — never a crash. Transient 500/529/429 still retry (SDK maxRetries); 400s fail fast.
  const callSignal = deadlineMs !== undefined ? AbortSignal.timeout(perCallTimeoutMs(deadlineMs)) : undefined;
  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.stream({
      model,
      max_tokens: CHUNK_MAX_TOKENS,
      system: combinedSystemPrompt(),
      tools: [EXTRACT_TOOL_COMBINED],
      tool_choice: { type: 'tool', name: 'record_chart_items' },
      messages: [{ role: 'user', content: chunkUserPrompt(unit) }],
    }, { timeout: perCallTimeoutMs(deadlineMs), signal: callSignal }).finalMessage();
  } catch (err) {
    // A DEADLINE abort (our wall-clock AbortSignal fired mid-stream) must NOT crash the run — degrade this
    // chunk to a flagged FLOOR so extractFullRead still posts complete_with_gaps (RN-visible). ANY OTHER
    // error (transient 5xx after retries, a 400, a connect-phase timeout) re-throws to preserve the
    // existing retry / fail-loud semantics. callSignal.aborted is the reliable discriminator; the name
    // check is a belt for however the SDK surfaces the abort.
    const abortedByDeadline = callSignal?.aborted === true || (err instanceof Error && err.name === 'APIUserAbortError');
    if (!abortedByDeadline) throw err;
    console.warn(JSON.stringify({
      event: 'chart_extract_chunk_truncated_FLOOR', document: unit.filename, depth,
      reason: 'lambda_deadline_abort',
      note: 'call aborted at the Lambda wall — chunk degraded to a flagged partial so the run posts complete_with_gaps',
    }));
    return { raw: [], screenings: [], costUsd: 0, truncated: 1 };
  }
  const costUsd = resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;

  if (resp.stop_reason === 'max_tokens') {
    // DEADLINE GUARD: within DEADLINE_RECURSION_MARGIN_MS of the Lambda wall, do NOT start a fresh split
    // re-read — each is a new multi-minute call that could straddle the kill. Accept the partial NOW so
    // the run degrades to complete_with_gaps (RN-visible) instead of being killed mid-generation → DLQ.
    const deadlineNear = deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_RECURSION_MARGIN_MS;
    // Multi-page chunk → split at a page boundary and recurse (each half re-reads at the base budget).
    const halves = depth < MAX_SPLIT_DEPTH && !deadlineNear ? splitChunkText(unit.text) : null;
    if (halves) {
      // Split-retry IN ORDER (first half then second) so accumulated raw stays deterministic.
      const a = await extractOneChunk(anthropic, { ...unit, text: halves[0] }, model, depth + 1, deadlineMs);
      const b = await extractOneChunk(anthropic, { ...unit, text: halves[1] }, model, depth + 1, deadlineMs);
      return { raw: [...a.raw, ...b.raw], screenings: [...a.screenings, ...b.screenings], costUsd: costUsd + a.costUsd + b.costUsd, truncated: a.truncated + b.truncated };
    }
    // Single dense page (no page-marker boundary to split on) whose EXTRACTION OUTPUT overflowed the
    // budget — the buried-grant case (a rating decision itemizing dozens of SC grants on one page must
    // not lose any). The OLD path re-ran the whole page at the 32k ceiling: a single 5-9 min generation
    // that fired late in the run and blew the 15-min Lambda wall, DLQ'ing the entire chart (Reckart
    // CLM-84B137F353, 2026-07-12 — three 900 s timeouts → "Chart analysis failed", zero items). Instead,
    // split the page's TEXT at an internal line boundary and re-read each half at the BASE budget: two
    // FAST calls that can't blow the wall, and — because halving the input halves the output — each half
    // fits, so no grant is lost. Bounded by MAX_SPLIT_DEPTH (2 → up to 4 pieces = 4×8192 output capacity,
    // exceeding the old 32k ceiling). The deterministic grant parser (extractRatingDecisionGrants) is the
    // independent no-loss guarantee for SC grants even if this or a deadline FLOOR drops one.
    if (depth < MAX_SPLIT_DEPTH && !deadlineNear) {
      const charHalves = splitPageByChar(unit.text);
      if (charHalves) {
        console.warn(JSON.stringify({ event: 'chart_extract_dense_page_char_split', document: unit.filename, depth }));
        const a = await extractOneChunk(anthropic, { ...unit, text: charHalves[0] }, model, depth + 1, deadlineMs);
        const b = await extractOneChunk(anthropic, { ...unit, text: charHalves[1] }, model, depth + 1, deadlineMs);
        return { raw: [...a.raw, ...b.raw], screenings: [...a.screenings, ...b.screenings], costUsd: costUsd + a.costUsd + b.costUsd, truncated: a.truncated + b.truncated };
      }
    }
    // FLOOR: unsplittable (single over-long line / depth exhausted) OR stopped by the deadline guard.
    // Accept the base-budget items and flag truncated. A loud PARTIAL (the coverage card shows the gap)
    // beats a total run failure that renders "Chart analysis failed" with ZERO items. NEVER re-read at
    // 32k here — that is the Lambda-timeout crash this fix removes.
    console.warn(JSON.stringify({
      event: 'chart_extract_chunk_truncated_FLOOR', document: unit.filename, depth, maxTokens: CHUNK_MAX_TOKENS,
      reason: deadlineNear ? 'lambda_deadline_near' : 'unsplittable_dense_page',
      note: deadlineNear
        ? 'stopped splitting near the Lambda deadline — partial captured, run degrades to complete_with_gaps'
        : 'dense page could not be split — items after the output cutoff were captured partial (INVESTIGATE)',
    }));
    const input = toolUseInput(resp);
    return {
      raw: input ? coerceRawItemsCombined(input, unit.documentId) : [],
      screenings: input ? coerceScreenings(input, unit.documentId) : [],
      costUsd, truncated: 1,
    };
  }

  const input = toolUseInput(resp);
  return {
    raw: input ? coerceRawItemsCombined(input, unit.documentId) : [],
    screenings: input ? coerceScreenings(input, unit.documentId) : [],
    costUsd, truncated: 0,
  };
}

/** Build the live extractor. Windowed path is per-window; full-read path is per-chunk + combined. */
export function makeChartExtractor(apiKey: string): ChartExtractor {
  // maxRetries bumped 2→4 (2026-06-23): the SDK auto-retries transient 500/529 (overloaded) and 429
  // with exponential backoff and does NOT retry 400s — exactly the transient-retry requirement. A few
  // extra attempts ride out the bursty Anthropic overload spikes so one wobble doesn't fail a whole
  // re-extraction. Applies to BOTH paths (single shared client). 400 BadRequestError still fails fast.
  const anthropic = new Anthropic({ apiKey, maxRetries: 4 });

  async function extractWindowed(documents: BundleDocument[]): Promise<ExtractionResult> {
    const windows = locateExtractionInputs(documents);
    const raw: RawExtractedItem[] = [];
    let costUsd = 0;
    let truncatedWindows = 0;
    for (const w of windows) {
      // Streaming for consistency with the full-read path (2026-06-23). MAX_TOKENS (2000) is below the
      // 10-min non-streaming ceiling so this path didn't crash, but streaming future-proofs it if
      // MAX_TOKENS is ever raised and keeps both paths on one mechanism. Same Anthropic.Message shape.
      const resp = await anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(w.category),
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_chart_items' },
        messages: [{ role: 'user', content: windowUserPrompt(w) }],
      }).finalMessage();
      costUsd += resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;
      if (resp.stop_reason === 'max_tokens') {
        truncatedWindows++;
        console.warn(JSON.stringify({
          event: 'chart_extract_window_truncated', category: w.category, document: w.filename,
          outputTokens: resp.usage.output_tokens, maxTokens: MAX_TOKENS,
          note: 'tool-array hit max_tokens — items after the cutoff were lost for this window',
        }));
      }
      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUse) raw.push(...coerceRawItems(toolUse.input, w));
    }
    const { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate } = groundAndDispose(documents, raw);
    return { items, windowsProcessed: windows.length, rawCount: raw.length, droppedUngrounded, droppedLowConfidence, droppedDuplicate, truncatedWindows, costUsd, model: MODEL, fullRead: false };
  }

  return {
    async extract(documents: BundleDocument[], opts?: { deadlineMs?: number }): Promise<ExtractionResult> {
      return fullReadEnabled() ? extractFullRead(anthropic, documents, FULLREAD_MODEL, opts ?? {}) : extractWindowed(documents);
    },
  };
}

/**
 * Full-read extraction over a document bundle, with an EXPLICIT model. Module-level + exported so the
 * A/B smoke harness can run the same code path across Sonnet/Opus/Haiku in one process. Bounded
 * concurrency; results placed back by chunk index so raw stays in chunkIndex order (deterministic
 * dedup survivor — architect trap #1 — without touching the windowed path).
 */
export async function extractFullRead(
  anthropic: Anthropic,
  documents: BundleDocument[],
  model: string = FULLREAD_MODEL,
  opts: { deadlineMs?: number } = {},
): Promise<ExtractionResult> {
  const deadlineMs = opts.deadlineMs;
  // COST-SAFETY (Ryan 2026-06-17): drop byte-identical-content duplicate documents BEFORE chunking so
  // the same content is never sent to the model twice (Woodley Misc_2==Misc_3). Compute everything
  // downstream over the KEPT set so coverage + grounding match what was actually fed. Logged, never silent.
  const { kept, dropped } = dedupeIdenticalDocuments(documents);
  if (dropped.length > 0) {
    console.warn(JSON.stringify({ event: 'chart_extract_deduped_identical_documents', droppedCount: dropped.length, dropped }));
  }
  const chunks = chunkDocuments(kept);
  const gaps = uncoveredPages(kept, chunks);
  const results: CallResult[] = new Array(chunks.length);
  const startedAt = Date.now();
  const budgetMs = selfBudgetMs();
  let chunksRun = 0;
  let budgetExceeded = false;
  // ROLLING CONCURRENCY POOL (Reckart CLM-84B137F353 head-of-line fix, 2026-07-12). REPLACES the
  // per-batch `Promise.all` barrier. The barrier made every chunk in a batch wait for that batch's
  // SLOWEST chunk before ANY chunk of the next batch could start: on a repetitive Blue Button chart a
  // few chunks emit 75-107 items and take 200-300s while their 7 batch-mates finish in 1-27s and sit
  // IDLE at the barrier (measured batch 1 = 213s, 7/8 done < 27s → ~185s wasted). Only 24/39 chunks ran
  // before the 15-min wall → complete_with_gaps. The pool keeps up to CHUNK_CONCURRENCY chunks in flight
  // and launches the NEXT chunk the instant ANY in-flight one settles — no head-of-line stall.
  //
  // OUTPUT-NEUTRAL vs the barrier — invariants that MUST NOT break:
  //  1. DETERMINISM: each result is written to results[c.chunkIndex] (chunk-index order, NOT completion
  //     order; chunkDocuments guarantees chunkIndex === array position). Downstream raw accumulation +
  //     dedup-survivor tie-break (groundAndDispose keeps the FIRST on a completeness tie) stay identical.
  //  2. CAP: never more than CHUNK_CONCURRENCY calls in flight (Anthropic rate + reserved concurrency=8).
  //  3. GATE: stops LAUNCHING new chunks on the SAME two bounds (self-budget OR the Lambda deadline).
  //     In-flight chunks are NOT cancelled — they settle in the drain — so chunksRun counts launched
  //     ( == completed) and the un-launched suffix folds into unrunPages → complete_with_gaps, never a
  //     mid-run kill. Chunks LAUNCH strictly in index order, so the launched set is always the prefix
  //     chunks[0..chunksRun).
  //  4. FIRST-WAVE EXEMPTION: the first CHUNK_CONCURRENCY launches bypass the gate — the exact translation
  //     of the old `start > 0` that exempted the first BATCH — so a single degraded cold start still reads
  //     ≥ one wave.
  //  5. FAIL-LOUD: a genuine extractOneChunk rejection (transient 5xx after retries, a 400) is captured
  //     and re-thrown after the drain, preserving the old "one bad chunk fails the run" semantics. (A
  //     Lambda-deadline abort is NOT a rejection — extractOneChunk catches it and returns a FLOOR.)
  const inFlight = new Set<Promise<void>>();
  let firstError: unknown = null;
  let nextIndex = 0;
  while (nextIndex < chunks.length && firstError === null) {
    const selfBudgetHit = Date.now() - startedAt >= budgetMs;
    const deadlineHit = deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BATCH_MARGIN_MS;
    if (nextIndex >= CHUNK_CONCURRENCY && (selfBudgetHit || deadlineHit)) {
      budgetExceeded = true;
      console.warn(JSON.stringify({ event: 'chart_extract_self_budget_exceeded', reason: deadlineHit ? 'lambda_deadline' : 'self_budget', model, chunksRun, chunksTotal: chunks.length, elapsedMs: Date.now() - startedAt, budgetMs }));
      break;
    }
    const c = chunks[nextIndex++]!;
    chunksRun++;
    // PER-CHUNK TIMING (Reckart diagnostic) — LOG-ONLY: the .then writes the SAME CallResult to
    // results[c.chunkIndex]. .catch captures the FIRST genuine rejection so NO promise ever rejects
    // unobserved (fail-loud is re-raised after the drain); .finally self-removes so the next chunk can run.
    const t0 = Date.now();
    const p: Promise<void> = extractOneChunk(anthropic, c, model, 0, deadlineMs)
      .then((r) => {
        console.warn(JSON.stringify({ event: 'chart_extract_chunk_timing', chunkIndex: c.chunkIndex, pages: c.pageNumbers.length, chars: c.text.length, durationMs: Date.now() - t0, truncated: r.truncated, items: r.raw.length }));
        results[c.chunkIndex] = r;
      })
      .catch((err) => { if (firstError === null) firstError = err; })
      .finally(() => { inFlight.delete(p); });
    inFlight.add(p);
    // Refill: when the pool is full, wait for the FIRST in-flight chunk to settle before launching the
    // next (vs the barrier that waited for ALL 8). The settled promise already self-removed via .finally.
    if (inFlight.size >= CHUNK_CONCURRENCY) await Promise.race(inFlight);
  }
  // Drain every launched-but-unsettled chunk. Each extractOneChunk always settles (a CallResult, or a
  // FLOOR on deadline-abort; a genuine error was captured above), so this never hangs. After the drain,
  // results[0..chunksRun) are all populated and results[chunksRun..] stay undefined (the un-launched
  // suffix → unrunPages below). A captured genuine error re-throws to preserve fail-loud.
  await Promise.all(inFlight);
  if (firstError !== null) throw firstError;
  // On a budget cutoff, results[chunksRun..] are undefined holes — only fold the chunks we actually
  // ran. The un-run chunks' pages join the structural gaps so the run records complete_with_gaps
  // (never a silent clean 'complete') and the RN sees exactly how much of the chart went unread.
  const ranResults = budgetExceeded ? results.filter(Boolean) : results;
  const unrunPages = new Set<string>();
  for (let i = chunksRun; i < chunks.length; i++) {
    for (const p of chunks[i]!.pageNumbers) unrunPages.add(`${chunks[i]!.documentId}#${p}`);
  }
  // DETERMINISTIC GRANT AUTHORITY (Ryan 2026-06-20, 3rd recurrence of dropped grants): the broad
  // LLM pass cannot be trusted with the load-bearing granted-SC anchor — it drops grants from
  // rating decisions (Woodley, Hackworth) even with prompt hardening. Deterministically parse every
  // grant recital from the rigid rating-decision form and MERGE into raw BEFORE grounding/dedup, so
  // grants the LLM missed are recovered (incl. the partial-loss case the granted_sc_empty gate can't
  // catch). groundAndDispose grounds them (sourceQuote is a verbatim page substring) and dedups vs
  // the LLM rows (no double-count). NEVER fabricates (only "is granted" recitals match).
  const deterministicGrants = extractRatingDecisionGrants(kept);
  if (deterministicGrants.length > 0) {
    console.warn(JSON.stringify({ event: 'chart_extract_deterministic_grants', count: deterministicGrants.length, conditions: deterministicGrants.map((g) => g.name).slice(0, 12) }));
  }
  const raw = [...ranResults.flatMap((r) => r.raw), ...deterministicGrants];
  const rawScreenings = ranResults.flatMap((r) => r.screenings);
  const costUsd = ranResults.reduce((s, r) => s + r.costUsd, 0);
  const truncatedWindows = ranResults.reduce((s, r) => s + r.truncated, 0);
  const uncoveredCount = gaps.length + unrunPages.size;
  if (uncoveredCount > 0) {
    console.warn(JSON.stringify({ event: 'chart_extract_coverage_gap', uncoveredPages: uncoveredCount, structuralGaps: gaps.length, unrunPages: unrunPages.size, sample: gaps.slice(0, 5) }));
  }
  const { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate } = groundAndDispose(kept, raw, { preferMoreComplete: true });
  const screenings = groundScreenings(kept, rawScreenings);
  return {
    items, windowsProcessed: 0, rawCount: raw.length, droppedUngrounded, droppedLowConfidence, droppedDuplicate,
    truncatedWindows, costUsd, model, fullRead: true, chunksProcessed: chunksRun, uncoveredPages: uncoveredCount, screenings,
  };
}
