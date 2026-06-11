// CI hash pin for the vendored anchor-mechanism table + caseViability schema (build plan §2).
// RED BUILD ON DRIFT — this is the intended alarm. The 58f9c315… pin lives at FOUR literal sites
// that must all move in the SAME commit when the table is re-curated (build plan R4):
//   1. scripts/vendor-anchor-table.mjs            → PINNED_TABLE_HASH
//   2. backend/src/config/caseViability.v1.schema.json → properties.table_content_hash.const
//   3. THIS FILE                                  → PINNED_TABLE_HASH + PINNED_SCHEMA_SHA256
//   4. backend/src/__tests__/case-viability.test.ts → PINNED_TABLE_HASH
// The Ask-Aegis + website windows pin the SAME hash (coordinate via shared/outbox).
// NEVER hand-edit backend/src/vendor/* — scripts/vendor-anchor-table.mjs is the only writer.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PINNED_TABLE_HASH = '58f9c315340214c27867995ddaf0bf0f9dcc9e08b48d8178ae111023e21b401f';
// Rotated 2026-06-11 (P1a re-vendor at FRN HEAD ≥73095d9): the schema gained the optional
// aggravation_only/causation_denied props (engine 5d04b62/0ebb73e emits them on best_anchor;
// aggravation_only on alternatives). The TABLE hash did NOT rotate (58f9c315… unchanged).
const PINNED_SCHEMA_SHA256 = '348177f2a8a4659beaf29772cd2165b7951313a4709d6e1a08e08a8cc60a47fb';

const vendorDir = path.dirname(fileURLToPath(new URL('../vendor/anchor_mechanism_pairs.json', import.meta.url)));
const tableUrl = new URL('../vendor/anchor_mechanism_pairs.json', import.meta.url);
const schemaUrl = new URL('../config/caseViability.v1.schema.json', import.meta.url);

interface VendoredTable {
  readonly version: string;
  readonly content_hash: string;
  readonly row_count: number;
  readonly rows: readonly unknown[];
  readonly preference_rank: Record<string, unknown>;
}
const table = JSON.parse(readFileSync(tableUrl).toString('utf8')) as VendoredTable;

describe('anchor table pin (red build on drift)', () => {
  it('1. field check: vendored table.content_hash === pin', () => {
    expect(table.content_hash).toBe(PINNED_TABLE_HASH);
  });

  it('row_count ≥ 500 (stub-table guard, design §6 risk-1)', () => {
    expect(table.row_count).toBeGreaterThanOrEqual(500);
    expect(table.rows.length).toBe(table.row_count);
  });

  it('2. integrity check: recomputed sha256(JSON.stringify({rows, preference_rank})) === pin (a tampered content_hash field cannot pass)', () => {
    const recomputed = createHash('sha256')
      .update(JSON.stringify({ rows: table.rows, preference_rank: table.preference_rank }))
      .digest('hex');
    expect(recomputed).toBe(PINNED_TABLE_HASH);
  });

  it('3. schema byte-pin: vendored caseViability.v1.schema.json sha256 (mirrors case-framing.test.ts)', () => {
    expect(createHash('sha256').update(readFileSync(schemaUrl)).digest('hex')).toBe(PINNED_SCHEMA_SHA256);
  });

  it("3b. schema's table_content_hash const carries the SAME pin (second drift tripwire)", () => {
    const schema = JSON.parse(readFileSync(schemaUrl).toString('utf8')) as {
      properties: { table_content_hash: { const: string } };
    };
    expect(schema.properties.table_content_hash.const).toBe(PINNED_TABLE_HASH);
  });

  it('4. resolver-reads-vendored-table smoke: the vendored resolver loads the VENDORED table, not a stray copy', () => {
    const req = createRequire(import.meta.url);
    const am = req('../vendor/anchorMechanism.cjs') as {
      assessClaimViability(claimed: string, granted: readonly string[]): { viability: string; table_content_hash: string | null };
    };
    const out = am.assessClaimViability('Obstructive sleep apnea', ['PTSD']);
    expect(out.viability).toBe('strong');
    expect(out.table_content_hash).toBe(PINNED_TABLE_HASH);
  });

  it('R5 grep-guard: no impure-module leak — vendored files never require better-sqlite3 / an LLM client', () => {
    for (const f of readdirSync(vendorDir)) {
      if (!/\.(cjs|js|mjs)$/.test(f)) continue;
      const src = readFileSync(path.join(vendorDir, f)).toString('utf8');
      // Actual require() calls only — header comments legitimately mention these names.
      expect(src).not.toMatch(/require\(['"][^'"]*(better-sqlite3|llm\/client|anthropic)[^'"]*['"]\)/);
    }
  });
});
