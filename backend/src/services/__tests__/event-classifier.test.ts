// Event-classifier pure-function tests + the vendored-enum drift pin. No live API calls.
//
// The enum pin is the LOUD build-failure guard: if backend/src/vendor/eventCanon.cjs drifts from the
// 16 FRN-canonical values (a stale vendor copy), THIS TEST FAILS, surfacing the drift before any chart
// is parsed against a wrong enum. The forced-tool schema's event_canonical enum is asserted equal to
// the vendored EVENT_ENUM so the schema can never diverge from the deterministic floor.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import {
  EXTRACT_TOOL_EVENTS,
  EVENT_CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_MAX_INPUT_CHARS,
  eventEnum,
  segmentChartText,
  classifyEvents,
  verifyAndNormalize,
  mergeDedupe,
  type RawClassifiedEvent,
  type ClassifiedEvent,
  type DeterministicEvent,
} from '../event-classifier.js';

// The 16 frozen FRN-canonical event types (eventCanon.js EVENT_ENUM). Hand-listed here ON PURPOSE so a
// vendor copy that drops/renames/adds a value fails against this independent expectation.
const EXPECTED_EVENT_ENUM = [
  'mos_acoustic_noise',
  'blast_tbi',
  'repetitive_msk_load',
  'acute_in_service_injury',
  'criterion_a_trauma',
  'mst',
  'chronic_operational_stress',
  'chemical_solvent_fuel_tera',
  'burn_pit_airborne',
  'herbicide_agent_orange',
  'gulf_war_environmental',
  'camp_lejeune_water',
  'ionizing_radiation',
  'cold_injury',
  'asbestos',
  'chronic_disease_1yr',
] as const;

// Extract the enum the tool schema actually constrains the model to.
function schemaEventEnum(): string[] {
  const schema = EXTRACT_TOOL_EVENTS.input_schema as {
    properties: { events: { items: { properties: { event_canonical: { enum: string[] } } } } };
  };
  return schema.properties.events.items.properties.event_canonical.enum;
}

describe('vendored enum drift pin', () => {
  it('vendored eventCanon.cjs EVENT_ENUM equals the 16 expected FRN-canonical values (no drift)', () => {
    // Load the vendor copy directly (independent of the classifier module's loader) to prove the file
    // on disk carries exactly the expected set, in order.
    const req = createRequire(fileURLToPath(import.meta.url));
    const vendor = req('../../vendor/eventCanon.cjs') as { EVENT_ENUM: readonly string[] };
    expect([...vendor.EVENT_ENUM]).toEqual([...EXPECTED_EVENT_ENUM]);
    expect(vendor.EVENT_ENUM.length).toBe(16);
  });

  it('classifier eventEnum() returns the same 16 values the vendor exports', () => {
    expect([...eventEnum()]).toEqual([...EXPECTED_EVENT_ENUM]);
  });
});

describe('EXTRACT_TOOL_EVENTS schema', () => {
  it('event_canonical enum === the vendored EVENT_ENUM (schema built from the array, no hand-typed drift)', () => {
    expect(schemaEventEnum()).toEqual([...eventEnum()]);
  });

  it('every allowed enum value is a member of the canonical enum', () => {
    const canonical = new Set(eventEnum());
    for (const v of schemaEventEnum()) {
      expect(canonical.has(v)).toBe(true);
    }
  });

  it('forces the record_in_service_events tool and requires evidence_span + confidence', () => {
    expect(EXTRACT_TOOL_EVENTS.name).toBe('record_in_service_events');
    const item = (EXTRACT_TOOL_EVENTS.input_schema as {
      properties: { events: { items: { required: string[] } } };
    }).properties.events.items.required;
    expect(item).toContain('event_canonical');
    expect(item).toContain('evidence_span');
    expect(item).toContain('confidence');
  });

  it('system prompt instructs verbatim evidence + abstain-by-default + no-inference', () => {
    expect(EVENT_CLASSIFIER_SYSTEM_PROMPT).toMatch(/VERBATIM/);
    expect(EVENT_CLASSIFIER_SYSTEM_PROMPT).toMatch(/ABSTAIN BY DEFAULT/);
    expect(EVENT_CLASSIFIER_SYSTEM_PROMPT).toMatch(/DO NOT infer the event from the claimed condition/);
  });
});

describe('verifyAndNormalize', () => {
  const ENUM = new Set(eventEnum());
  const TEXT = 'Veteran reports his ears rang for days after the range. No hearing protection on the flight line.';

  it('keeps a valid enum value with a verbatim on-page evidence_span, mapping span→evidence and stamping source', () => {
    const raw: RawClassifiedEvent[] = [
      { event_canonical: 'mos_acoustic_noise', evidence_span: 'ears rang for days after the range', confidence: 'high' },
    ];
    const out = verifyAndNormalize(raw, TEXT, ENUM);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      event_canonical: 'mos_acoustic_noise',
      evidence: 'ears rang for days after the range',
      confidence: 'high',
      source: 'llm_str_classify',
    });
  });

  it('drops an event whose evidence_span is FABRICATED (not a substring of chartText)', () => {
    const raw: RawClassifiedEvent[] = [
      { event_canonical: 'cold_injury', evidence_span: 'feet froze in the arctic for a month', confidence: 'high' },
    ];
    expect(verifyAndNormalize(raw, TEXT, ENUM)).toHaveLength(0);
  });

  it('drops an event whose event_canonical is NOT in the enum (hallucinated value)', () => {
    const raw: RawClassifiedEvent[] = [
      { event_canonical: 'alien_abduction', evidence_span: 'ears rang for days after the range', confidence: 'high' },
    ];
    expect(verifyAndNormalize(raw, TEXT, ENUM)).toHaveLength(0);
  });

  it('verifies a span that differs only in whitespace (collapsed/expanded) — normalized verbatim match', () => {
    const text = 'He   humped a 90-pound ruck\n   every single day in the field.';
    const raw: RawClassifiedEvent[] = [
      // multiple/odd whitespace in the span; should still match after _clean-style normalization
      { event_canonical: 'repetitive_msk_load', evidence_span: 'humped a 90-pound ruck   every single day', confidence: 'medium' },
    ];
    const out = verifyAndNormalize(raw, text, ENUM);
    expect(out).toHaveLength(1);
    expect(out[0]!.event_canonical).toBe('repetitive_msk_load');
  });

  it('dedupes by event_canonical (first-wins)', () => {
    const raw: RawClassifiedEvent[] = [
      { event_canonical: 'mos_acoustic_noise', evidence_span: 'ears rang for days after the range', confidence: 'high' },
      { event_canonical: 'mos_acoustic_noise', evidence_span: 'No hearing protection on the flight line', confidence: 'low' },
    ];
    const out = verifyAndNormalize(raw, TEXT, ENUM);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe('ears rang for days after the range');
  });

  it('coerces an invalid confidence value to low', () => {
    const raw = [
      { event_canonical: 'mos_acoustic_noise', evidence_span: 'ears rang for days after the range', confidence: 'extreme' },
    ] as unknown as RawClassifiedEvent[];
    const out = verifyAndNormalize(raw, TEXT, ENUM);
    expect(out[0]!.confidence).toBe('low');
  });

  it('returns [] for null/undefined/non-array input (abstain-safe)', () => {
    expect(verifyAndNormalize(undefined, TEXT, ENUM)).toEqual([]);
    expect(verifyAndNormalize(null, TEXT, ENUM)).toEqual([]);
    expect(verifyAndNormalize([], TEXT, ENUM)).toEqual([]);
  });
});

describe('mergeDedupe', () => {
  it('deterministic event WINS on an event_canonical conflict with the LLM event', () => {
    const det: DeterministicEvent[] = [
      { event_canonical: 'mos_acoustic_noise', evidence: 'noise_exposure_conceded=true', source: 'chart_concession' },
    ];
    const llm: ClassifiedEvent[] = [
      { event_canonical: 'mos_acoustic_noise', evidence: 'ears rang for days', confidence: 'low', source: 'llm_str_classify' },
      { event_canonical: 'cold_injury', evidence: 'feet rotted in my boots', confidence: 'high', source: 'llm_str_classify' },
    ];
    const out = mergeDedupe(det, llm);
    expect(out).toHaveLength(2);
    // deterministic concession survives for the conflicting slot
    const noise = out.find((e) => e.event_canonical === 'mos_acoustic_noise')!;
    expect((noise as DeterministicEvent).source).toBe('chart_concession');
    // the LLM-only event fills the gap
    expect(out.some((e) => e.event_canonical === 'cold_injury')).toBe(true);
  });

  it('handles empty/missing sides', () => {
    const llm: ClassifiedEvent[] = [
      { event_canonical: 'cold_injury', evidence: 'feet rotted in my boots', confidence: 'high', source: 'llm_str_classify' },
    ];
    expect(mergeDedupe([], llm)).toHaveLength(1);
    expect(mergeDedupe(undefined, undefined)).toEqual([]);
    expect(mergeDedupe(llm, [])).toHaveLength(1);
  });
});

// ───────────────────────── segmentation (Kimbrough >1M-token fix) ─────────────────────────

describe('segmentChartText', () => {
  it('returns the whole text as ONE segment when it fits under the cap', () => {
    const text = '[p.1] short page\n[p.2] another';
    expect(segmentChartText(text, 1_000)).toEqual([text]);
  });

  it('splits at [p.N] page-marker boundaries with FULL coverage (join === original) and every segment ≤ cap', () => {
    const pages = Array.from({ length: 6 }, (_, i) => `[p.${i + 1}] ${'x'.repeat(20)}`);
    const text = pages.join('\n'); // each block ~27 chars incl. trailing '\n'
    const segments = segmentChartText(text, 60);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join('')).toBe(text); // full coverage — nothing dropped or duplicated
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(60);
    // every segment after the first starts at a page marker (never mid-page)
    for (const s of segments.slice(1)) expect(s).toMatch(/^\[p\.\d+\]/);
  });

  it('hard-slices marker-less text (fallback) with full coverage', () => {
    const text = 'no page markers here '.repeat(20); // 420 chars
    const segments = segmentChartText(text, 100);
    expect(segments.length).toBe(5);
    expect(segments.join('')).toBe(text);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(100);
  });

  it('hard-slices a SINGLE oversized page block while keeping neighbors on marker boundaries', () => {
    const text = `[p.1] small\n[p.2] ${'y'.repeat(300)}\n[p.3] tail`;
    const segments = segmentChartText(text, 100);
    expect(segments.join('')).toBe(text);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(100);
  });

  it('handles empty input', () => {
    expect(segmentChartText('', 100)).toEqual([]);
  });
});

// ───────────────────────── classifyEvents call-shape (mocked client) ─────────────────────────

function toolUseResponse(events: RawClassifiedEvent[]): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'record_in_service_events', input: { events } }],
  };
}

function mockAnthropic(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

// Build an over-cap chart: `pageTexts[i]` becomes page i+1, each padded to `padTo` chars of filler.
function bigChart(pageTexts: string[], padTo: number): string {
  return pageTexts
    .map((t, i) => `[p.${i + 1}] ${t} ${'lorem ipsum dolor '.repeat(Math.ceil(padTo / 18)).slice(0, padTo)}`)
    .join('\n');
}

describe('classifyEvents — below-cap single-call path (byte-identical no-regression pin)', () => {
  it('under the cap → exactly ONE model call whose request is BYTE-IDENTICAL to the pre-segmentation shape', async () => {
    const chartText = '[p.1] Veteran reports his ears rang for days after the range.\n[p.2] No hearing protection on the flight line.';
    expect(chartText.length).toBeLessThanOrEqual(CLASSIFIER_MAX_INPUT_CHARS);
    const create = vi.fn(async () => toolUseResponse([
      { event_canonical: 'mos_acoustic_noise', evidence_span: 'ears rang for days after the range', confidence: 'high' },
    ]));
    const out = await classifyEvents({ chartText, anthropic: mockAnthropic(create) });
    expect(create).toHaveBeenCalledTimes(1);
    // The FULL request object, field for field — the exact request the pre-fix code sent. Any drift
    // here is a below-cap regression.
    expect((create.mock.calls[0] as unknown as [unknown])[0]).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: EVENT_CLASSIFIER_SYSTEM_PROMPT,
      tools: [EXTRACT_TOOL_EVENTS],
      tool_choice: { type: 'tool', name: 'record_in_service_events' },
      messages: [{ role: 'user', content: `RECORD TEXT:\n${chartText}` }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.event_canonical).toBe('mos_acoustic_noise');
  });

  it('below-cap API failure still abstains to [] (fail-open contract unchanged)', async () => {
    const create = vi.fn(async () => { throw new Error('prompt is too long'); });
    const out = await classifyEvents({ chartText: '[p.1] some text', anthropic: mockAnthropic(create) });
    expect(out).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('classifyEvents — over-cap segmentation path', () => {
  // ~2× the cap: 3 pages of ~cap*0.45 chars each → 2 segments at marker boundaries.
  const PAD = Math.ceil(CLASSIFIER_MAX_INPUT_CHARS * 0.45);
  const NOISE = 'his ears rang for days after the range';
  const COLD = 'my feet rotted in my boots in the field';

  it('runs N sequential calls (one per segment) and first-wins dedupes by event_canonical across segments', async () => {
    // NOISE appears in page 1 (segment 1) AND page 3 (segment 2); COLD only in page 3 (segment 2).
    const chartText = bigChart([NOISE, 'nothing here', `${NOISE} and ${COLD}`], PAD);
    expect(chartText.length).toBeGreaterThan(CLASSIFIER_MAX_INPUT_CHARS);
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseResponse([
        { event_canonical: 'mos_acoustic_noise', evidence_span: NOISE, confidence: 'high' },
      ]))
      .mockResolvedValueOnce(toolUseResponse([
        { event_canonical: 'mos_acoustic_noise', evidence_span: NOISE, confidence: 'low' }, // dup → dropped
        { event_canonical: 'cold_injury', evidence_span: COLD, confidence: 'medium' },
      ]));
    const out = await classifyEvents({ chartText, anthropic: mockAnthropic(create) });
    expect(create).toHaveBeenCalledTimes(2);
    // Each call carried its OWN segment, and the segments tile the original text.
    const sentTexts = create.mock.calls.map((c) => (c[0] as { messages: [{ content: string }] }).messages[0].content.slice('RECORD TEXT:\n'.length));
    expect(sentTexts.join('')).toBe(chartText);
    expect(out).toHaveLength(2);
    const noise = out.find((e) => e.event_canonical === 'mos_acoustic_noise')!;
    expect(noise.confidence).toBe('high'); // segment 1's copy won (first-wins)
    expect(out.some((e) => e.event_canonical === 'cold_injury')).toBe(true);
  });

  it('verifies each segment against its OWN text — a span lifted from another segment is dropped', async () => {
    const chartText = bigChart([NOISE, 'nothing here', COLD], PAD);
    const create = vi.fn()
      // Call 1 (segment 1): COLD is NOT in segment 1 → grounding must drop it there.
      .mockResolvedValueOnce(toolUseResponse([
        { event_canonical: 'cold_injury', evidence_span: COLD, confidence: 'high' },
        { event_canonical: 'mos_acoustic_noise', evidence_span: NOISE, confidence: 'high' },
      ]))
      // Call 2 (segment 2): COLD is on-page here → survives.
      .mockResolvedValueOnce(toolUseResponse([
        { event_canonical: 'cold_injury', evidence_span: COLD, confidence: 'medium' },
      ]));
    const out = await classifyEvents({ chartText, anthropic: mockAnthropic(create) });
    expect(out).toHaveLength(2);
    const cold = out.find((e) => e.event_canonical === 'cold_injury')!;
    expect(cold.confidence).toBe('medium'); // the SEGMENT-2 grounded copy, not segment 1's ungrounded claim
  });

  it('one segment THROWING still returns the other segments\' events (per-segment fail-open)', async () => {
    const chartText = bigChart(['nothing here', 'still nothing', COLD], PAD);
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('529 overloaded'))
      .mockResolvedValueOnce(toolUseResponse([
        { event_canonical: 'cold_injury', evidence_span: COLD, confidence: 'high' },
      ]));
    const out = await classifyEvents({ chartText, anthropic: mockAnthropic(create) });
    expect(create).toHaveBeenCalledTimes(2); // the failure did not abort the loop
    expect(out).toHaveLength(1);
    expect(out[0]!.event_canonical).toBe('cold_injury');
  });
});
