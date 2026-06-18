#!/usr/bin/env node
// scripts/vendor-anchor-table.mjs
//
// THE ONLY WAY to update the vendored anchor-viability resolver set in this repo — NEVER hand-edit
// anything under backend/src/vendor/. Per docs/P4_ANCHOR_VIABILITY_BUILD_PLAN.md §2.
//
// Vendor set (canonical → vendored):
//   flatratenexus-project/app/services/anchorMechanism.js      → backend/src/vendor/anchorMechanism.cjs
//   flatratenexus-project/app/services/conditionCanon.js       → backend/src/vendor/conditionCanon.cjs
//   flatratenexus-project/app/services/directSc.js             → backend/src/vendor/directSc.cjs   (DIRECT-SC axis, 2026-06-14)
//   flatratenexus-project/references/anchor_mechanism_pairs.json → backend/src/vendor/anchor_mechanism_pairs.json
//   flatratenexus-project/references/sc_direct_pairs.json        → backend/src/vendor/sc_direct_pairs.json   (DIRECT-SC table, 2026-06-14)
//   flatratenexus-project/app/config/caseViability.v1.schema.json → backend/src/config/caseViability.v1.schema.json
//   flatratenexus-project/app/config/caseViability.v2.schema.json → backend/src/config/caseViability.v2.schema.json   (two-axis, 2026-06-14)
//
// NOT vendored: framingGate.js (build plan G8 — it requires better-sqlite3 + llm/client; vendoring it
// would drag the DB + LLM client into the Lambda. Only the DRAFTER consumes framingGate, in-repo).
// NOT re-vendored here: eventCanon.cjs (vendored by the chart-extract classifier build; directSc.cjs
// requires it via the .cjs rewrite below — it stays the single eventCanon copy in the vendor dir).
//
// anchorMechanism.cjs carries EXACTLY THREE pinned, asserted rewrites (everything else byte-identical):
//   1. ARTIFACT_PATH — the vendored table sits BESIDE the resolver, not at ../../references/.
//   2. require('./conditionCanon') → require('./conditionCanon.cjs') — the EMR backend is ESM
//      ("type":"module"), so the vendored CJS files use the .cjs extension; Node's extensionless
//      require() does NOT resolve .cjs, so the intra-vendor require must name it. (This second
//      rewrite is a necessary addition to the build plan's "exactly one rewrite" — without it the
//      vendored resolver cannot load its canonicalizer at all.)
//   3. require('./directSc') → require('./directSc.cjs') — same ESM-extension reason; the DIRECT-SC
//      fold (gated, dark) lazy-requires directSc, which must resolve to the vendored .cjs.
// All pre-image lines are asserted VERBATIM before replacing — if the canonical resolver changed
// shape, this script aborts loudly ("re-author the vendor rewrite") instead of silently drifting.
//
// PIN-LITERAL SITES (build plan R4 — a table re-curation rotates the secondary pin; ALL of these
// must move in the SAME commit or the build goes red. That red is the INTENDED drift alarm):
//   1. PINNED_TABLE_HASH below (this script)  — SECONDARY table content hash
//   2. backend/src/config/caseViability.v1.schema.json → properties.table_content_hash.const
//   3. backend/src/__tests__/anchor-table-pin.test.ts  → PINNED_TABLE_HASH + PINNED_SCHEMA_SHA256 + PINNED_DIRECT_TABLE_HASH
//   4. backend/src/__tests__/case-viability.test.ts    → PINNED_TABLE_HASH
// The DIRECT table hash (PINNED_DIRECT_TABLE_HASH below) is a SECOND independent pin — it rotates
// only when sc_direct_pairs.json is re-curated, and lives in the v2 schema's tables.direct.const +
// anchor-table-pin.test.ts.
// The Ask-Aegis + website windows pin the SAME hashes — post the vendor commit SHA to
// flatratenexus-project/shared/outbox so all three lanes pull the identical copy.
//
// Usage: node scripts/vendor-anchor-table.mjs [--from <flatratenexus-project path>]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SECONDARY table content hash. Rotated 2026-06-14 from 1f095fb6… → c0f6ba36… on the P-direct
// re-vendor at FRN HEAD: the canonical anchor_mechanism_pairs.json was re-curated (1032 rows) and
// the resolver gained the DIRECT-SC fold + setDirectAxisEnabled. Bands are byte-identical with the
// direct axis OFF (the default); only the table hash rotated.
const PINNED_TABLE_HASH = '7c072e3b9cafa893c048a0c76287a056c0f6676bb1ad3e120984e46143a2bbf1';
// DIRECT-SC table content hash (sc_direct_pairs.json `content_hash` field — directSc.tableContentHash()
// returns this verbatim). Independent of the secondary pin; rotates only on a direct-table re-curation.
const PINNED_DIRECT_TABLE_HASH = 'fc828fe33ed370beecaa00875117b62acd1bc2ae07ac304579bbf4db072b2bd9';
// PACT presumptive-map content hash (pact_presumptive_conditions.json `content_hash` field —
// pactPresumptive.tableContentHash() returns it verbatim). Bridge-anchor pathway (2026-06-16, FRN
// 859d2eb). Independent of the secondary + direct pins; rotates only on a PACT-map re-curation.
const PINNED_PACT_MAP_HASH = '2098c133b6767038e0e66b905fe942a5adaff667506e3254dd6994a44e9758cf';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromIdx = process.argv.indexOf('--from');
const FROM = fromIdx !== -1 && process.argv[fromIdx + 1]
  ? path.resolve(process.argv[fromIdx + 1])
  : 'C:/Users/ryank/OneDrive/Documents/Flat Rate Nexus/flatratenexus-project';

const VENDOR_DIR = path.join(repoRoot, 'backend', 'src', 'vendor');
const CONFIG_DIR = path.join(repoRoot, 'backend', 'src', 'config');

function abort(msg) {
  console.error(`\nVENDOR ABORT: ${msg}\n`);
  process.exit(1);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

if (!existsSync(FROM)) abort(`canonical repo not found at ${FROM} (pass --from <path>)`);
mkdirSync(VENDOR_DIR, { recursive: true });

// ── 1+3. anchorMechanism.js → anchorMechanism.cjs with the TWO asserted rewrites ─────────────
const srcResolverPath = path.join(FROM, 'app', 'services', 'anchorMechanism.js');
if (!existsSync(srcResolverPath)) abort(`missing canonical ${srcResolverPath}`);
let resolverSrc = readFileSync(srcResolverPath, 'utf8');

const ARTIFACT_PRE = "const ARTIFACT_PATH = path.join(PROJECT_ROOT, 'references', 'anchor_mechanism_pairs.json');";
const ARTIFACT_POST = "const ARTIFACT_PATH = path.join(__dirname, 'anchor_mechanism_pairs.json'); // VENDORED REWRITE 1/3 (scripts/vendor-anchor-table.mjs): table sits beside the resolver";
const REQUIRE_PRE = "const conditionCanon = require('./conditionCanon');";
const REQUIRE_POST = "const conditionCanon = require('./conditionCanon.cjs'); // VENDORED REWRITE 2/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";
// The DIRECT-SC fold lazy-requires directSc inside _direct(); the .cjs extension is mandatory under
// the ESM backend. Asserted verbatim — the pre-image is the exact try/catch line in the canonical.
const DIRECT_REQUIRE_PRE = "try { _directSc = require('./directSc'); } catch (_) { _directSc = null; }";
const DIRECT_REQUIRE_POST = "try { _directSc = require('./directSc.cjs'); } catch (_) { _directSc = null; } // VENDORED REWRITE 3/4 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";
// The BRIDGE-ANCHOR branch lazy-requires pactPresumptive inside _pact(); same ESM-extension reason.
// Asserted verbatim — the pre-image is the exact try/catch line in the canonical (anchorMechanism.js:690).
const PACT_REQUIRE_PRE = "try { _pactPresumptive = require('./pactPresumptive'); } catch (_) { _pactPresumptive = null; }";
const PACT_REQUIRE_POST = "try { _pactPresumptive = require('./pactPresumptive.cjs'); } catch (_) { _pactPresumptive = null; } // VENDORED REWRITE 4/4 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";

if (!resolverSrc.includes(ARTIFACT_PRE)) {
  abort('source resolver changed shape — ARTIFACT_PATH pre-image line not found verbatim; re-author the vendor rewrite');
}
if (!resolverSrc.includes(REQUIRE_PRE)) {
  abort("source resolver changed shape — require('./conditionCanon') pre-image line not found verbatim; re-author the vendor rewrite");
}
if (!resolverSrc.includes(DIRECT_REQUIRE_PRE)) {
  abort("source resolver changed shape — require('./directSc') pre-image line not found verbatim; re-author the vendor rewrite");
}
if (!resolverSrc.includes(PACT_REQUIRE_PRE)) {
  abort("source resolver changed shape — require('./pactPresumptive') pre-image line not found verbatim; re-author the vendor rewrite");
}
resolverSrc = resolverSrc
  .replace(ARTIFACT_PRE, ARTIFACT_POST)
  .replace(REQUIRE_PRE, REQUIRE_POST)
  .replace(DIRECT_REQUIRE_PRE, DIRECT_REQUIRE_POST)
  .replace(PACT_REQUIRE_PRE, PACT_REQUIRE_POST);
// R5 guard at vendor time too: the vendored set must stay DB-free + LLM-free. Match actual
// require() calls (the resolver's header COMMENT legitimately mentions both names).
if (/require\(['"][^'"]*(better-sqlite3|llm\/client|anthropic)[^'"]*['"]\)/.test(resolverSrc)) {
  abort('vendored resolver require()s better-sqlite3 / llm client — impure module leak (R5)');
}
const destResolver = path.join(VENDOR_DIR, 'anchorMechanism.cjs');
writeFileSync(destResolver, resolverSrc);

// ── 2a. conditionCanon.js → conditionCanon.cjs (byte-identical, renamed only) ────────────────
const srcCanonPath = path.join(FROM, 'app', 'services', 'conditionCanon.js');
if (!existsSync(srcCanonPath)) abort(`missing canonical ${srcCanonPath}`);
const canonBytes = readFileSync(srcCanonPath);
if (/require\(['"]/.test(canonBytes.toString('utf8'))) {
  // G7: conditionCanon must stay ZERO-require pure (its comments may mention require()/sqlite —
  // only an actual require('…') call is a violation).
  abort('conditionCanon is no longer dependency-free (G7 violated) — re-audit before vendoring');
}
const destCanon = path.join(VENDOR_DIR, 'conditionCanon.cjs');
writeFileSync(destCanon, canonBytes);

// ── 2b. anchor_mechanism_pairs.json (byte-identical) ─────────────────────────────────────────
const srcTablePath = path.join(FROM, 'references', 'anchor_mechanism_pairs.json');
if (!existsSync(srcTablePath)) abort(`missing canonical ${srcTablePath}`);
const tableBytes = readFileSync(srcTablePath);
const destTable = path.join(VENDOR_DIR, 'anchor_mechanism_pairs.json');
writeFileSync(destTable, tableBytes);

// ── 5. recompute sha256(JSON.stringify({rows, preference_rank})) and assert the pin ──────────
const table = JSON.parse(tableBytes.toString('utf8'));
const recomputed = sha256(JSON.stringify({ rows: table.rows, preference_rank: table.preference_rank }));
if (recomputed !== PINNED_TABLE_HASH) {
  abort(`table content hash mismatch:\n  recomputed ${recomputed}\n  pinned     ${PINNED_TABLE_HASH}\nIf the table was legitimately re-curated, update ALL pin-literal sites listed in this script's header in ONE commit.`);
}
if (table.content_hash !== PINNED_TABLE_HASH) {
  abort(`table.content_hash FIELD (${table.content_hash}) !== pinned ${PINNED_TABLE_HASH}`);
}
if (typeof table.row_count !== 'number' || table.row_count < 500) {
  abort(`table.row_count ${table.row_count} < 500 — stub-table guard (§6 risk 1)`);
}

// ── 2c. directSc.js → directSc.cjs (DIRECT-SC axis) with the require-extension rewrites ───────
// Two intra-vendor requires (conditionCanon, eventCanon) must name the .cjs extension under the ESM
// backend. Both are asserted verbatim. directSc reads its table by __dirname-relative path; the
// table sits in references/ canonically but BESIDE the resolver in the vendor dir, so the TABLE_PATH
// is rewritten too (it points at ../../references/sc_direct_pairs.json canonically).
const srcDirectPath = path.join(FROM, 'app', 'services', 'directSc.js');
if (!existsSync(srcDirectPath)) abort(`missing canonical ${srcDirectPath}`);
let directSrc = readFileSync(srcDirectPath, 'utf8');
const D_CANON_PRE = "try { conditionCanon = require('./conditionCanon'); } catch (_) { conditionCanon = null; }";
const D_CANON_POST = "try { conditionCanon = require('./conditionCanon.cjs'); } catch (_) { conditionCanon = null; } // VENDORED REWRITE 1/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";
const D_EVENT_PRE = "const eventCanon = require('./eventCanon');";
const D_EVENT_POST = "const eventCanon = require('./eventCanon.cjs'); // VENDORED REWRITE 2/3 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";
const D_TABLE_PRE = "const TABLE_PATH = path.join(__dirname, '..', '..', 'references', 'sc_direct_pairs.json');";
const D_TABLE_POST = "const TABLE_PATH = path.join(__dirname, 'sc_direct_pairs.json'); // VENDORED REWRITE 3/3 (scripts/vendor-anchor-table.mjs): table sits beside the resolver";
for (const [pre, label] of [[D_CANON_PRE, "require('./conditionCanon')"], [D_EVENT_PRE, "require('./eventCanon')"], [D_TABLE_PRE, 'TABLE_PATH']]) {
  if (!directSrc.includes(pre)) abort(`directSc.js changed shape — ${label} pre-image line not found verbatim; re-author the vendor rewrite`);
}
directSrc = directSrc.replace(D_CANON_PRE, D_CANON_POST).replace(D_EVENT_PRE, D_EVENT_POST).replace(D_TABLE_PRE, D_TABLE_POST);
if (/require\(['"][^'"]*(better-sqlite3|llm\/client|anthropic)[^'"]*['"]\)/.test(directSrc)) {
  abort('vendored directSc require()s better-sqlite3 / llm client — impure module leak (R5)');
}
const destDirect = path.join(VENDOR_DIR, 'directSc.cjs');
writeFileSync(destDirect, directSrc);

// ── 2d. sc_direct_pairs.json (byte-identical) + DIRECT pin assert ─────────────────────────────
const srcDirectTablePath = path.join(FROM, 'references', 'sc_direct_pairs.json');
if (!existsSync(srcDirectTablePath)) abort(`missing canonical ${srcDirectTablePath}`);
const directTableBytes = readFileSync(srcDirectTablePath);
const destDirectTable = path.join(VENDOR_DIR, 'sc_direct_pairs.json');
writeFileSync(destDirectTable, directTableBytes);
const directTable = JSON.parse(directTableBytes.toString('utf8'));
// directSc.tableContentHash() returns the `content_hash` FIELD verbatim (it is not recomputed from
// rows by the engine), so the pin is the field. Assert it matches.
if (directTable.content_hash !== PINNED_DIRECT_TABLE_HASH) {
  abort(`sc_direct_pairs.content_hash FIELD (${directTable.content_hash}) !== pinned ${PINNED_DIRECT_TABLE_HASH}\nIf the direct table was re-curated, rotate PINNED_DIRECT_TABLE_HASH + the v2 schema tables.direct.const + anchor-table-pin.test.ts in ONE commit.`);
}
const MIN_DIRECT_ROWS = 8; // mirrors directSc.MIN_ROWS — below this the engine treats the table as a stub
if (!Array.isArray(directTable.rows) || directTable.rows.length < MIN_DIRECT_ROWS) {
  abort(`sc_direct_pairs.rows ${directTable.rows ? directTable.rows.length : 'missing'} < ${MIN_DIRECT_ROWS} — stub-table guard`);
}

// ── 2e. pactPresumptive.js → pactPresumptive.cjs (BRIDGE-ANCHOR) with require-extension rewrites ──
// Two rewrites under the ESM backend: the conditionCanon require names .cjs, and TABLE_PATH points at
// the table BESIDE the resolver in the vendor dir (canonically ../../references/). Both asserted
// verbatim. anchorMechanism._pact() lazy-requires this (the 4th anchorMechanism rewrite above resolves
// it to .cjs); without it the resolver throws the moment BRIDGE_ANCHOR_ENABLED is on. The EMR Lambda
// loads the .cjs from disk (createRequire), so the table is read fs-side beside it — the setPactMap
// inject seam is the fs-less Cloudflare-Worker (website) lane, NOT needed for the EMR runtime.
const srcPactPath = path.join(FROM, 'app', 'services', 'pactPresumptive.js');
if (!existsSync(srcPactPath)) abort(`missing canonical ${srcPactPath}`);
let pactSrc = readFileSync(srcPactPath, 'utf8');
const P_CANON_PRE = "try { conditionCanon = require('./conditionCanon'); } catch (_) { conditionCanon = null; }";
const P_CANON_POST = "try { conditionCanon = require('./conditionCanon.cjs'); } catch (_) { conditionCanon = null; } // VENDORED REWRITE 1/2 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";
const P_TABLE_PRE = "const TABLE_PATH = path.join(__dirname, '..', '..', 'references', 'pact_presumptive_conditions.json');";
const P_TABLE_POST = "const TABLE_PATH = path.join(__dirname, 'pact_presumptive_conditions.json'); // VENDORED REWRITE 2/2 (scripts/vendor-anchor-table.mjs): table sits beside the resolver";
for (const [pre, label] of [[P_CANON_PRE, "require('./conditionCanon')"], [P_TABLE_PRE, 'TABLE_PATH']]) {
  if (!pactSrc.includes(pre)) abort(`pactPresumptive.js changed shape — ${label} pre-image line not found verbatim; re-author the vendor rewrite`);
}
pactSrc = pactSrc.replace(P_CANON_PRE, P_CANON_POST).replace(P_TABLE_PRE, P_TABLE_POST);
if (/require\(['"][^'"]*(better-sqlite3|llm\/client|anthropic)[^'"]*['"]\)/.test(pactSrc)) {
  abort('vendored pactPresumptive require()s better-sqlite3 / llm client — impure module leak (R5)');
}
const destPact = path.join(VENDOR_DIR, 'pactPresumptive.cjs');
writeFileSync(destPact, pactSrc);

// ── 2f. pact_presumptive_conditions.json (byte-identical) + PACT pin assert ────────────────────
const srcPactTablePath = path.join(FROM, 'references', 'pact_presumptive_conditions.json');
if (!existsSync(srcPactTablePath)) abort(`missing canonical ${srcPactTablePath}`);
const pactTableBytes = readFileSync(srcPactTablePath);
const destPactTable = path.join(VENDOR_DIR, 'pact_presumptive_conditions.json');
writeFileSync(destPactTable, pactTableBytes);
const pactTable = JSON.parse(pactTableBytes.toString('utf8'));
// pactPresumptive.tableContentHash() returns the `content_hash` FIELD verbatim. Assert it matches.
if (pactTable.content_hash !== PINNED_PACT_MAP_HASH) {
  abort(`pact_presumptive_conditions.content_hash FIELD (${pactTable.content_hash}) !== pinned ${PINNED_PACT_MAP_HASH}\nIf the PACT map was re-curated, rotate PINNED_PACT_MAP_HASH + the v2.1 schema + anchor-table-pin.test.ts in ONE commit.`);
}
const MIN_PACT_ROWS = 4; // mirrors pactPresumptive.MIN_ROWS — below this the engine treats the map as a stub
if (!Array.isArray(pactTable.rows) || pactTable.rows.length < MIN_PACT_ROWS) {
  abort(`pact_presumptive_conditions.rows ${pactTable.rows ? pactTable.rows.length : 'missing'} < ${MIN_PACT_ROWS} — stub-map guard`);
}

// ── 4a. caseViability.v1.schema.json — EMR-AUTHORED, NOT overwritten from FRN ──────────────────
// The EMR window authored v1 independently (it carries the optional best_anchor.E field the FRN
// canonical lacks, and the v1 byte-pin d70aa6ce… is the EMR contract). DO NOT overwrite it from the
// FRN canonical — the two diverged on purpose. The v1 hash const (table_content_hash.const) is
// rotated in-place by a separate maintenance step, kept in sync with PINNED_TABLE_HASH. Vendoring
// only verifies the const matches the secondary pin (red on drift), never rewrites the file.
const destSchema = path.join(CONFIG_DIR, 'caseViability.v1.schema.json');
if (!existsSync(destSchema)) abort(`EMR-authored v1 schema missing at ${destSchema}`);
const v1Schema = JSON.parse(readFileSync(destSchema).toString('utf8'));
if (v1Schema?.properties?.table_content_hash?.const !== PINNED_TABLE_HASH) {
  abort(`v1 schema table_content_hash.const (${v1Schema?.properties?.table_content_hash?.const}) !== secondary pin ${PINNED_TABLE_HASH}\nRotate the const in backend/src/config/caseViability.v1.schema.json + the byte-pin in anchor-table-pin.test.ts in this commit.`);
}
const schemaBytes = readFileSync(destSchema);

// ── 4b. caseViability.v2.schema.json (two-axis) — vendored verbatim from FRN ───────────────────
// v2 is the EMR-side contract for the direct-axis fold. Verbatim copy; its two nested const hashes
// (tables.secondary.const + tables.direct.const) are asserted against the pins so a stale v2 can't
// ship. Unlike v1, v2 is authored canonically in FRN and copied straight across.
const srcV2Path = path.join(FROM, 'app', 'config', 'caseViability.v2.schema.json');
const destV2 = path.join(CONFIG_DIR, 'caseViability.v2.schema.json');
if (!existsSync(srcV2Path)) abort(`missing canonical ${srcV2Path}`);
const v2Bytes = readFileSync(srcV2Path);
writeFileSync(destV2, v2Bytes);
const v2Schema = JSON.parse(v2Bytes.toString('utf8'));
const v2Sec = v2Schema?.properties?.tables?.properties?.secondary?.properties?.content_hash?.const;
const v2Dir = v2Schema?.properties?.tables?.properties?.direct?.properties?.content_hash?.const;
if (v2Sec !== PINNED_TABLE_HASH) abort(`v2 schema tables.secondary.const (${v2Sec}) !== secondary pin ${PINNED_TABLE_HASH}`);
if (v2Dir !== PINNED_DIRECT_TABLE_HASH) abort(`v2 schema tables.direct.const (${v2Dir}) !== direct pin ${PINNED_DIRECT_TABLE_HASH}`);

// ── 4c. caseViability.v2.1.schema.json (v2 + optional bridge_pathways[]) — BRIDGE-ANCHOR ─────────
// v2.1 is the validation target for a bridge-bearing viability object (v2 shape + the optional
// bridge_pathways key; a plain v2 object validates against BOTH v2.0 and v2.1). `tables` are FROZEN
// (the PACT hash rides inside each pathway's provenance, not in tables), so the two nested consts
// mirror the v2 pins. Verbatim copy from FRN.
const srcV21Path = path.join(FROM, 'app', 'config', 'caseViability.v2.1.schema.json');
const destV21 = path.join(CONFIG_DIR, 'caseViability.v2.1.schema.json');
if (!existsSync(srcV21Path)) abort(`missing canonical ${srcV21Path}`);
const v21Bytes = readFileSync(srcV21Path);
writeFileSync(destV21, v21Bytes);
const v21Schema = JSON.parse(v21Bytes.toString('utf8'));
const v21Sec = v21Schema?.properties?.tables?.properties?.secondary?.properties?.content_hash?.const;
const v21Dir = v21Schema?.properties?.tables?.properties?.direct?.properties?.content_hash?.const;
if (v21Sec !== PINNED_TABLE_HASH) abort(`v2.1 schema tables.secondary.const (${v21Sec}) !== secondary pin ${PINNED_TABLE_HASH}`);
if (v21Dir !== PINNED_DIRECT_TABLE_HASH) abort(`v2.1 schema tables.direct.const (${v21Dir}) !== direct pin ${PINNED_DIRECT_TABLE_HASH}`);

console.log('vendored 10 files:');
console.log(`  ${destDirect}`);
console.log(`  ${destDirectTable}`);
console.log(`  ${destPact}`);
console.log(`  ${destPactTable}`);
console.log(`  ${destV2}`);
console.log(`  ${destV21}`);
console.log(`  ${destResolver}`);
console.log(`  ${destCanon}`);
console.log(`  ${destTable}`);
console.log(`  ${destSchema}`);
console.log(`secondary table content_hash (field + recomputed): ${recomputed}`);
console.log(`secondary table version: ${table.version}  row_count: ${table.row_count}`);
console.log(`direct table content_hash (field): ${directTable.content_hash}  rows: ${directTable.rows.length}`);
console.log(`PACT map content_hash (field): ${pactTable.content_hash}  rows: ${pactTable.rows.length}`);
console.log(`v1 schema sha256 (EMR-authored, NOT overwritten): ${sha256(schemaBytes)}  (pin in anchor-table-pin.test.ts PINNED_SCHEMA_SHA256)`);
console.log(`v2 schema sha256: ${sha256(v2Bytes)}`);
console.log(`v2.1 schema sha256: ${sha256(v21Bytes)}`);
console.log('REMINDER: post the vendor commit SHA to flatratenexus-project/shared/outbox so the Ask-Aegis + website windows pull the identical copies (all lanes pin the SAME secondary + direct + PACT hashes).');
