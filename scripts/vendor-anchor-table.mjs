#!/usr/bin/env node
// scripts/vendor-anchor-table.mjs
//
// THE ONLY WAY to update the vendored anchor-viability resolver set in this repo — NEVER hand-edit
// anything under backend/src/vendor/. Per docs/P4_ANCHOR_VIABILITY_BUILD_PLAN.md §2.
//
// Vendor set (canonical → vendored):
//   flatratenexus-project/app/services/anchorMechanism.js      → backend/src/vendor/anchorMechanism.cjs
//   flatratenexus-project/app/services/conditionCanon.js       → backend/src/vendor/conditionCanon.cjs
//   flatratenexus-project/references/anchor_mechanism_pairs.json → backend/src/vendor/anchor_mechanism_pairs.json
//   flatratenexus-project/app/config/caseViability.v1.schema.json → backend/src/config/caseViability.v1.schema.json
//
// NOT vendored: framingGate.js (build plan G8 — it requires better-sqlite3 + llm/client; vendoring it
// would drag the DB + LLM client into the Lambda. Only the DRAFTER consumes framingGate, in-repo).
//
// anchorMechanism.cjs carries EXACTLY TWO pinned, asserted rewrites (everything else byte-identical):
//   1. ARTIFACT_PATH — the vendored table sits BESIDE the resolver, not at ../../references/.
//   2. require('./conditionCanon') → require('./conditionCanon.cjs') — the EMR backend is ESM
//      ("type":"module"), so the vendored CJS files use the .cjs extension; Node's extensionless
//      require() does NOT resolve .cjs, so the intra-vendor require must name it. (This second
//      rewrite is a necessary addition to the build plan's "exactly one rewrite" — without it the
//      vendored resolver cannot load its canonicalizer at all.)
// Both pre-image lines are asserted VERBATIM before replacing — if the canonical resolver changed
// shape, this script aborts loudly ("re-author the vendor rewrite") instead of silently drifting.
//
// PIN-LITERAL SITES (build plan R4 — a table re-curation rotates the 58f9c315… pin; ALL of these
// must move in the SAME commit or the build goes red. That red is the INTENDED drift alarm):
//   1. PINNED_TABLE_HASH below (this script)
//   2. backend/src/config/caseViability.v1.schema.json → properties.table_content_hash.const
//   3. backend/src/__tests__/anchor-table-pin.test.ts  → PINNED_TABLE_HASH + PINNED_SCHEMA_SHA256
//   4. backend/src/__tests__/case-viability.test.ts    → PINNED_TABLE_HASH
// The Ask-Aegis + website windows pin the SAME hash — post the vendor commit SHA to
// flatratenexus-project/shared/outbox so all three lanes pull the identical copy.
//
// Usage: node scripts/vendor-anchor-table.mjs [--from <flatratenexus-project path>]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_TABLE_HASH = '1f095fb66e851ec10f9babe6e7fa0a5956c4b6eb11dadc3733bc8fcf25a868e3';

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
const ARTIFACT_POST = "const ARTIFACT_PATH = path.join(__dirname, 'anchor_mechanism_pairs.json'); // VENDORED REWRITE 1/2 (scripts/vendor-anchor-table.mjs): table sits beside the resolver";
const REQUIRE_PRE = "const conditionCanon = require('./conditionCanon');";
const REQUIRE_POST = "const conditionCanon = require('./conditionCanon.cjs'); // VENDORED REWRITE 2/2 (scripts/vendor-anchor-table.mjs): .cjs extension under the ESM backend";

if (!resolverSrc.includes(ARTIFACT_PRE)) {
  abort('source resolver changed shape — ARTIFACT_PATH pre-image line not found verbatim; re-author the vendor rewrite');
}
if (!resolverSrc.includes(REQUIRE_PRE)) {
  abort("source resolver changed shape — require('./conditionCanon') pre-image line not found verbatim; re-author the vendor rewrite");
}
resolverSrc = resolverSrc.replace(ARTIFACT_PRE, ARTIFACT_POST).replace(REQUIRE_PRE, REQUIRE_POST);
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

// ── 4. caseViability.v1.schema.json (byte-identical when the canonical exists) ───────────────
const srcSchemaPath = path.join(FROM, 'app', 'config', 'caseViability.v1.schema.json');
const destSchema = path.join(CONFIG_DIR, 'caseViability.v1.schema.json');
if (existsSync(srcSchemaPath)) {
  writeFileSync(destSchema, readFileSync(srcSchemaPath));
} else if (existsSync(destSchema)) {
  // The EMR window authored the schema first (from the verified resolver bytes, plan §1); the
  // canonical app/config/ copy lands via the drafter window. Until then the EMR copy is the
  // authored original — flag it so the next vendor run after the canonical lands re-verifies.
  console.warn(`WARN: canonical schema not found at ${srcSchemaPath}; keeping the EMR-authored copy. ` +
    'Land the byte-identical canonical in the drafter repo (see shared/outbox coordination note).');
} else {
  abort(`schema missing on BOTH sides (${srcSchemaPath} and ${destSchema})`);
}

const schemaBytes = readFileSync(destSchema);

console.log('vendored 4 files:');
console.log(`  ${destResolver}`);
console.log(`  ${destCanon}`);
console.log(`  ${destTable}`);
console.log(`  ${destSchema}`);
console.log(`table content_hash (field + recomputed): ${recomputed}`);
console.log(`table version: ${table.version}  row_count: ${table.row_count}`);
console.log(`schema sha256: ${sha256(schemaBytes)}  (pin this in anchor-table-pin.test.ts)`);
console.log('REMINDER: post the vendor commit SHA to flatratenexus-project/shared/outbox so the Ask-Aegis + website windows pull the identical copy (all three lanes pin the SAME table hash).');
