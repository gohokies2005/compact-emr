// Re-vendors the advisory system prompt + canonical_facts from the flatratenexus repo into a TS module
// (backend/src/advisory/systemPrompt.ts). Cross-repo, so we vendor a copy; RUN THIS on any change to the
// source files. The system prompt is the CACHED Bedrock prefix — a change here is a cache-invalidation +
// redeploy event. canonical_facts MUST stay IN the cached prompt every call (red-team: the Oregon/Utah
// hard-NO + pricing/scope live ONLY in canonical_facts, not in retrieval).
//   Usage: node backend/scripts/vendor-advisory-prompt.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/ryank/OneDrive/Documents/Flat Rate Nexus/flatratenexus-project/app/config/advisory';
const md = fs.readFileSync(path.join(SRC, 'rn_advisory_system_prompt.md'), 'utf8');
const cf = fs.readFileSync(path.join(SRC, 'canonical_facts.json'), 'utf8');
JSON.parse(cf); // fail loudly if canonical_facts isn't valid JSON

const out = `// AUTO-VENDORED from flatratenexus-project/app/config/advisory/ by backend/scripts/vendor-advisory-prompt.cjs.
// DO NOT hand-edit — re-run the script on any source change. The system prompt is the CACHED Bedrock
// prefix; a change here is a cache-invalidation + redeploy event. canonical_facts MUST stay IN the cached
// prompt every call (red-team: the Oregon/Utah exclusion + pricing/scope live ONLY here, not in retrieval).
export const RN_ADVISORY_SYSTEM_PROMPT = ${JSON.stringify(md)};
export const CANONICAL_FACTS_JSON = ${JSON.stringify(cf)};

// The cached system prefix = the grounding/viability prompt + the authoritative canonical facts, ALWAYS
// together. Pass the SAME string every call so Bedrock prompt-caching hits (no case_id/name/timestamp).
export function buildSystemPrompt(): string {
  return (
    RN_ADVISORY_SYSTEM_PROMPT +
    '\\n\\n=== CANONICAL FACTS (authoritative; apply to EVERY answer — Oregon/Utah exclusion, pricing, scope) ===\\n' +
    CANONICAL_FACTS_JSON
  );
}
`;
const dest = path.join(__dirname, '..', 'src', 'advisory', 'systemPrompt.ts');
fs.writeFileSync(dest, out);
console.log(`vendored ${dest}: prompt ${md.length}B + canonical_facts ${cf.length}B`);

// Also vendor the runtime CJS modules + data files that live alongside the prompt source. These are
// loaded at RUNTIME from the copied vendor tree (createRequire, __dirname-relative), so they must stay in
// sync with the flatratenexus source. retrieve.js is the ASYNC real retriever (pgvector kNN + BVA
// live-SQL + Titan query-embed); it lazy-requires its helpers + reads the data files by __dirname-relative
// path, so EVERY file it touches must be vendored. sanitizeAnswer.js is the deterministic plain-text
// cleaner the EMR runs over every model answer (strips markdown / internal field names / any $50-refund
// sentence). The vendor tree mirrors the flatratenexus repo layout so the relative requires resolve.
const PROJECT_ROOT = path.join(SRC, '..', '..', '..'); // flatratenexus-project/ (SRC = <root>/app/config/advisory)
const VENDOR_ROOT = path.join(__dirname, '..', 'src', 'advisory', 'vendor');

// [src-relative-to-PROJECT_ROOT] copied to the same relative path under the vendor tree.
const VENDOR_FILES = [
  // config (data the prompt + retriever read)
  'app/config/advisory/canonical_facts.json',
  'app/config/advisory/intent_recipes.json',
  'app/config/advisory/bva_condition_map.json',
  // advisory services (retrieve.js is now ASYNC) + its helpers
  'app/services/advisory/retrieve.js',
  'app/services/advisory/sanitizeAnswer.js',
  'app/services/advisory/intentRouter.js',
  'app/services/advisory/bvaConditionMatch.js',
  'app/services/advisory/bvaPairLookup.js',
  'app/services/advisory/advisoryLiteratureLookup.js',
  // per-source-type retrieval quotas (VA-authority enrichment 2026-06-12) — retrieve.js requires it
  'app/services/advisory/sourceQuota.js',
  // viability grounding (task f) — retrieve.js top-level-requires it; the engine trio below
  // completes its lazy require-graph (../anchorMechanism → ./conditionCanon → references table).
  // DARK in the EMR tab unless AEGIS_VIABILITY_GROUNDING=true is set on the API env.
  'app/services/advisory/viabilityGrounding.js',
  'app/services/anchorMechanism.js',
  'app/services/conditionCanon.js',
  'references/anchor_mechanism_pairs.json',
  // citation fallback (PubMed no-coverage path)
  'app/services/citationFallback.js',
  // BVA pair atlas (read by bvaPairLookup)
  'references/bva_secondary_pairs.json',
];
for (const rel of VENDOR_FILES) {
  const from = path.join(PROJECT_ROOT, rel);
  const to = path.join(VENDOR_ROOT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`vendored ${to}: ${fs.statSync(to).size}B`);
}

// Also regenerate the typed NEGATIVE PAIRINGS const (backend/src/advisory/negativePairings.generated.ts)
// from FRN's negative_pairings.json — a codegen sibling of systemPrompt.ts, not a runtime vendor copy.
// Keeps the Ask-Aegis negative-pairing pre-check in lockstep with the FRN source on every re-vendor.
require('./vendor-negative-pairings.cjs').generate();
