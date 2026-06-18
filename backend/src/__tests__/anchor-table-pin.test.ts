// CI hash pin for the vendored anchor-mechanism table + caseViability schema (build plan §2).
// RED BUILD ON DRIFT — this is the intended alarm. The SECONDARY pin lives at FOUR literal sites
// that must all move in the SAME commit when the secondary table is re-curated (build plan R4):
//   1. scripts/vendor-anchor-table.mjs            → PINNED_TABLE_HASH
//   2. backend/src/config/caseViability.v1.schema.json → properties.table_content_hash.const
//   3. THIS FILE                                  → PINNED_TABLE_HASH + PINNED_SCHEMA_SHA256
//   4. backend/src/__tests__/case-viability.test.ts → PINNED_TABLE_HASH
// The DIRECT-SC pin (PINNED_DIRECT_TABLE_HASH) is a SECOND independent pin — it rotates only on a
// sc_direct_pairs.json re-curation, and lives at: vendor-anchor-table.mjs (PINNED_DIRECT_TABLE_HASH),
// caseViability.v2.schema.json (tables.direct.const), and THIS FILE.
// The Ask-Aegis + website windows pin the SAME hashes (coordinate via shared/outbox).
// NEVER hand-edit backend/src/vendor/* — scripts/vendor-anchor-table.mjs is the only writer.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Rotated 2026-06-14 (DIRECT-SC re-vendor at FRN HEAD): the canonical anchor_mechanism_pairs.json was
// re-curated (1032 rows) and the resolver gained the DIRECT-SC fold + setDirectAxisEnabled. Bands are
// byte-identical with the direct axis OFF (the default); only the secondary table hash rotated
// 1f095fb6… → c0f6ba36….
const PINNED_TABLE_HASH = '7c072e3b9cafa893c048a0c76287a056c0f6676bb1ad3e120984e46143a2bbf1';
// DIRECT-SC table content_hash (sc_direct_pairs.json `content_hash` field; directSc.tableContentHash()
// returns it verbatim). Independent pin — rotates only on a direct-table re-curation.
const PINNED_DIRECT_TABLE_HASH = 'fc828fe33ed370beecaa00875117b62acd1bc2ae07ac304579bbf4db072b2bd9';
// PACT presumptive-map content_hash (pact_presumptive_conditions.json field; pactPresumptive
// .tableContentHash() returns it verbatim). Bridge-anchor pathway (2026-06-16, FRN 859d2eb). THIRD
// independent pin — rotates only on a PACT-map re-curation; lives at: vendor-anchor-table.mjs
// (PINNED_PACT_MAP_HASH) + THIS FILE. (Not a schema const — it rides each bridge_pathway's provenance.)
const PINNED_PACT_MAP_HASH = '2098c133b6767038e0e66b905fe942a5adaff667506e3254dd6994a44e9758cf';
// v1 schema byte-pin. Rotated 2026-06-14: (1) the EMR-authored v1 schema's table_content_hash.const
// moved to the new secondary pin; (2) `E` was removed from best_anchor.required (it stays an OPTIONAL
// property) because the re-vendored resolver no longer emits the always-null E field. The file is NOT
// overwritten from FRN — it keeps its EMR-authored shape; only these two edits changed its bytes.
const PINNED_SCHEMA_SHA256 = '4f409bb5136a9ea9c72ee0115bc47d9aa671d174eaf8586514934fc6e1c602cc';
// RESOLVER CODE byte-pins (2026-06-18). The table sha-pin does NOT catch a LOGIC-only re-vendor — that
// is exactly how the EMR vendor silently lagged FRN at 947d51e (fix #1) while the drafter shipped fixes
// #2/#3/#4 (over-call guard + data-contract hardening). These pin the vendored RESOLVER bytes so any
// re-vendor (or a forbidden hand-edit) of anchorMechanism.cjs / conditionCanon.cjs trips the red build
// and forces a same-commit pin rotation. Rotated to the FRN 3d09819 re-vendor (over-call guard live).
const PINNED_RESOLVER_SHA256 = '924a47831816da0ed6ca236f4ab26fedeca6afe1fa3cbe94420025f518016a80';
const PINNED_CONDITIONCANON_SHA256 = 'bdf068fa00f84875947626ef7889297aa4ca581f47d4d04217f813127e43eab8';

const vendorDir = path.dirname(fileURLToPath(new URL('../vendor/anchor_mechanism_pairs.json', import.meta.url)));
const tableUrl = new URL('../vendor/anchor_mechanism_pairs.json', import.meta.url);
const directTableUrl = new URL('../vendor/sc_direct_pairs.json', import.meta.url);
const schemaUrl = new URL('../config/caseViability.v1.schema.json', import.meta.url);
const v2SchemaUrl = new URL('../config/caseViability.v2.schema.json', import.meta.url);
const v21SchemaUrl = new URL('../config/caseViability.v2.1.schema.json', import.meta.url);
const pactTableUrl = new URL('../vendor/pact_presumptive_conditions.json', import.meta.url);

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

  it('5. DIRECT table field pin: vendored sc_direct_pairs.json.content_hash === direct pin', () => {
    const directTable = JSON.parse(readFileSync(directTableUrl).toString('utf8')) as {
      content_hash: string;
      rows: readonly unknown[];
    };
    expect(directTable.content_hash).toBe(PINNED_DIRECT_TABLE_HASH);
    expect(directTable.rows.length).toBeGreaterThanOrEqual(8); // mirrors directSc.MIN_ROWS stub guard
  });

  it('5b. DIRECT resolver smoke: the vendored directSc loads the VENDORED direct table (tableContentHash === direct pin)', () => {
    const req = createRequire(import.meta.url);
    const ds = req('../vendor/directSc.cjs') as { tableContentHash(): string | null };
    expect(ds.tableContentHash()).toBe(PINNED_DIRECT_TABLE_HASH);
  });

  it('6. v2 schema two-table provenance: the nested const hashes match the secondary + direct pins (second drift tripwire)', () => {
    const v2 = JSON.parse(readFileSync(v2SchemaUrl).toString('utf8')) as {
      properties: {
        tables: {
          properties: {
            secondary: { properties: { content_hash: { const: string } } };
            direct: { properties: { content_hash: { const: string } } };
          };
        };
        table_content_hash: { const: string };
      };
    };
    expect(v2.properties.tables.properties.secondary.properties.content_hash.const).toBe(PINNED_TABLE_HASH);
    expect(v2.properties.tables.properties.direct.properties.content_hash.const).toBe(PINNED_DIRECT_TABLE_HASH);
    // The deprecated flat mirror still equals the secondary hash (graceful v1-reader degrade).
    expect(v2.properties.table_content_hash.const).toBe(PINNED_TABLE_HASH);
  });

  it('6b. axis-fold smoke: with the direct axis ON (setter), the vendored resolver emits v2 + both table hashes', () => {
    const req = createRequire(import.meta.url);
    const am = req('../vendor/anchorMechanism.cjs') as {
      setDirectAxisEnabled(on: boolean | null): void;
      assessClaimViability(
        claimed: string,
        granted: readonly string[],
        chartFacts?: unknown,
      ): { version: number; axis?: string; tables?: { secondary: { content_hash: string }; direct: { content_hash: string } } };
    };
    am.setDirectAxisEnabled(true);
    try {
      const out = am.assessClaimViability('Obstructive sleep apnea', ['PTSD'], {
        in_service_events: [{ event_canonical: 'criterion_a_trauma', evidence_span: 'IED blast' }],
      });
      expect(out.version).toBe(2);
      expect(out.tables?.secondary.content_hash).toBe(PINNED_TABLE_HASH);
      expect(out.tables?.direct.content_hash).toBe(PINNED_DIRECT_TABLE_HASH);
    } finally {
      am.setDirectAxisEnabled(null); // restore default so axis-OFF tests below/elsewhere are unaffected
    }
  });

  it('7. PACT map field pin: vendored pact_presumptive_conditions.json.content_hash === PACT pin', () => {
    const pact = JSON.parse(readFileSync(pactTableUrl).toString('utf8')) as { content_hash: string; rows: readonly unknown[] };
    expect(pact.content_hash).toBe(PINNED_PACT_MAP_HASH);
    expect(pact.rows.length).toBeGreaterThanOrEqual(4); // mirrors pactPresumptive.MIN_ROWS stub guard
  });

  it('7b. PACT resolver smoke: the vendored pactPresumptive loads the VENDORED map (tableContentHash === PACT pin)', () => {
    const req = createRequire(import.meta.url);
    const pp = req('../vendor/pactPresumptive.cjs') as { tableContentHash(): string | null };
    expect(pp.tableContentHash()).toBe(PINNED_PACT_MAP_HASH);
  });

  it('8. v2.1 schema: tables consts mirror the secondary + direct pins AND it carries the optional bridge_pathways key', () => {
    const v21 = JSON.parse(readFileSync(v21SchemaUrl).toString('utf8')) as {
      properties: {
        tables: { properties: { secondary: { properties: { content_hash: { const: string } } }; direct: { properties: { content_hash: { const: string } } } } };
        bridge_pathways?: unknown;
      };
    };
    expect(v21.properties.tables.properties.secondary.properties.content_hash.const).toBe(PINNED_TABLE_HASH);
    expect(v21.properties.tables.properties.direct.properties.content_hash.const).toBe(PINNED_DIRECT_TABLE_HASH);
    expect(v21.properties.bridge_pathways).toBeDefined();
  });

  it('9. BRIDGE-ANCHOR smoke: flag OFF → no bridge (byte-identity); flag ON → a Pichette-class bridge with the pinned provenance', () => {
    const req = createRequire(import.meta.url);
    const am = req('../vendor/anchorMechanism.cjs') as {
      setDirectAxisEnabled(on: boolean | null): void;
      setBridgeEnabled(on: boolean | null): void;
      assessClaimViability(claimed: string, granted: readonly string[], chartFacts?: unknown): {
        viability: string; bridge_pathways?: Array<{ intermediate_dx: string; claimed: string; physician_review_required: boolean; bridge_provisional: boolean; provenance: { pact_map_hash: string } }>;
      };
    };
    const chart = {
      in_service_events: [{ event_canonical: 'burn_pit_airborne', evidence_span: 'burn pits Kuwait 1995' }],
      dx_constellation: ['Chronic rhinosinusitis'],
    };
    am.setDirectAxisEnabled(true);
    try {
      am.setBridgeEnabled(null); // OFF (no env in test) → bridge must not fire
      const off = am.assessClaimViability('Obstructive sleep apnea', ['Tinnitus'], chart);
      expect(off.bridge_pathways).toBeUndefined();

      am.setBridgeEnabled(true); // ON
      const on = am.assessClaimViability('Obstructive sleep apnea', ['Tinnitus'], chart);
      expect(on.viability).toBe('weak'); // bridge is additive — never upgrades the claimed band
      expect(on.bridge_pathways?.length).toBe(1);
      expect(on.bridge_pathways?.[0]?.intermediate_dx).toBe('Chronic rhinosinusitis');
      expect(on.bridge_pathways?.[0]?.physician_review_required).toBe(true);
      expect(on.bridge_pathways?.[0]?.bridge_provisional).toBe(true);
      expect(on.bridge_pathways?.[0]?.provenance.pact_map_hash).toBe(PINNED_PACT_MAP_HASH);
    } finally {
      am.setBridgeEnabled(null);
      am.setDirectAxisEnabled(null);
    }
  });

  it('10. RESOLVER code byte-pin: vendored anchorMechanism.cjs + conditionCanon.cjs sha256 === pins (catches a LOGIC-only re-vendor the table pin misses)', () => {
    const amHash = createHash('sha256').update(readFileSync(new URL('../vendor/anchorMechanism.cjs', import.meta.url))).digest('hex');
    const ccHash = createHash('sha256').update(readFileSync(new URL('../vendor/conditionCanon.cjs', import.meta.url))).digest('hex');
    expect(amHash).toBe(PINNED_RESOLVER_SHA256);
    expect(ccHash).toBe(PINNED_CONDITIONCANON_SHA256);
  });

  it('11. over-call guard live: an UNREVIEWED psych→neuro pair pleads aggravation (3.310b), never "cause"; a reviewed classic secondary proceeds (3.310a)', () => {
    const req = createRequire(import.meta.url);
    const am = req('../vendor/anchorMechanism.cjs') as {
      assessClaimViability(claimed: string, granted: readonly string[], chartFacts?: unknown): {
        best_anchor?: { physician_reviewed?: boolean; basis?: string };
      };
    };
    // chart-refined (dx present) so the over-call scenario is exercised, not info-light abstain.
    const ms = am.assessClaimViability('Multiple sclerosis', ['PTSD'], { in_service_events: [], dx_constellation: ['Multiple sclerosis'] });
    expect(ms.best_anchor?.physician_reviewed).toBe(false);
    expect(ms.best_anchor?.basis).toBe('3.310b'); // aggravation, NOT a "recognized cause"
    const dn = am.assessClaimViability('Peripheral neuropathy', ['Diabetes mellitus type 2'], { in_service_events: [], dx_constellation: ['Peripheral neuropathy'] });
    expect(dn.best_anchor?.physician_reviewed).toBe(true);
    expect(dn.best_anchor?.basis).toBe('3.310a'); // classic reviewed secondary proceeds as causation
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
