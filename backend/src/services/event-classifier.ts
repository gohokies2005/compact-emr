/**
 * LLM in-service EVENT classifier (DARK, additive). The deterministic eventCanon resolver
 * (vendored at backend/src/vendor/eventCanon.cjs) covers conceded fields + lay regex, but it abstains
 * (~24% on real STR text) when an in-service event is documented obliquely in free-text notes the
 * regex doesn't catch ("feet rotted in my boots" → cold_injury). This module is the ADDITIVE recall
 * layer: a single Sonnet 4.6 tool call over the STR text NOT already covered by deterministic
 * concession fields, emitting the SAME closed EVENT_ENUM + a verbatim evidence span.
 *
 * GROUNDING (anti-fabrication, structural — never trust the model's word):
 *   1. event_canonical MUST be in the vendored EVENT_ENUM (the tool enum is BUILT from that array, and
 *      verifyAndNormalize re-checks it — a hallucinated value is dropped, never written).
 *   2. evidence_span MUST be a whitespace-normalized verbatim substring of the chart text the model was
 *      given. A span the model invented (not on the page) is dropped. This is the eventCanon._clean
 *      contract: replace(/\s+/g,' ').trim() on BOTH sides.
 *   3. abstain-by-default: empty output is the correct answer when nothing is documented; the model is
 *      told NOT to infer the event from the claimed condition.
 *
 * DARK: classifyEvents() is only invoked behind DIRECT_SC_VIABILITY_ENABLED === 'true' (same flag that
 * gates the EMR direct-SC path). When off, NOTHING about chart-extract changes. The pure helpers
 * (verifyAndNormalize, mergeDedupe) and the tool schema have no side effects and are safe to import.
 *
 * The model NEVER decides what gets recorded — code does, via verifyAndNormalize, exactly like the
 * chart-extract grounding gate (groundExtractedItem). Sibling design to chart-extract-llm.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── vendored EVENT_ENUM (single source of truth — the closed 16-value set) ───────────────
// Loaded at RUNTIME via createRequire with an ABSOLUTE entry (the established vendor convention in
// case-viability.ts / realRetrieve.ts) so it is format-agnostic: it works whether esbuild emits CJS or
// ESM, and avoids import.meta.url (undefined in a CJS bundle). The .cjs is NOT esbuild-bundled — it is
// read from disk like the anchor/advisory vendor trees. The 16 values are content-pinned by the test.
interface EventCanonModule {
  EVENT_ENUM: readonly string[];
  isValidEvent(evt: string): boolean;
  isPresumptiveEvent(evt: string): boolean;
}

const VENDOR_DIR = process.env['EVENT_CANON_VENDOR_DIR'] ?? 'event-canon-vendor';

let _eventCanon: EventCanonModule | null = null;
function loadEventCanon(): EventCanonModule {
  if (_eventCanon !== null) return _eventCanon;
  const candidates = [
    path.join(process.cwd(), VENDOR_DIR, 'eventCanon.cjs'),               // Lambda runtime (afterBundling copy)
    path.join(process.cwd(), 'src', 'vendor', 'eventCanon.cjs'),          // backend/ cwd (vitest, tsx dev)
    path.join(process.cwd(), 'backend', 'src', 'vendor', 'eventCanon.cjs'), // repo-root cwd
  ];
  const entry = candidates.find((c) => existsSync(c));
  if (entry === undefined) {
    throw new Error(`eventCanon vendor module not found (tried: ${candidates.join(' | ')})`);
  }
  const req = createRequire(path.join(process.cwd(), '_event_canon_require_base.cjs'));
  _eventCanon = req(entry) as EventCanonModule;
  return _eventCanon;
}

/** The closed 16-value enum, pulled from the vendored single source of truth. */
export function eventEnum(): readonly string[] {
  return loadEventCanon().EVENT_ENUM;
}

// ── result shapes ────────────────────────────────────────────────────────────────────────
export type EventConfidence = 'high' | 'medium' | 'low';

/** One event as returned by the model, before verify+normalize. */
export interface RawClassifiedEvent {
  event_canonical: string;
  evidence_span: string;
  confidence: EventConfidence;
}

/** A verified, grounded event ready to consume. `evidence` is the on-page verbatim span. */
export interface ClassifiedEvent {
  event_canonical: string;
  evidence: string;
  confidence: EventConfidence;
  source: 'llm_str_classify';
}

/** A deterministic (eventCanon) event, as the merge consumes it. */
export interface DeterministicEvent {
  event_canonical: string;
  evidence: string;
  source: string; // 'chart_concession' | 'chart_event_text' | 'free_text'
}

// ── forced tool schema — event_canonical enum BUILT from the vendored array ────────────────
// The enum is constructed FROM eventEnum() at module-eval time, NOT hand-typed, so the tool schema can
// never drift from the closed set the deterministic floor uses. verifyAndNormalize re-checks against
// the SAME array as the defensive layer (the schema constrains the model; the code is authoritative).
export const EXTRACT_TOOL_EVENTS: Anthropic.Tool = {
  name: 'record_in_service_events',
  description:
    'Record the in-service EVENTS, INJURIES, EXPOSURES, or duty conditions that are DOCUMENTED VERBATIM ' +
    'in the provided record text. Only emit an event if the text literally describes it. Never infer an ' +
    'event from the claimed condition. Each event must carry a verbatim evidence_span copied from the text.',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            event_canonical: {
              type: 'string',
              // BUILT from the vendored EVENT_ENUM — never hand-typed.
              enum: [...eventEnum()],
              description: 'The canonical in-service event type, chosen from the closed enum.',
            },
            evidence_span: {
              type: 'string',
              description: 'A short VERBATIM substring copied EXACTLY from the record text that documents this event.',
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'high = explicitly documented; medium = strongly implied by the wording; low = oblique mention.',
            },
          },
          required: ['event_canonical', 'evidence_span', 'confidence'],
        },
      },
    },
    required: ['events'],
  },
};

// ── system prompt ──────────────────────────────────────────────────────────────────────────
export const EVENT_CLASSIFIER_SYSTEM_PROMPT = [
  'You read a section of a veteran\'s service treatment records (STR) and free-text history and identify the',
  'in-service EVENTS, INJURIES, EXPOSURES, or duty conditions that are DOCUMENTED in the text.',
  '',
  'HARD RULES:',
  '- Emit ONLY values from the closed enum on the record_in_service_events tool. Never invent an event type.',
  '- Every event MUST carry an evidence_span that is a VERBATIM substring copied exactly from the record text.',
  '  Copy the words as written. If you cannot quote it from the text, do not emit it.',
  '- ABSTAIN BY DEFAULT. If the text does not describe an in-service event, return an empty events array.',
  '  An empty answer is correct and expected — most sections contain no in-service event.',
  '- DO NOT infer the event from the claimed condition. A knee claim does NOT mean you should emit',
  '  acute_in_service_injury unless the text actually describes an injury. A hearing claim does NOT mean',
  '  mos_acoustic_noise unless the text actually describes noise exposure. The event must be in the text.',
  '',
  'UNDERSTAND LAY AND OBLIQUE PHRASING — veterans describe events in plain words, not enum labels:',
  '  - "feet rotted in my boots", "couldn\'t feel my toes for weeks in the field" → cold_injury',
  '  - "Khe Sanh, heavy fighting, saw things I can\'t forget", "watched my friend die" → criterion_a_trauma',
  '  - "ears rang for days after the range", "no hearing protection on the flight line" → mos_acoustic_noise',
  '  - "assaulted by another soldier", "unwanted sexual contact by a superior" → mst',
  '  - "humped a 90-pound ruck every day", "jumped out of planes" → repetitive_msk_load',
  '  - "worked with jet fuel daily", "cleaned parts in solvent" → chemical_solvent_fuel_tera',
  '',
  'EMIT PRESUMPTIVE EVENTS NORMALLY. If the text documents burn-pit/airborne hazard, Agent Orange/herbicide,',
  'Gulf War environmental, Camp Lejeune water, or ionizing radiation exposure, emit the matching enum value',
  'like any other event — downstream logic handles the presumptive redirect. Do not suppress them.',
  '',
  'Set confidence honestly: high for an explicitly documented event, medium for strongly-implied wording,',
  'low for an oblique mention. Confidence does not gate emission — grounding does.',
].join('\n');

// ── pure: verify + normalize ──────────────────────────────────────────────────────────────
// Whitespace-normalize EXACTLY like eventCanon._clean so the substring match lines up with the
// deterministic floor's notion of "verbatim". Never date-parse, never interpret — substring only.
function clean(s: unknown): string {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
}

/**
 * PURE. Drop any event whose event_canonical ∉ enum; drop any whose evidence_span is NOT a
 * whitespace-normalized verbatim substring of chartText; dedupe by event_canonical (first-wins);
 * map evidence_span → evidence; stamp source. ENUM_SET is passed so this stays pure (no vendor load
 * in the hot path / in tests). This is the structural anti-fabrication gate — the model's output is
 * advisory; this function decides what survives.
 */
export function verifyAndNormalize(
  events: readonly RawClassifiedEvent[] | undefined | null,
  chartText: string,
  ENUM_SET: ReadonlySet<string>,
): ClassifiedEvent[] {
  if (!Array.isArray(events)) return [];
  const haystack = clean(chartText);
  const seen = new Set<string>();
  const out: ClassifiedEvent[] = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const evt = typeof e.event_canonical === 'string' ? e.event_canonical : '';
    if (!ENUM_SET.has(evt)) continue;                            // enum gate
    if (seen.has(evt)) continue;                                 // dedupe by event_canonical (first-wins)
    const span = typeof e.evidence_span === 'string' ? e.evidence_span : '';
    const cleanSpan = clean(span);
    if (cleanSpan.length < 3 || !haystack.includes(cleanSpan)) continue; // grounding gate (verbatim on page)
    const confidence: EventConfidence =
      e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low' ? e.confidence : 'low';
    seen.add(evt);
    out.push({ event_canonical: evt, evidence: span, confidence, source: 'llm_str_classify' });
  }
  return out;
}

/**
 * PURE. Merge deterministic (concession/regex) events with LLM-residual events. The DETERMINISTIC
 * event WINS on an event_canonical conflict — a VA-conceded flag or a verbatim regex hit is
 * higher-confidence than an LLM recall guess. LLM events fill only the gaps the floor missed.
 */
export function mergeDedupe(
  det: readonly DeterministicEvent[] | undefined | null,
  llm: readonly ClassifiedEvent[] | undefined | null,
): Array<DeterministicEvent | ClassifiedEvent> {
  const out: Array<DeterministicEvent | ClassifiedEvent> = [];
  const seen = new Set<string>();
  for (const d of det ?? []) {
    if (!d || seen.has(d.event_canonical)) continue;
    seen.add(d.event_canonical);
    out.push(d);
  }
  for (const l of llm ?? []) {
    if (!l || seen.has(l.event_canonical)) continue; // deterministic already won this slot
    seen.add(l.event_canonical);
    out.push(l);
  }
  return out;
}

// ── live classifier (DARK — only invoked behind DIRECT_SC_VIABILITY_ENABLED) ──────────────
/** Same flag that gates the EMR direct-SC path. Default OFF — read per-call so a deploy can flip it. */
export function eventClassifierEnabled(): boolean {
  return process.env.DIRECT_SC_VIABILITY_ENABLED === 'true';
}

const EVENT_CLASSIFIER_MODEL = process.env.EVENT_CLASSIFIER_MODEL ?? 'claude-sonnet-4-6';
// QA AI-SME: 1024 could silently truncate the tool-call array on a multi-event chart (stop_reason
// max_tokens → ABSTAIN, events lost). 2048 gives ample headroom for ≤16 short {event, span} entries.
const EVENT_CLASSIFIER_MAX_TOKENS = 2048;

/**
 * Run the conceded-first / LLM-residual flow over residual STR text (text NOT already covered by the
 * deterministic concession fields — the caller is responsible for passing the residual). ONE Sonnet 4.6
 * tool call, forced tool_choice, NO temperature, NO thinking. NEVER throws: on stop_reason !== 'tool_use'
 * (refusal / max_tokens / unexpected) it ABSTAINS (returns []), exactly like the chart-extract grounding
 * path treats a truncated window as "lost", never as a fatal error. Result passes through
 * verifyAndNormalize so the same enum + grounding gates apply to live output.
 */
export async function classifyEvents(args: {
  chartText: string;
  anthropic: Anthropic;
  model?: string;
}): Promise<ClassifiedEvent[]> {
  const { chartText, anthropic } = args;
  if (!chartText || !chartText.trim()) return [];
  const enumSet = new Set(loadEventCanon().EVENT_ENUM);
  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create({
      model: args.model ?? EVENT_CLASSIFIER_MODEL,
      max_tokens: EVENT_CLASSIFIER_MAX_TOKENS,
      system: EVENT_CLASSIFIER_SYSTEM_PROMPT,
      tools: [EXTRACT_TOOL_EVENTS],
      tool_choice: { type: 'tool', name: 'record_in_service_events' },
      messages: [{ role: 'user', content: `RECORD TEXT:\n${chartText}` }],
    });
  } catch (err) {
    // Network / API error — abstain, never throw. The deterministic floor still stands on its own.
    console.warn(JSON.stringify({ event: 'event_classifier_call_failed', error: err instanceof Error ? err.message : String(err) }));
    return [];
  }
  // stop_reason !== 'tool_use' (refusal, max_tokens truncating the tool array, end_turn with no call)
  // → ABSTAIN. A truncated/forced-off tool call cannot be trusted to be complete or well-formed.
  if (resp.stop_reason !== 'tool_use') {
    console.warn(JSON.stringify({ event: 'event_classifier_abstain', stopReason: resp.stop_reason }));
    return [];
  }
  const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const input = block ? (block.input as { events?: RawClassifiedEvent[] }) : null;
  return verifyAndNormalize(input?.events, chartText, enumSet);
}
