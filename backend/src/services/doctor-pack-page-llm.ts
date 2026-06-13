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

import { invokeAdvisory } from '../advisory/bedrockClient.js';
import { rangesFromIncluded } from './page-selector.js';
import type { KeyDocPageRange } from './db-types.js';

export const PAGE_LLM_VERSION = 'page-llm-1.0.0';

// The classifying signal — VA enclosure headers ("Armed Forces Commissary and Exchange", "Your
// monthly entitlement amount"), "Reasons for Decision", a diagnosis line — sits at the TOP of a
// page, so the first ~600 chars classify reliably at a fraction of the full-page token cost.
const PAGE_TEXT_CHARS = 600;
// Safety cap: docs bigger than this skip the LLM and fall back to regex (keeps cost bounded and
// avoids dumping a 500-page blue-button export at the model). The real VA decision letter is well
// under this; its decision pages are early.
const MAX_PAGES_FOR_LLM = 60;
// Output cap — we only need a short JSON keep-list, never prose.
const MAX_OUTPUT_TOKENS = 700;

// Ryan's guidance, made explicit (2026-06-12: "give it a little guidance and it should do just
// fine"). KEEP = medical/claim substance a nexus-letter physician needs. DROP = administrative /
// benefit boilerplate. The system prompt is the CACHED prefix (cache_control in bedrockClient) so
// repeated docs/cases pay almost nothing for it.
const SYSTEM_PROMPT = `You curate a U.S. veteran's VA disability records into a TIGHT pack for a physician who will write a nexus (medical opinion) letter. For ONE document at a time, you receive its pages (text, truncated). Decide which pages to KEEP and which to DROP. Bias hard toward a SMALL pack — a few pages per document. The physician wants signal, not the whole chart.

KEEP a page when it carries the substance the physician actually needs:
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
    };
  } catch (e) {
    console.warn(
      JSON.stringify({ msg: 'page_llm_failed', docType: input.docType, error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}
