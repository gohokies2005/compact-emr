// SSOT caseFraming PRODUCER tests (build-plan §5.1 / §6, D3+D7).
// Locks: (1) the vendored schema's sha256 against the cross-repo pin — the drafter repo owns the
// canonical; any independent edit to the vendored copy goes red here; (2) every producer output
// validates against the schema (walked with the same minimal validator the drafter-side contract
// test uses — no ajv in either repo); (3) the §2.4 precedence ladder golden cases; (4) the §2.6
// anchor hygiene invariants (strict filter / dedupe / self-exclusion / ordering).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveCaseFraming,
  deriveFramingFromEvidence,
  buildGrantedScAnchors,
  normalizeFramingChoice,
  type CaseFraming,
  type CaseFramingCaseInput,
  type ScConditionInput,
} from '../services/case-framing.js';

// ---------------------------------------------------------------------------
// Cross-repo contract pin
// ---------------------------------------------------------------------------
const PINNED_SHA256 = '33629b053c17fb4ff7fcd3909b170f331d0ee737da6115a7198d49de88633401';
const schemaUrl = new URL('../config/caseFraming.v1.schema.json', import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const schema = JSON.parse(schemaBytes.toString('utf8'));

describe('vendored schema pin', () => {
  it('vendored caseFraming.v1.schema.json is byte-identical to the drafter canonical (sha256 pin)', () => {
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(PINNED_SHA256);
  });
});

// ---------------------------------------------------------------------------
// Minimal schema walker — same semantics as the drafter-side contract test
// (flatratenexus-project app/services/__tests__/caseFraming-contract.test.js).
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
function typeOk(val: any, type: any): boolean {
  if (Array.isArray(type)) return type.some((t) => typeOk(val, t));
  switch (type) {
    case 'object': return val !== null && typeof val === 'object' && !Array.isArray(val);
    case 'array': return Array.isArray(val);
    case 'string': return typeof val === 'string';
    case 'integer': return typeof val === 'number' && Number.isInteger(val);
    case 'number': return typeof val === 'number';
    case 'null': return val === null;
    case 'boolean': return typeof val === 'boolean';
    default: return false;
  }
}

function validate(node: any, val: any, pathStr: string, errs: string[]): string[] {
  if (node.type && !typeOk(val, node.type)) {
    errs.push(`${pathStr}: expected type ${JSON.stringify(node.type)}, got ${val === null ? 'null' : typeof val}`);
    return errs;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'const') && val !== node.const) {
    errs.push(`${pathStr}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(val)}`);
  }
  if (node.enum && !node.enum.some((e: any) => e === val)) {
    errs.push(`${pathStr}: value ${JSON.stringify(val)} not in enum ${JSON.stringify(node.enum)}`);
  }
  if (typeof val === 'string' && typeof node.minLength === 'number' && val.length < node.minLength) {
    errs.push(`${pathStr}: string shorter than minLength ${node.minLength}`);
  }
  if (typeof val === 'number') {
    if (typeof node.minimum === 'number' && val < node.minimum) errs.push(`${pathStr}: ${val} < minimum ${node.minimum}`);
    if (typeof node.maximum === 'number' && val > node.maximum) errs.push(`${pathStr}: ${val} > maximum ${node.maximum}`);
  }
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || node.properties) {
    if (typeOk(val, 'object')) {
      const props = node.properties || {};
      for (const req of node.required || []) {
        if (!Object.prototype.hasOwnProperty.call(val, req)) errs.push(`${pathStr}: missing required field "${req}"`);
      }
      if (node.additionalProperties === false) {
        for (const k of Object.keys(val)) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) errs.push(`${pathStr}: additional property "${k}" not allowed`);
        }
      }
      for (const [k, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(val, k)) validate(sub, val[k], `${pathStr}.${k}`, errs);
      }
    }
  }
  if ((node.type === 'array' || (Array.isArray(node.type) && node.type.includes('array'))) && node.items) {
    if (Array.isArray(val)) val.forEach((el: any, i: number) => validate(node.items, el, `${pathStr}[${i}]`, errs));
  }
  return errs;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function expectSchemaValid(obj: CaseFraming): void {
  expect(validate(schema, obj, '$', [])).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = new Date('2026-06-10T00:00:00Z');

function caseInput(overrides: Partial<CaseFramingCaseInput> = {}): CaseFramingCaseInput {
  return {
    claimedCondition: 'Obstructive Sleep Apnea',
    claimType: 'supplemental',
    framingChoice: null,
    upstreamScCondition: null,
    veteranStatement: null,
    ...overrides,
  };
}

// Hatfield-shaped: OSA claimed; granted SC anxiety 70% among a realistic granted set.
const HATFIELD_SC: ScConditionInput[] = [
  { condition: 'Anxiety', ratingPct: 70, status: 'service_connected' },
  { condition: 'Tinnitus', ratingPct: 10, status: 'service_connected' },
  { condition: 'Right knee strain', ratingPct: null, status: 'pending' },
];

// ---------------------------------------------------------------------------
// §2.4 golden cases (each output is also schema-validated)
// ---------------------------------------------------------------------------
describe('deriveCaseFraming — §2.4 precedence ladder golden cases', () => {
  it('rn_set: RN framingChoice="aggravation" is authoritative; mirrored in framingChoice', () => {
    const out = deriveCaseFraming(
      caseInput({ framingChoice: 'aggravation', upstreamScCondition: 'Anxiety' }),
      HATFIELD_SC, NOW,
    );
    expect(out.framing).toBe('aggravation');
    expect(out.source).toBe('rn_set');
    expect(out.framingChoice).toBe('aggravation');
    expect(out.upstreamScCondition).toBe('Anxiety');
    expectSchemaValid(out);
  });

  it('rn_set: free-text RN value normalizes for the mirror ("Secondary to PTSD" → secondary)', () => {
    const out = deriveCaseFraming(
      caseInput({ framingChoice: 'Secondary to PTSD', upstreamScCondition: 'Anxiety' }),
      HATFIELD_SC, NOW,
    );
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('rn_set');
    expect(out.framingChoice).toBe('secondary'); // schema enum forbids the verbatim free-text
    expectSchemaValid(out);
  });

  it('rn_set garbage framingChoice falls through the ladder (mirror null)', () => {
    const out = deriveCaseFraming(
      caseInput({ framingChoice: 'tbd — review with physician' }),
      HATFIELD_SC, NOW,
    );
    expect(out.source).not.toBe('rn_set'); // unrecognizable RN value is not authoritative
    expect(out.framingChoice).toBeNull();
    expectSchemaValid(out);
  });

  it('derived (Hatfield): supplemental + granted Anxiety 70% + claimed OSA → secondary/derived with the anchor recovered', () => {
    const out = deriveCaseFraming(caseInput(), HATFIELD_SC, NOW);
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('derived');
    // bestGrantedScPair ranks by Board stats — with Anxiety AND Tinnitus granted, both resolve
    // high-tier pairs to OSA and the engine's pick is atlas-data-dependent (Tinnitus→OSA currently
    // outscores on IMO win%). The producer is deliberately engine-faithful: assert the rung fired
    // and recovered a granted-derived atlas upstream, NOT a pinned ranking (the planned BVA atlas
    // rebuild may flip it; mechanism-vs-stats ranking is framingGate's downstream literature call).
    expect(['Anxiety / GAD', 'Tinnitus']).toContain(out.upstreamScCondition);
    expect(out.grantedScAnchors.map((a) => a.condition)).toEqual(['Anxiety', 'Tinnitus']);
    expect(out.grantedScAnchors.map((a) => a.condition)).not.toContain('Obstructive Sleep Apnea');
    expect(out.claimType).toBe('supplemental');
    expectSchemaValid(out);
  });

  it('derived: single granted anchor recovers deterministically (Anxiety → Anxiety / GAD)', () => {
    const out = deriveCaseFraming(
      caseInput(),
      [{ condition: 'Anxiety', ratingPct: 70, status: 'service_connected' }],
      NOW,
    );
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('derived');
    expect(out.upstreamScCondition).toBe('Anxiety / GAD'); // atlas-normalized authoritative upstream
    expectSchemaValid(out);
  });

  it('derived: a SCOREABLE stored upstream is kept verbatim (never clobbered by the authoritative scan)', () => {
    const out = deriveCaseFraming(
      caseInput({ upstreamScCondition: 'PTSD' }), // PTSD→OSA resolves in the atlas
      HATFIELD_SC, NOW,
    );
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('derived');
    expect(out.upstreamScCondition).toBe('PTSD');
    expectSchemaValid(out);
  });

  it('text_parse_fallback: no anchors, veteran wrote "secondary to my PTSD"', () => {
    const out = deriveCaseFraming(
      caseInput({
        claimedCondition: 'Chronic migraines',
        claimType: 'initial',
        veteranStatement: 'I believe my migraines are secondary to my PTSD from deployment.',
      }),
      [], NOW,
    );
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('text_parse_fallback');
    expect(out.upstreamScCondition).toBe('ptsd'); // parseSecondaryFraming normalizes TO the keyword
    expectSchemaValid(out);
  });

  it('text_parse_fallback: aggravation wording yields aggravation', () => {
    const out = deriveCaseFraming(
      caseInput({
        claimedCondition: 'Chronic migraines',
        claimType: 'initial',
        veteranStatement: 'My migraines were aggravated by my tinnitus over the years.',
      }),
      [], NOW,
    );
    expect(out.framing).toBe('aggravation');
    expect(out.source).toBe('text_parse_fallback');
    expectSchemaValid(out);
  });

  it('garbage stored anchor clears to direct/default_direct (the Stocks class)', () => {
    const out = deriveCaseFraming(
      caseInput({
        claimedCondition: 'Chronic migraines',
        claimType: 'initial',
        upstreamScCondition: 'service I wake up with headaches',
      }),
      [], NOW,
    );
    expect(out.framing).toBe('direct');
    expect(out.source).toBe('default_direct');
    expect(out.upstreamScCondition).toBeNull();
    expectSchemaValid(out);
  });

  it('default_direct: nothing recognizable anywhere', () => {
    const out = deriveCaseFraming(
      caseInput({ claimedCondition: 'Chronic migraines', claimType: 'initial' }),
      [], NOW,
    );
    expect(out.framing).toBe('direct');
    expect(out.source).toBe('default_direct');
    expect(out.upstreamScCondition).toBeNull();
    expect(out.grantedScAnchors).toEqual([]);
    expectSchemaValid(out);
  });

  it('undetermined: RN says secondary but zero anchors, no pair, no usable upstream — emit undetermined, never guess', () => {
    const out = deriveCaseFraming(
      caseInput({
        claimedCondition: 'Chronic migraines',
        claimType: 'initial',
        framingChoice: 'secondary',
        upstreamScCondition: null,
      }),
      [], NOW,
    );
    expect(out.framing).toBe('undetermined');
    expect(out.source).toBe('rn_set');
    expect(out.framingChoice).toBe('secondary'); // the RN's setting still mirrors
    expectSchemaValid(out);
  });

  it('NOT undetermined: pending-primary (recognized upstream, zero granted anchors) stays secondary', () => {
    const out = deriveCaseFraming(
      caseInput({
        claimedCondition: 'Chronic migraines',
        claimType: 'initial',
        framingChoice: 'secondary',
        upstreamScCondition: 'PTSD', // recognized + claimed-pair scoreable, just not granted yet
      }),
      [], NOW,
    );
    expect(out.framing).toBe('secondary');
    expect(out.source).toBe('rn_set');
    expect(out.grantedScAnchors).toEqual([]);
    expectSchemaValid(out);
  });

  it('NOT undetermined: RN aggravation with zero anchors stays aggravation (3.306-style is framingGate\'s downstream call)', () => {
    const out = deriveCaseFraming(
      caseInput({ claimedCondition: 'Chronic migraines', claimType: 'initial', framingChoice: 'aggravation' }),
      [], NOW,
    );
    expect(out.framing).toBe('aggravation');
    expect(out.source).toBe('rn_set');
    expectSchemaValid(out);
  });

  it('derivedAt is deterministic ISO-8601 UTC from the injected clock', () => {
    const out = deriveCaseFraming(caseInput(), HATFIELD_SC, NOW);
    expect(out.derivedAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('all four claimType values pass through and validate', () => {
    for (const ct of ['initial', 'supplemental', 'hlr', 'appeal_bva'] as const) {
      const out = deriveCaseFraming(caseInput({ claimType: ct }), HATFIELD_SC, NOW);
      expect(out.claimType).toBe(ct);
      expectSchemaValid(out);
    }
  });
});

// ---------------------------------------------------------------------------
// §2.6 anchor hygiene (D7)
// ---------------------------------------------------------------------------
describe('buildGrantedScAnchors — §2.6 invariants', () => {
  it('strict status filter: pending/denied/claimed/deferred excluded; only service_connected survives', () => {
    const out = buildGrantedScAnchors(
      [
        { condition: 'Anxiety', ratingPct: 70, status: 'service_connected' },
        { condition: 'Right knee strain', ratingPct: 10, status: 'pending' },
        { condition: 'GERD', ratingPct: 10, status: 'denied' },
        { condition: 'Hearing loss', ratingPct: 0, status: 'Service_Connected' }, // case-insensitive
      ],
      'Obstructive Sleep Apnea',
    );
    expect(out.map((a) => a.condition)).toEqual(['Anxiety', 'Hearing loss']);
    expect(out.every((a) => a.status === 'service_connected')).toBe(true);
  });

  it('dedupe by normalized condition keeps the higher ratingPct (null sorts lowest)', () => {
    const out = buildGrantedScAnchors(
      [
        { condition: 'Anxiety Disorder', ratingPct: 30, status: 'service_connected' },
        { condition: 'anxiety  disorder', ratingPct: 70, status: 'service_connected' },
        { condition: 'Tinnitus', ratingPct: null, status: 'service_connected' },
        { condition: 'TINNITUS', ratingPct: 10, status: 'service_connected' },
      ],
      'Obstructive Sleep Apnea',
    );
    expect(out).toEqual([
      { condition: 'anxiety  disorder', ratingPct: 70, status: 'service_connected' },
      { condition: 'TINNITUS', ratingPct: 10, status: 'service_connected' },
    ]);
  });

  it('self-anchor exclusion: the claimed condition never anchors itself', () => {
    const out = buildGrantedScAnchors(
      [
        { condition: 'Lumbar DDD', ratingPct: 20, status: 'service_connected' },
        { condition: 'lumbar  ddd', ratingPct: 40, status: 'service_connected' },
        { condition: 'Anxiety', ratingPct: 70, status: 'service_connected' },
      ],
      'Lumbar DDD',
    );
    expect(out.map((a) => a.condition)).toEqual(['Anxiety']);
  });

  it('ordering: descending ratingPct, then condition asc; real 0 before null; null last', () => {
    const out = buildGrantedScAnchors(
      [
        { condition: 'Zeta', ratingPct: null, status: 'service_connected' },
        { condition: 'Beta', ratingPct: 0, status: 'service_connected' },
        { condition: 'Alpha', ratingPct: 20, status: 'service_connected' },
        { condition: 'Delta', ratingPct: 70, status: 'service_connected' },
        { condition: 'Apple', ratingPct: 20, status: 'service_connected' },
      ],
      'Obstructive Sleep Apnea',
    );
    expect(out.map((a) => [a.condition, a.ratingPct])).toEqual([
      ['Delta', 70], ['Alpha', 20], ['Apple', 20], ['Beta', 0], ['Zeta', null],
    ]);
  });

  it('empty-string conditions are dropped (schema minLength 1)', () => {
    const out = buildGrantedScAnchors(
      [{ condition: '   ', ratingPct: 50, status: 'service_connected' }],
      'Obstructive Sleep Apnea',
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeFramingChoice
// ---------------------------------------------------------------------------
describe('normalizeFramingChoice', () => {
  it.each([
    ['aggravation', 'aggravation'],
    ['Aggravated by SC condition', 'aggravation'],
    ['secondary', 'secondary'],
    ['Secondary to PTSD', 'secondary'],
    ['causation', 'secondary'],
    ['direct', 'direct'],
    ['Direct service connection', 'direct'],
  ] as const)('"%s" → %s', (input, expected) => {
    expect(normalizeFramingChoice(input)).toBe(expected);
  });

  it.each([[null], ['tbd'], ['presumptive'], ['']])('%s → null', (input) => {
    expect(normalizeFramingChoice(input as string | null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backfill-endpoint parity (the refactor in internal-worker.ts must be behavior-preserving).
// Expected values encode the PRE-refactor logic read directly from internal-worker.ts:753-773.
// ---------------------------------------------------------------------------
describe('deriveFramingFromEvidence — internal-worker parity', () => {
  it('storedScoreable: stored anchor kept, no rewrite (internal-worker :757 writes nothing)', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Obstructive Sleep Apnea',
      upstreamScCondition: 'PTSD',
      grantedScConditionNames: ['Anxiety'],
      aggravationWording: false,
    });
    expect(r).toEqual({ framing: 'secondary', upstreamScCondition: 'PTSD', source: 'derived' });
  });

  it('authoritative: unscoreable stored anchor replaced by best granted Board pair (:759-766)', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Obstructive Sleep Apnea',
      upstreamScCondition: null,
      grantedScConditionNames: ['Anxiety', 'Tinnitus'],
      aggravationWording: false,
    });
    expect(r.source).toBe('derived');
    // engine-faithful: the Board-stat ranking between two valid granted pairs is atlas-data-dependent
    expect(['Anxiety / GAD', 'Tinnitus']).toContain(r.upstreamScCondition);
    expect(r.framing).toBe('secondary');
  });

  it('authoritative + aggravation wording → aggravation (:763,766 — wording-driven, never pair-driven)', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Obstructive Sleep Apnea',
      upstreamScCondition: null,
      grantedScConditionNames: ['Anxiety'],
      aggravationWording: true,
    });
    expect(r.framing).toBe('aggravation');
    expect(r.source).toBe('derived');
  });

  it('text-parse hint takes the :767-769 slot when no authoritative pair', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Chronic migraines',
      upstreamScCondition: null,
      grantedScConditionNames: [],
      aggravationWording: false,
      textParseHint: { upstream: 'ptsd', framing: 'secondary' },
    });
    expect(r).toEqual({ framing: 'secondary', upstreamScCondition: 'ptsd', source: 'text_parse_fallback' });
  });

  it('garbage stored anchor cleared (:770-772)', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Chronic migraines',
      upstreamScCondition: 'service I wake up with headaches',
      grantedScConditionNames: [],
      aggravationWording: false,
    });
    expect(r).toEqual({ framing: 'direct', upstreamScCondition: null, source: 'default_direct' });
  });

  it('nothing fires: direct with stored (recognized but unscoreable) upstream passed through', () => {
    const r = deriveFramingFromEvidence({
      claimedCondition: 'Chronic migraines',
      upstreamScCondition: null,
      grantedScConditionNames: [],
      aggravationWording: false,
    });
    expect(r).toEqual({ framing: 'direct', upstreamScCondition: null, source: 'default_direct' });
  });
});
