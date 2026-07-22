// Re-vendors the curated NEGATIVE PAIRINGS from the flatratenexus repo into a typed TS const
// (backend/src/advisory/negativePairings.generated.ts). Cross-repo, so we vendor a copy; RUN THIS on any
// change to the source. Mirrors backend/scripts/vendor-advisory-prompt.cjs (systemPrompt.ts codegen).
//
// SOURCE OF TRUTH: flatratenexus-project/references/medical_literature/curated/negative_pairings.json,
// itself generated from negative_pairings.md by FRN's `npm run negatives:build`. So the FRN builder must be
// run FIRST (or the FRN gate `npm run negatives:gate` green) before re-vendoring here.
//
// Usage: node backend/scripts/vendor-negative-pairings.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const FRN_JSON = 'C:/Users/ryank/OneDrive/Documents/Flat Rate Nexus/flatratenexus-project/references/medical_literature/curated/negative_pairings.json';
const DEST = path.join(__dirname, '..', 'src', 'advisory', 'negativePairings.generated.ts');

function generate() {
  if (!fs.existsSync(FRN_JSON)) {
    console.error(`vendor-negative-pairings: source not found at ${FRN_JSON}. Run FRN \`npm run negatives:build\` first.`);
    process.exitCode = 1;
    return;
  }
  const src = JSON.parse(fs.readFileSync(FRN_JSON, 'utf8'));
  const pairings = Array.isArray(src.pairings) ? src.pairings : [];
  // Keep only the fields the EMR matcher/formatter needs (drop volatile generated_at). Stable order.
  const slim = pairings.map((p) => ({
    upstream: p.upstream,
    claimed: p.claimed,
    verdict: p.verdict,
    caution: !!p.caution,
    reason: p.reason,
    counterargument: p.counterargument,
    pmids: Array.isArray(p.pmids) ? p.pmids : [],
    upstream_variants: Array.isArray(p.upstream_variants) ? p.upstream_variants : [],
    claimed_variants: Array.isArray(p.claimed_variants) ? p.claimed_variants : [],
    upstream_topics: Array.isArray(p.upstream_topics) ? p.upstream_topics : [],
    claimed_topics: Array.isArray(p.claimed_topics) ? p.claimed_topics : [],
  }));
  const out = `// AUTO-VENDORED from flatratenexus-project/references/medical_literature/curated/negative_pairings.json
// by backend/scripts/vendor-negative-pairings.cjs. DO NOT hand-edit — re-run the script on any source change.
// Source of truth is FRN's negative_pairings.md (built to .json via \`npm run negatives:build\`).
// INTERNAL physician strategy: reason / counterargument / PMIDs are advisory to the RN/physician and are
// NEVER quoted in a letter (CLAUDE.md #17).
import type { NegativePairing } from './negativePairingLookup.js';

export const NEGATIVE_PAIRINGS_SOURCE_VERSION = ${JSON.stringify(String(src.version || '1.0'))};

export const NEGATIVE_PAIRINGS: readonly NegativePairing[] = ${JSON.stringify(slim, null, 2)};
`;
  fs.writeFileSync(DEST, out);
  console.log(`vendored ${DEST}: ${slim.length} negative pairing(s)`);
}

if (require.main === module) generate();
module.exports = { generate };
