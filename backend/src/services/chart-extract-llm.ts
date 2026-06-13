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
import {
  locateExtractionInputs,
  chunkDocuments,
  uncoveredPages,
  splitChunkText,
  groundExtractedItem,
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
// Escalated ceiling for an UNSPLITTABLE truncation: a single dense rating-decision page can itemize
// dozens of SC grants and overflow 8192 output tokens, and splitChunkText can't split one page
// without orphaning its [p.N] marker. Re-running that page at a high ceiling is the page-level
// fallback that stops the rebuild from RELOCATING the buried-grant loss (architect BLOCKER). Sonnet
// 4.x supports well above this; if a page somehow still overflows 32k items, we log loud + accept.
const CHUNK_MAX_TOKENS_CEILING = 32_000;
// Bounded concurrency: the architect's binding ceiling. The 10-min Lambda must not fire 30+ calls
// at once (rate limits) nor serialize them (timeout). 4 keeps us inside both.
const CHUNK_CONCURRENCY = 4;
// Split-retry depth: a truncated chunk is halved and re-run; bounded so a pathological page can't
// recurse forever (it falls through to "accept + log loud" at the floor).
const MAX_SPLIT_DEPTH = 2;

/** Raw item as returned by the model for a single window, before grounding. */
export interface RawExtractedItem {
  category: ExtractCategory;
  name: string;
  status?: 'service_connected' | 'pending' | 'denied';
  dcCode?: string;
  ratingPct?: number;
  icd10?: string;
  notes?: string;
  dose?: string;
  frequency?: string;
  indication?: string;
  sourceDocumentId: string;
  sourcePage: number;
  sourceQuote: string;
  confidence: number;
}

export interface FinalExtractedItem extends RawExtractedItem {
  disposition: Exclude<ConfidenceDisposition, 'drop'>;
  needsReview: boolean;
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
            dcCode: { type: 'string', description: 'SC conditions only: diagnostic code if explicitly stated.' },
            icd10: { type: 'string', description: 'Problems only: ICD-10 code if explicitly present.' },
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
      status: typeof r.status === 'string' ? (r.status as RawExtractedItem['status']) : undefined,
      dcCode: typeof r.dcCode === 'string' ? r.dcCode : undefined,
      ratingPct: typeof r.ratingPct === 'number' ? r.ratingPct : undefined,
      icd10: typeof r.icd10 === 'string' ? r.icd10 : undefined,
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
    'three categories. Only emit an item if it literally appears in the text. Never infer, never add ' +
    'conditions the veteran might have. Each item carries its category, exact page, and a verbatim quote.',
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
              enum: ['sc_condition', 'active_problem', 'active_medication'],
              description: 'sc_condition = a VA service-connected/rated disability (granted/pending/denied); active_problem = a Problem List entry; active_medication = an Active Medications entry.',
            },
            name: { type: 'string', description: 'The condition / problem / medication name, as written.' },
            status: { type: 'string', enum: ['service_connected', 'pending', 'denied'], description: 'sc_condition only: service_connected if granted, denied if THIS condition is denied, pending if awaiting decision.' },
            ratingPct: { type: 'integer', description: 'sc_condition only: rating percentage if explicitly stated.' },
            dcCode: { type: 'string', description: 'sc_condition only: diagnostic code if explicitly stated.' },
            icd10: { type: 'string', description: 'active_problem only: ICD-10 code if explicitly present.' },
            dose: { type: 'string', description: 'active_medication only: dose/strength as written (e.g. "10 mg").' },
            frequency: { type: 'string', description: 'active_medication only: frequency/sig as written.' },
            indication: { type: 'string', description: 'active_medication only: what the medication is for, if explicitly stated.' },
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

function combinedSystemPrompt(): string {
  return [
    'You parse a chunk of a veteran\'s VA medical record into structured rows across THREE categories:',
    '  - sc_condition: VA service-connected / rated disabilities (granted, pending, or denied). Set status (+ ratingPct/dcCode if stated).',
    '  - active_problem: entries from a Problem List / Computerized Problem List.',
    '  - active_medication: entries from an Active (Outpatient) Medications list (+ dose/frequency if written).',
    'The VA document is the source of truth. Extract ONLY what is literally present in the text.',
    'NEVER infer, NEVER add items the veteran "might" have, NEVER fabricate codes or percentages.',
    'Set `category` correctly on every item. Every item needs the exact [p.N] page it appears on and a short verbatim sourceQuote copied from that page.',
    '',
    // RECALL ANCHOR (Ryan 2026-06-13): VA rating decisions are TEMPLATED — the same phrases mark a
    // service connection every time. A single buried grant is the failure this rebuild exists to
    // kill (Woodley F43.8 70% SC, missed). Naming the templated language directs the model to it.
    'VA RATING-DECISION LANGUAGE — these templated phrases almost always mark an sc_condition; never skip a page containing them:',
    '  GRANTED:  "Service connection for X is granted" · "Service connection for X has been established" · "An evaluation of N percent is assigned for X" · "A N percent evaluation is assigned" · "X is N percent disabling" · "N% — X (diagnostic code NNNN)".',
    '  DENIED:   "Service connection for X is denied" · "Service connection for X is not warranted / is not established".',
    '  DEFERRED/PENDING: "Service connection for X is deferred" · "X is deferred pending ...".',
    '  Capture EACH itemized condition separately with its own status + ratingPct + dcCode when the decision lists them — even if many appear on one page.',
    'If a benefit-summary letter states only a COMBINED percentage (e.g. "your combined evaluation is 70 percent") WITHOUT itemizing the individual conditions, do NOT invent the individual conditions — emit nothing for those rather than guess.',
    '',
    // BLUE BUTTON STRUCTURE (Ryan 2026-06-13): VA Blue Button / CAPRI reports are templated — the
    // problem and medication lists sit under stable headers. Naming them lifts recall on the
    // routine sections the same way the rating-decision phrases do for SC grants.
    'BLUE BUTTON SECTION HEADERS — extract every row beneath these when present:',
    '  active_problem: "Problem List" / "VA Problem List" / "Computerized Problem List" — one row per listed problem (with its ICD-10 if shown).',
    '  active_medication: "Active Medications" / "Active Outpatient Medications" / "Medications" — one row per drug (with dose/frequency/sig as written).',
    // PRECISION GUARD (Ryan standing rule: a screen is NOT a diagnosis): keep screening instruments
    // out of the problem/condition rows so a positive score never becomes a fabricated dx.
    'SCREENS ARE NOT DIAGNOSES: PHQ-9, GAD-7, PC-PTSD-5, AUDIT-C and similar screening scores are NOT conditions. NEVER emit a screen result (e.g. "PHQ-9 = 15") as an active_problem or sc_condition. Only extract an actual charted diagnosis or a VA service-connection determination.',
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
      status: typeof r.status === 'string' ? (r.status as RawExtractedItem['status']) : undefined,
      dcCode: typeof r.dcCode === 'string' ? r.dcCode : undefined,
      ratingPct: typeof r.ratingPct === 'number' ? r.ratingPct : undefined,
      icd10: typeof r.icd10 === 'string' ? r.icd10 : undefined,
      dose: typeof r.dose === 'string' ? r.dose : undefined,
      frequency: typeof r.frequency === 'string' ? r.frequency : undefined,
      indication: typeof r.indication === 'string' ? r.indication : undefined,
      sourceDocumentId: documentId, // injected — unambiguous, the model never sees it
      sourcePage: Math.trunc(r.sourcePage),
      sourceQuote: r.sourceQuote,
      confidence: Math.max(0, Math.min(1, r.confidence)),
    });
  }
  return out;
}

/**
 * Pure: ground every raw item (verbatim quote on the cited page), drop low-confidence, dedup on
 * (category, normalizedName). Returns the final writable set + drop counts for the audit row.
 */
/**
 * Completeness score for picking the survivor among duplicate rows: a row carrying SC status +
 * rating + DC code beats a bare mention; confidence is the sub-unit tiebreak. Used only when
 * preferMoreComplete is set (the full-read path), where the 1-page overlap means a boundary SC
 * grant legitimately arrives twice and the copies can disagree on ratingPct/status (architect
 * SHOULD-FIX). The windowed path keeps its original first-wins behavior.
 */
function completenessScore(it: RawExtractedItem): number {
  const fields = (it.status ? 1 : 0) + (it.ratingPct != null ? 1 : 0) + (it.dcCode ? 1 : 0);
  return fields * 10 + it.confidence; // confidence ∈ [0,1] never outranks an extra concrete field
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

  for (const it of raw) {
    if (!groundExtractedItem(documents, it)) { droppedUngrounded++; continue; }
    const disp = dispositionForConfidence(it.confidence);
    if (disp === 'drop') { droppedLowConfidence++; continue; }
    const key = `${it.category}::${normalizeName(it.name)}`;
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
  return { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate };
}

export interface ChartExtractor {
  extract(documents: BundleDocument[]): Promise<ExtractionResult>;
}

/** Per-LLM-call result, shared by both paths' accumulation. */
interface CallResult { raw: RawExtractedItem[]; costUsd: number; truncated: number; }

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
  maxTokens: number = CHUNK_MAX_TOKENS,
): Promise<CallResult> {
  const resp = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: combinedSystemPrompt(),
    tools: [EXTRACT_TOOL_COMBINED],
    tool_choice: { type: 'tool', name: 'record_chart_items' },
    messages: [{ role: 'user', content: chunkUserPrompt(unit) }],
  });
  const costUsd = resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;

  if (resp.stop_reason === 'max_tokens') {
    // Multi-page chunk → split at a page boundary and recurse (each half re-reads at the base budget).
    const halves = depth < MAX_SPLIT_DEPTH ? splitChunkText(unit.text) : null;
    if (halves) {
      // Split-retry IN ORDER (first half then second) so accumulated raw stays deterministic.
      const a = await extractOneChunk(anthropic, { ...unit, text: halves[0] }, model, depth + 1);
      const b = await extractOneChunk(anthropic, { ...unit, text: halves[1] }, model, depth + 1);
      return { raw: [...a.raw, ...b.raw], costUsd: costUsd + a.costUsd + b.costUsd, truncated: a.truncated + b.truncated };
    }
    // Single dense page (unsplittable) → re-run the SAME page at the escalated ceiling before giving
    // up. This is the page-level fallback for the buried-grant case (architect BLOCKER): a rating
    // decision listing dozens of SC grants on one page must not lose any past the 8192 cutoff.
    if (maxTokens < CHUNK_MAX_TOKENS_CEILING) {
      console.warn(JSON.stringify({
        event: 'chart_extract_chunk_truncated_escalating', document: unit.filename,
        fromMaxTokens: maxTokens, toMaxTokens: CHUNK_MAX_TOKENS_CEILING,
        note: 'single dense page hit the output ceiling — re-running at the high ceiling so no item is lost',
      }));
      return extractOneChunk(anthropic, unit, model, depth, CHUNK_MAX_TOKENS_CEILING);
    }
    console.warn(JSON.stringify({
      event: 'chart_extract_chunk_truncated_FLOOR', document: unit.filename, depth, maxTokens,
      note: 'chunk hit max_tokens even at the ceiling and could not be split — items after the cutoff were lost (INVESTIGATE)',
    }));
    const input = toolUseInput(resp);
    return { raw: input ? coerceRawItemsCombined(input, unit.documentId) : [], costUsd, truncated: 1 };
  }

  const input = toolUseInput(resp);
  return { raw: input ? coerceRawItemsCombined(input, unit.documentId) : [], costUsd, truncated: 0 };
}

/** Build the live extractor. Windowed path is per-window; full-read path is per-chunk + combined. */
export function makeChartExtractor(apiKey: string): ChartExtractor {
  const anthropic = new Anthropic({ apiKey });

  async function extractWindowed(documents: BundleDocument[]): Promise<ExtractionResult> {
    const windows = locateExtractionInputs(documents);
    const raw: RawExtractedItem[] = [];
    let costUsd = 0;
    let truncatedWindows = 0;
    for (const w of windows) {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(w.category),
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_chart_items' },
        messages: [{ role: 'user', content: windowUserPrompt(w) }],
      });
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

  async function extractFullRead(documents: BundleDocument[]): Promise<ExtractionResult> {
    const chunks = chunkDocuments(documents);
    const gaps = uncoveredPages(documents, chunks);
    // Bounded-concurrency batches; results placed back by index so raw stays in chunkIndex order
    // (deterministic dedup survivor — architect trap #1 — without sorting the windowed path).
    const results: CallResult[] = new Array(chunks.length);
    for (let start = 0; start < chunks.length; start += CHUNK_CONCURRENCY) {
      const batch = chunks.slice(start, start + CHUNK_CONCURRENCY);
      const settled = await Promise.all(batch.map((c) => extractOneChunk(anthropic, c, FULLREAD_MODEL, 0)));
      settled.forEach((r, k) => { results[start + k] = r; });
    }
    const raw = results.flatMap((r) => r.raw);
    const costUsd = results.reduce((s, r) => s + r.costUsd, 0);
    const truncatedWindows = results.reduce((s, r) => s + r.truncated, 0);
    if (gaps.length > 0) {
      console.warn(JSON.stringify({ event: 'chart_extract_coverage_gap', uncoveredPages: gaps.length, sample: gaps.slice(0, 5) }));
    }
    const { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate } = groundAndDispose(documents, raw, { preferMoreComplete: true });
    return {
      items, windowsProcessed: 0, rawCount: raw.length, droppedUngrounded, droppedLowConfidence, droppedDuplicate,
      truncatedWindows, costUsd, model: FULLREAD_MODEL, fullRead: true, chunksProcessed: chunks.length, uncoveredPages: gaps.length,
    };
  }

  return {
    async extract(documents: BundleDocument[]): Promise<ExtractionResult> {
      return fullReadEnabled() ? extractFullRead(documents) : extractWindowed(documents);
    },
  };
}
