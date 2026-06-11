// SSOT caseViability PRODUCER tests (build plan §3.6 + the §5 golden/correctness table).
// Locks: (1) every golden output validates against the vendored caseViability.v1.schema.json
// (walked with the same minimal validator case-framing.test.ts uses — no ajv in either repo, G11);
// (2) the §5 band table verified live against the canonical resolver during planning; (3) the
// Hatfield golden (the false-halt class cannot recur); (4) determinism; (5) fail-open shapes.
// PINNED_TABLE_HASH is pin-literal site 4 of 4 (see scripts/vendor-anchor-table.mjs header).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deriveCaseViability, type CaseViability } from '../services/case-viability.js';

const PINNED_TABLE_HASH = '7d7d355f631d2a60192205d993406161437564a3f9033f39a30c82f11e4869b2';

const schemaUrl = new URL('../config/caseViability.v1.schema.json', import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const schema = JSON.parse(schemaBytes.toString('utf8'));

describe('vendored schema + table pins (cross-refs anchor-table-pin.test.ts)', () => {
  it('schema const pins the table content hash', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(schema.properties.table_content_hash.const).toBe(PINNED_TABLE_HASH);
  });
  it('schema bytes are non-empty and parse (byte-pin lives in anchor-table-pin.test.ts)', () => {
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Minimal schema walker — copied from case-framing.test.ts (G11: same semantics as the
// drafter-side contract test; no ajv in either repo).
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

function expectSchemaValid(obj: CaseViability): void {
  // Validate the WIRE shape (JSON round-trip): the engine emits optional flags as
  // `x === true ? true : undefined`, and JSON.stringify DROPS undefined-valued keys — the schema
  // contract is over serialized JSON, not the in-memory object (P1a re-vendor 2026-06-11; the same
  // applies to the drafter-side contract test when it adopts the aggravation_only schema).
  expect(validate(schema, JSON.parse(JSON.stringify(obj)), '$', [])).toEqual([]);
}

const anchors = (...names: string[]): Array<{ condition: string }> => names.map((condition) => ({ condition }));

// ---------------------------------------------------------------------------
// §5 golden / correctness table — every band below was VERIFIED by running the live canonical
// resolver during planning AND re-verified against the vendored copy at build time (cross-repo
// determinism §5.2: same inputs ⇒ same band in all three lanes; the table-hash pin proves the
// copies agree).
// ---------------------------------------------------------------------------
describe('deriveCaseViability — §5 golden bands (schema-validated)', () => {
  it('Strong: OSA + [PTSD] → strong, best=PTSD M4 blessed, confidence high (info-light strong only for blessed M4)', () => {
    const out = deriveCaseViability('Obstructive sleep apnea', anchors('PTSD'));
    expect(out.viability).toBe('strong');
    expect(out.best_anchor?.upstream_canonical).toBe('PTSD');
    expect(out.best_anchor?.M_static).toBe(4);
    expect(out.best_anchor?.M_eff).toBe(4);
    expect(out.best_anchor?.tier).toBe('blessed');
    expect(out.best_anchor?.basis).toBe('3.310a'); // NO parens (G4)
    expect(out.best_anchor?.E).toBeNull(); // null = not-yet-scored, never 0
    expect(out.confidence).toBe('high');
    expect(out.mode).toBe('info_light');
    expect(out.table_content_hash).toBe(PINNED_TABLE_HASH);
    expectSchemaValid(out);
  });

  it('Weak/trap: OSA + [Tinnitus] → weak, best_anchor null, Tinnitus in excluded_traps (excluded never ranks; honest no-anchor)', () => {
    const out = deriveCaseViability('Obstructive sleep apnea', anchors('Tinnitus'));
    expect(out.viability).toBe('weak');
    expect(out.best_anchor).toBeNull();
    expect(out.excluded_traps.map((t) => t.upstream_canonical)).toContain('Tinnitus');
    const tinnitus = out.excluded_traps.find((t) => t.upstream_canonical === 'Tinnitus');
    expect(tinnitus?.reason).toMatch(/No physiologic pathway/i);
    expectSchemaValid(out);
  });

  it('Conditional: Lumbar/back + [Knee] → conditional, missing_fact = the gait string, M_eff 3 (§C1 contingency, info-light)', () => {
    const out = deriveCaseViability('Lumbar / back', anchors('Knee'));
    expect(out.viability).toBe('conditional');
    expect(out.best_anchor?.upstream_canonical).toBe('Knee');
    expect(out.best_anchor?.M_eff).toBe(3);
    expect(out.best_anchor?.tier).toBe('conditional');
    expect(out.missing_fact).toMatch(/gait/i);
    expectSchemaValid(out);
  });

  it('Hatfield (REQUIRED): OSA + [Anxiety, MDD, Tinnitus, HTN] → moderate, best=Anxiety / GAD, confidence high — the false-halt class cannot recur', () => {
    const out = deriveCaseViability(
      'Obstructive sleep apnea',
      anchors('Anxiety', 'Major depressive disorder', 'Tinnitus', 'Hypertension'),
    );
    expect(['moderate', 'strong']).toContain(out.viability);
    expect(out.viability).toBe('moderate'); // verified live
    expect(out.best_anchor).not.toBeNull();
    expect(out.best_anchor?.upstream_canonical).toBe('Anxiety / GAD');
    expect(out.best_anchor?.upstream_verbatim).toBe('Anxiety');
    // 4.130 psych collapse fired (Anxiety + MDD co-class) → mechanism_member present (G6).
    expect(out.best_anchor?.mechanism_member).toBe('Anxiety / GAD');
    expect(out.confidence).toBe('high');
    expect(out.why).not.toMatch(/no service-connected condition/i);
    expectSchemaValid(out);
  });

  it('Presumptive advisory: IBS + [PTSD] (info-light) → conditional, presumptive_redirect.advisory=true, path GW_3317 (§3.0 advisory in info-light)', () => {
    const out = deriveCaseViability('IBS', anchors('PTSD'));
    expect(out.viability).toBe('conditional');
    expect(out.presumptive_redirect).not.toBeNull();
    expect(out.presumptive_redirect?.advisory).toBe(true);
    expect(out.presumptive_redirect?.path).toBe('GW_3317');
    expect(out.presumptive_redirect?.note).toMatch(/3\.317/);
    expectSchemaValid(out);
  });

  it('Empty granted: OSA + [] → weak, best_anchor null, no throw (fail-open, no anchor honest)', () => {
    const out = deriveCaseViability('Obstructive sleep apnea', []);
    expect(out.viability).toBe('weak');
    expect(out.best_anchor).toBeNull();
    expectSchemaValid(out);
  });

  it('Umbrella: "sleep-wake disorder" + [PTSD] → abstain, missing_fact = "a specific diagnosis…" (§3.5 phenotype split)', () => {
    const out = deriveCaseViability('sleep-wake disorder', anchors('PTSD'));
    expect(out.viability).toBe('abstain');
    expect(out.missing_fact).toMatch(/a specific diagnosis/i);
    expect(out.claimed_canonical).toBeNull();
    expectSchemaValid(out);
  });

  // GOLDEN FLIP (P1a re-vendor at FRN HEAD ≥73095d9, 2026-06-11): Hypertension|PTSD was REMOVED
  // from the engine graveyard (_GRAVEYARD is now empty) and re-characterized as AGGRAVATION-ONLY
  // via _AGGRAVATION_ONLY (FRN commits 5d04b62 / 0ebb73e / 8c141ec, Ryan ratified). The old
  // expectation (abstain + graveyard_redirect.redirect_blocked) encoded the pre-rewrite behavior;
  // the band now lands conditional on a 3.310(b) aggravation argument with causation denied.
  it('Aggravation-only (was graveyard): Hypertension + [PTSD] → conditional, basis 3.310b, aggravation_only, NO graveyard redirect', () => {
    const out = deriveCaseViability('Hypertension', anchors('PTSD'));
    expect(out.viability).toBe('conditional');
    expect(out.graveyard_redirect).toBeNull();
    expect(out.best_anchor).not.toBeNull();
    expect(out.best_anchor?.upstream_canonical).toBe('PTSD');
    expect(out.best_anchor?.basis).toBe('3.310b');
    expect(out.best_anchor?.aggravation_only).toBe(true);
    expect(out.best_anchor?.causation_denied).toBe(true);
    expect(out.why).toMatch(/aggravat/i);
    expect(out.why).toMatch(/3\.310/);
    expectSchemaValid(out);
  });

  it('Aggravation-only golden #2: Asthma + [PTSD] → conditional + aggravation_only (locks the second re-characterization — a table edit cannot silently drop it)', () => {
    const out = deriveCaseViability('Asthma', anchors('PTSD'));
    expect(out.viability).toBe('conditional');
    expect(out.best_anchor?.upstream_canonical).toBe('PTSD');
    expect(out.best_anchor?.basis).toBe('3.310b');
    expect(out.best_anchor?.aggravation_only).toBe(true);
    expect(out.best_anchor?.causation_denied).toBe(true);
    expect(out.why).toMatch(/aggravat/i);
    expectSchemaValid(out);
  });

  it('Determinism: same input twice → deep-equal (the pure producer emits NO derivedAt — no LLM/clock branch)', () => {
    const a = deriveCaseViability('Obstructive sleep apnea', anchors('Anxiety', 'Major depressive disorder', 'Tinnitus', 'Hypertension'));
    const b = deriveCaseViability('Obstructive sleep apnea', anchors('Anxiety', 'Major depressive disorder', 'Tinnitus', 'Hypertension'));
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty('derivedAt');
  });

  it('derivedAt is OPTIONAL in the contract: the route-stamped shape ALSO validates (G3 — website omits, EMR adds)', () => {
    const out = deriveCaseViability('Obstructive sleep apnea', anchors('PTSD'));
    expectSchemaValid({ ...out, derivedAt: '2026-06-10T00:00:00.000Z' });
  });
});
