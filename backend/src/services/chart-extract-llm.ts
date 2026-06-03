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
  costUsd: number;
  model: string;
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

/**
 * Pure: ground every raw item (verbatim quote on the cited page), drop low-confidence, dedup on
 * (category, normalizedName). Returns the final writable set + drop counts for the audit row.
 */
export function groundAndDispose(
  documents: BundleDocument[],
  raw: RawExtractedItem[],
): Pick<ExtractionResult, 'items' | 'droppedUngrounded' | 'droppedLowConfidence' | 'droppedDuplicate'> {
  let droppedUngrounded = 0;
  let droppedLowConfidence = 0;
  let droppedDuplicate = 0;
  const seen = new Set<string>();
  const items: FinalExtractedItem[] = [];

  for (const it of raw) {
    if (!groundExtractedItem(documents, it)) { droppedUngrounded++; continue; }
    const disp = dispositionForConfidence(it.confidence);
    if (disp === 'drop') { droppedLowConfidence++; continue; }
    const key = `${it.category}::${normalizeName(it.name)}`;
    if (seen.has(key)) { droppedDuplicate++; continue; }
    seen.add(key);
    items.push({ ...it, disposition: disp, needsReview: disp === 'needs_review' });
  }
  return { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate };
}

export interface ChartExtractor {
  extract(documents: BundleDocument[]): Promise<ExtractionResult>;
}

/** Build the live extractor. The model call is per-window; grounding/dedup is pure code. */
export function makeChartExtractor(apiKey: string): ChartExtractor {
  const anthropic = new Anthropic({ apiKey });
  return {
    async extract(documents: BundleDocument[]): Promise<ExtractionResult> {
      const windows = locateExtractionInputs(documents);
      const raw: RawExtractedItem[] = [];
      let costUsd = 0;
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
        const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (toolUse) raw.push(...coerceRawItems(toolUse.input, w));
      }
      const { items, droppedUngrounded, droppedLowConfidence, droppedDuplicate } = groundAndDispose(documents, raw);
      return {
        items,
        windowsProcessed: windows.length,
        rawCount: raw.length,
        droppedUngrounded,
        droppedLowConfidence,
        droppedDuplicate,
        costUsd,
        model: MODEL,
      };
    },
  };
}
