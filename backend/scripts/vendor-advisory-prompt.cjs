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
