// AI page picker for the Doctor Pack (Ryan 2026-06-12).
//
// WHY THIS EXISTS: the regex page-selector (page-selector.ts) was patched four times
// (1.0 -> 1.3.0) and still leaked VA benefit boilerplate into the physician pack — monthly
// entitlement tables, commissary/travel-pay enclosures — because regex over noisy OCR text is
// brittle (it kills "beneficiary travel" but the VA page says "beneficial travel"; it needs >=2
// distinct hits so a single-pattern enclosure page slips through). This is the durable fix: let
// Opus READ each page and decide keep/drop. Robust against OCR noise + phrasing variants.
//
// MODEL: Claude Opus 4.6 on Bedrock (the advisory model — live-tested working; 4.8 is still
// entitlement-blocked on this account). Swap to 4.8 by changing ADVISORY_MODEL_ID when access
// clears. COST: scoped to the doc types where boilerplate hides + truncated page text +
// compact JSON output -> a typical pack runs well under $1 (logged per call for the cost panel).
//
// FAIL-SAFE: any failure (Bedrock error, unparseable JSON, empty keep-list) returns null so the
// caller falls back to the deterministic regex selector — the pack ALWAYS generates.

import {
  invokeAdvisory,
  HAIKU_MODEL_ID,
  HAIKU_PRICE_PER_M_INPUT_USD,
  HAIKU_PRICE_PER_M_OUTPUT_USD,
} from '../advisory/bedrockClient.js';
import { rangesFromIncluded } from './page-selector.js';
import type { KeyDocPageRange } from './db-types.js';

export const PAGE_LLM_VERSION = 'page-llm-1.1.0';

// The classifying signal — VA enclosure headers ("Armed Forces Commissary and Exchange", "Your
// monthly entitlement amount"), "Reasons for Decision", a diagnosis line — sits near the TOP of a
// page. 600 chars caught the page-TYPE signal but cut off the VALUE the physician needs on
// objective-test pages: a sleep study's AHI/RDI line, an audiogram's puretone/speech table, a
// PFT's FEV1/FVC, a decision's stated REASON often sit below the first 600 chars. 1200 chars keeps
// the value on the page the model is judging while staying well under full-page token cost.
// Exported for the page-llm test (regression guard on the bump).
export const PAGE_TEXT_CHARS = 1200;
// Safety cap for the SINGLE-CALL picker: docs bigger than this skip selectPagesLlm and are handled by
// the chunked bulk picker (DOCTOR_PACK_LLM_BULK) instead — a doc over this size is exactly what the
// bulk router now catches (>60pp → chunked Haiku), so it is no longer a silent regex fallback.
export const MAX_PAGES_FOR_LLM = 60;
// Output cap — we only need a short JSON keep-list, never prose.
const MAX_OUTPUT_TOKENS = 700;

// Ryan's guidance, made explicit (2026-06-12: "give it a little guidance and it should do just
// fine"). KEEP = medical/claim substance a nexus-letter physician needs. DROP = administrative /
// benefit boilerplate. The system prompt is the CACHED prefix (cache_control in bedrockClient) so
// repeated docs/cases pay almost nothing for it.
export const SYSTEM_PROMPT = `You curate a U.S. veteran's VA disability records into a TIGHT pack for a physician who will write a nexus (medical opinion) letter. For ONE document at a time, you receive its pages (text, truncated). Decide which pages to KEEP and which to DROP. Bias hard toward a SMALL pack — a few pages per document. The physician wants signal, not the whole chart.

KEEP a page when it carries the substance the physician actually needs:
- For an objective TEST document, keep the page that shows the actual VALUE the physician needs, not the cover or instructions: a SLEEP STUDY -> the page with the AHI/RDI (apnea-hypopnea / respiratory disturbance index); an AUDIOGRAM -> the puretone-threshold and speech-discrimination (Maryland CNC) table; a PULMONARY FUNCTION TEST -> the FEV1/FVC (and DLCO) results; a RATING or DECISION letter -> the page that NAMES the granted or denied condition AND its stated REASON. One page per value — the page that carries the number/finding.
- The VA's service-connection decision and its stated REASONS/evidence (what condition was granted, denied, continued, or evaluated, and WHY).
- The page that NAMES the current DIAGNOSIS of the claimed (or a directly related) condition.
- For treatment / progress / clinical notes the goal is the DIAGNOSIS. Keep the page(s) where a provider EXPLICITLY names the claimed or a closely-related condition (for an anxiety claim, e.g. "generalized anxiety disorder", "GAD", "anxiety", "adjustment disorder"). A charted symptom or a vague word like "mood" is NOT a diagnosis — never treat it as one. From the most recent note that carries such a diagnosis, keep ONLY the key Subjective page and the Assessment & Plan (A&P) page; DROP pages about UNRELATED comorbidities (e.g. hypertension, amlodipine, medication refills) even inside the same note. Aim for ~2 pages, never a whole multi-page SOAP note.
- Validated SCREENING tools (PHQ-9, GAD-7, PC-PTSD-5, AUDIT-C, etc.) ARE good supporting evidence — KEEP the screening page; it supports SEVERITY. But a positive screen is NOT a diagnosis on its own and never substitutes for the diagnosis page above.
- Test / imaging results: the impression/findings page ONLY (one page) — not raw data tables, trends, or repeated panels.
- In-service events, injuries, or exposures; concise service/personnel facts (MOS, deployments, combat).
- Prior medical opinions, DBQs, and C&P exam findings + rationale.
- Lay / buddy statements describing symptoms or events.

DROP a page when it is low-yield or administrative — be AGGRESSIVE:
- Monthly payment / entitlement amounts; commissary/exchange, beneficiary/beneficial travel, state veterans benefits; life insurance (VALife, S-DVI), home loan, vocational rehabilitation enclosures.
- Appeal rights, "What you should do if you disagree", decision-review-request / VA Form instructions, notice of disagreement; Veterans Crisis Line; satisfaction surveys (VSignals); generic "Additional Benefits"; combined-rating math tables.
- REPETITIVE or routine clinical pages that add neither the diagnosis nor the current plan: old or duplicate visit notes, vitals-only pages, medication refill lists, lab/result tables, normal or unremarkable encounters, telephone/care-coordination notes, administrative clinic pages.
- Blank, cover, transmittal, or address pages.

RULES:
- Judge by what the page SAYS, not where it sits. VA letters often open with payment/benefit boilerplate — DROP it; the decision and its reasons come later.
- When a document has many similar clinical pages, pick the 1-2 MOST informative (the diagnosis + the most recent plan) and drop the rest. Err toward FEWER pages.
- Keep a substantive page even if it also mentions a benefit in passing. NEVER keep a page that is purely boilerplate or a routine/repetitive clinical note.
- Prefer pages relevant to the claimed condition when one is given.

Return ONLY a JSON object, no prose, no markdown fences:
{"keep":[<page numbers to include, integers>],"note":"<<=8 word reason>"}`;

export interface PageLlmInputPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface PageLlmResult {
  readonly pageRanges: readonly KeyDocPageRange[];
  readonly keptPageNumbers: readonly number[];
  readonly costUsd: number;
  readonly rationale: string;
  // DOCTOR_PACK_LLM_BULK: the model's short reason/label for the kept pages, surfaced as the cover
  // descriptor so EVERY LLM-picked doc (not just bulk dumps) gets a real cover label instead of the
  // generic per-category why. Page refs are never taken from here (code-generated from pageRanges).
  readonly label?: string | null;
}

/** True when the LLM picker should run for this doc. Skips tiny docs (nothing to pick), and
 * oversized docs (cost/safety — fall back to regex). The caller still skips always-include and
 * hard-exclude docTypes before calling. */
export function shouldUseLlmPicker(pageCountWithText: number): boolean {
  return pageCountWithText >= 3 && pageCountWithText <= MAX_PAGES_FOR_LLM;
}

// Pull {"keep":[...]} out of the model text. Tolerant of stray prose / fences. Validates that
// every kept number is a real page in this doc. Returns null on any failure OR an empty keep-list
// (empty => "model says all boilerplate"; for safety we let the caller fall back to regex, whose
// high-signal fallback guarantees the decision isn't silently dropped).
function parseKeep(text: string, validPageNumbers: readonly number[]): number[] | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const keepRaw = (obj as { keep?: unknown }).keep;
  if (!Array.isArray(keepRaw)) return null;
  const valid = new Set(validPageNumbers);
  const keep = keepRaw
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && valid.has(n));
  if (keep.length === 0) return null;
  return [...new Set(keep)].sort((a, b) => a - b);
}

/** Decide which pages of ONE document to include, using Opus. Returns null on any failure so the
 * caller falls back to the deterministic regex selector. Never throws. */
export async function selectPagesLlm(input: {
  readonly docType: string;
  readonly claimedCondition?: string;
  readonly pages: readonly PageLlmInputPage[];
  // DOCTOR_PACK_LLM_BULK: when true, run this single-doc picker on Haiku 4.5 (cheaper + faster than the
  // Opus advisory default, which was costing ~5-6c/call and often unparsed) instead of Opus. Absent ⇒
  // Opus (byte-identical to every prior caller).
  readonly haiku?: boolean;
}): Promise<PageLlmResult | null> {
  const usable = input.pages.filter((p) => (p.text ?? '').trim().length > 0);
  if (!shouldUseLlmPicker(usable.length)) return null;

  const header = [
    `Document type: ${input.docType}`,
    input.claimedCondition && input.claimedCondition.trim().length > 0
      ? `Claimed condition for this case: ${input.claimedCondition.trim()}`
      : null,
    '',
    'Pages (text truncated to the top of each page):',
  ].filter((l) => l !== null);
  const pageLines = usable.map(
    (p) => `--- Page ${p.pageNumber} ---\n${p.text.slice(0, PAGE_TEXT_CHARS).replace(/\s+/g, ' ').trim()}`,
  );
  const userContent = [...header, ...pageLines].join('\n');

  try {
    const res = await invokeAdvisory(SYSTEM_PROMPT, userContent, {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      ...(input.haiku
        ? { modelId: HAIKU_MODEL_ID, pricePerMInput: HAIKU_PRICE_PER_M_INPUT_USD, pricePerMOutput: HAIKU_PRICE_PER_M_OUTPUT_USD }
        : {}),
    });
    const keep = parseKeep(res.text, usable.map((p) => p.pageNumber));
    if (keep === null) {
      console.warn(
        JSON.stringify({ msg: 'page_llm_unparsed_or_empty', docType: input.docType, pages: usable.length, costUsd: res.costUsd }),
      );
      return null;
    }
    return {
      pageRanges: rangesFromIncluded(keep),
      keptPageNumbers: keep,
      costUsd: res.costUsd,
      rationale: `page_llm kept ${keep.length}/${usable.length} pages ($${res.costUsd.toFixed(4)})`,
      label: extractLabelFromResponse(res.text),
    };
  } catch (e) {
    console.warn(
      JSON.stringify({ msg: 'page_llm_failed', docType: input.docType, error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

// ============================ DOCTOR_PACK_LLM_BULK (2026-07-11) ============================
// The BULK page-picker. Today large "bulk"/blue_button dumps (hundreds of pages) BYPASS the picker
// entirely (narrowOutOfLlmScope + the 60-page cap) and are page-selected by the brittle regex — so a
// sleep study buried in a Blue-Button export is never surfaced (both live OSA packs showed
// "DEFINING STUDY: Not found"). This routes the dump THROUGH the picker in bounded, PARALLEL Haiku
// batches, unions the kept pages, and returns them for the existing budget/importance machinery.
//
// SAFETY (this runs INLINE on the API Lambda's 30s API-Gateway path — aws-cloud-sme 2026-07-10):
//   - Haiku 4.5 (fast + a separate, higher Bedrock quota than the throttled Opus advisory path).
//   - Total pages sent is CAPPED (MAX_BULK_LLM_PAGES) so a 900-page dump can't blow the 30s window;
//     the $0 grounded-page union still pins high-yield pages from BEYOND the cap.
//   - Batches run at BULK_CONCURRENCY, each throttle-retried with backoff (the picker already throttles
//     Opus at 8-wide today; this bounds the Haiku fan-out).
//   - FAIL-SAFE: a per-batch failure contributes nothing; if ALL batches fail or the union is empty,
//     returns result:null so the caller falls back to runRegex() — NEVER fewer pages than today.
const BULK_BATCH_PAGES = 40;         // pages per Haiku call (~12k input tok at 1200 chars/page)
const MAX_BULK_LLM_PAGES = 200;      // hard cap on pages sent to the LLM (30s-window budget)
const BULK_CONCURRENCY = 3;          // simultaneous Haiku calls per bulk doc (throttle guard)
const BULK_DOC_MAX_KEEP = 12;        // cap on kept pages per bulk doc BEFORE the pack budget trims further
const BULK_RETRIES = 2;              // throttle retries per batch (exponential backoff)
const BULK_LABEL_MAX_CHARS = 40;

export interface BulkPickResult {
  // null ⇒ the caller must fall back to runRegex() (all batches failed, or the model kept nothing).
  readonly result: PageLlmResult | null;
  // Billed cost is returned REGARDLESS of result so the caller can always attribute spend (fixes the
  // cost-visibility leak where a billed-but-unparsed call incremented nothing — aws-cloud-sme).
  readonly costUsd: number;
  // A short, grounded per-DOCUMENT descriptor for the cover TOC (e.g. "Sleep study, AHI 42"); null when
  // the model gave none. Page refs are NEVER taken from the model — they come from the deterministic
  // pageRanges. So the label only ever echoes text the model read; the number is code-generated.
  readonly label: string | null;
}

function chunkPages(pages: readonly PageLlmInputPage[], size: number): PageLlmInputPage[][] {
  const out: PageLlmInputPage[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run fn over items with a bounded number of simultaneous in-flight calls (throttle guard). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** invokeAdvisory with throttle-aware retry+backoff. Returns null after the last retry (never throws)
 * so a batch failure degrades to "contributes nothing" rather than killing the whole bulk pass. */
async function invokeWithRetry(
  systemPrompt: string,
  userContent: string,
  opts: Parameters<typeof invokeAdvisory>[2],
  retries: number,
): Promise<Awaited<ReturnType<typeof invokeAdvisory>> | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await invokeAdvisory(systemPrompt, userContent, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const throttled = /throttl|too many requests|rate exceeded|429/i.test(msg);
      if (attempt >= retries || !throttled) {
        console.warn(JSON.stringify({ msg: 'page_llm_bulk_batch_failed', throttled, error: msg }));
        return null;
      }
      await sleep(250 * 2 ** attempt); // 250ms, 500ms, …
    }
  }
}

/** Strip any page/number references + quotes from a model-provided label and bound its length. Page
 * refs on the cover come from code (the pageRanges), never the model, so a label may only describe
 * CONTENT the model read. */
function sanitizeLabel(raw: string): string | null {
  let out = raw
    .replace(/\s+/g, ' ')
    .replace(/\bp\.?\s?\d+\b/gi, '')
    .replace(/\bpages?\s+\d+\b/gi, '')
    .replace(/["'`]/g, '')
    .trim()
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '')
    .trim();
  if (out.length === 0) return null;
  if (out.length > BULK_LABEL_MAX_CHARS) out = `${out.slice(0, BULK_LABEL_MAX_CHARS - 1).trimEnd()}…`;
  return out;
}

/** Pull a sanitized label/note out of a picker response (tolerant of prose/fences). Shared by the
 * single-doc picker (selectPagesLlm) and the bulk batches so EVERY LLM-picked doc can surface a real
 * cover descriptor. Prefers "label", falls back to the "note" the SYSTEM_PROMPT already asks for. */
export function extractLabelFromResponse(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { label?: unknown; note?: unknown };
    const raw = typeof obj.label === 'string' ? obj.label : typeof obj.note === 'string' ? obj.note : null;
    return typeof raw === 'string' ? sanitizeLabel(raw) : null;
  } catch {
    return null;
  }
}

/** Parse ONE batch's response: the kept page numbers (validated against this batch) + an optional
 * grounded label. Tolerant of stray prose / fences, like parseKeep. */
function parseBulkBatch(text: string, validPageNumbers: readonly number[]): { keep: number[]; label: string | null } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { keep: [], label: null };
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return { keep: [], label: null };
  }
  const valid = new Set(validPageNumbers);
  const keepRaw = (obj as { keep?: unknown }).keep;
  const keep = Array.isArray(keepRaw)
    ? [...new Set(keepRaw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && valid.has(n)))].sort((a, b) => a - b)
    : [];
  return { keep, label: extractLabelFromResponse(text) };
}

/** The per-batch user content. Reuses the shared (unchanged) SYSTEM_PROMPT and adds a bulk-mode block:
 * (a) "this is one SLICE — empty keep is a valid answer", (b) hunt the buried objective-test value page,
 * (c) emit a short grounded label. */
function buildBulkUserContent(
  input: { readonly docType: string; readonly claimedCondition?: string },
  batch: readonly PageLlmInputPage[],
): string {
  const cc = input.claimedCondition?.trim();
  const header = [
    `Document type: ${input.docType}`,
    cc && cc.length > 0 ? `Claimed condition for this case: ${cc}` : null,
    '',
    'These pages are ONE SLICE of a larger records export, not a whole document. Keep only pages that individually carry decisive substance. If NO page in this slice qualifies, return {"keep":[]} — that is a correct answer, not an error. Keep at most 3 pages from this slice.',
    'The single highest-priority page is the objective-test VALUE page for the claimed condition — e.g. a SLEEP STUDY page showing the apnea-hypopnea index (AHI) or respiratory disturbance index (RDI), an AUDIOGRAM threshold/speech-discrimination table, a PULMONARY FUNCTION TEST FEV1/FVC page. These decisive-value pages are easily buried in a bulk export; if you see one, KEEP it.',
    'Also add "label": a <=6 word description of the MOST decisive page you kept (e.g. "Sleep study, AHI 42", "OSA diagnosis note", "VA denial, OSA 2019"). Describe ONLY what you actually read; never state a value/date you did not see; NEVER put a page number in the label; leave it "" if unsure.',
    '',
    'Pages (text truncated to the top of each page):',
  ].filter((l): l is string => l !== null);
  const pageLines = batch.map(
    (p) => `--- Page ${p.pageNumber} ---\n${p.text.slice(0, PAGE_TEXT_CHARS).replace(/\s+/g, ' ').trim()}`,
  );
  return [...header, ...pageLines].join('\n');
}

/** Route a bulk records dump through the picker in bounded parallel Haiku batches. Never throws;
 * returns result:null (with any billed cost) when the caller must fall back to the regex selector. */
export async function selectPagesLlmBulk(input: {
  readonly docType: string;
  readonly claimedCondition?: string;
  readonly pages: readonly PageLlmInputPage[];
}): Promise<BulkPickResult> {
  const usable = input.pages.filter((p) => (p.text ?? '').trim().length > 0);
  if (usable.length < 3) return { result: null, costUsd: 0, label: null };
  // Bound total pages at the LLM (30s API-GW window). Grounded-page union still pins money pages beyond.
  const capped = usable.slice(0, MAX_BULK_LLM_PAGES);
  const batches = chunkPages(capped, BULK_BATCH_PAGES);

  const perBatch = await mapWithConcurrency(batches, BULK_CONCURRENCY, async (batch) => {
    const content = buildBulkUserContent(input, batch);
    const res = await invokeWithRetry(
      SYSTEM_PROMPT,
      content,
      {
        modelId: HAIKU_MODEL_ID,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        pricePerMInput: HAIKU_PRICE_PER_M_INPUT_USD,
        pricePerMOutput: HAIKU_PRICE_PER_M_OUTPUT_USD,
      },
      BULK_RETRIES,
    );
    if (res === null) return { keep: [] as number[], label: null as string | null, costUsd: 0, errored: true };
    const parsed = parseBulkBatch(res.text, batch.map((p) => p.pageNumber));
    return { keep: parsed.keep, label: parsed.label, costUsd: res.costUsd, errored: false };
  });

  const costUsd = perBatch.reduce((s, b) => s + b.costUsd, 0);
  if (perBatch.every((b) => b.errored)) {
    // Total failure (every batch threw/throttled out) → regex fallback, but report the billed cost.
    return { result: null, costUsd, label: null };
  }

  const keptSet = new Set<number>();
  for (const b of perBatch) for (const n of b.keep) keptSet.add(n);
  const kept = [...keptSet].sort((a, b) => a - b).slice(0, BULK_DOC_MAX_KEEP);
  if (kept.length === 0) {
    // Model judged the whole (sent) dump boilerplate → let regex have it (never fewer pages than today).
    return { result: null, costUsd, label: null };
  }

  // Label = the first non-empty batch label (its "most decisive page" descriptor).
  const label = perBatch.map((b) => b.label).find((l): l is string => l !== null && l.length > 0) ?? null;

  return {
    result: {
      pageRanges: rangesFromIncluded(kept),
      keptPageNumbers: kept,
      costUsd,
      rationale: `page_llm_bulk kept ${kept.length}/${capped.length} pages in ${batches.length} batch(es) on haiku ($${costUsd.toFixed(4)})`,
    },
    costUsd,
    label,
  };
}
