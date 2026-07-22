// Re-vendors the curated PAIRING STRENGTH grades from the flatratenexus repo into a typed TS const
// (backend/src/advisory/pairingStrength.generated.ts). Cross-repo, so we vendor a copy; RUN THIS on any
// change to the source. The positive counterpart to vendor-negative-pairings.cjs.
//
// SOURCE OF TRUTH: flatratenexus-project/references/medical_literature/curated/pairing_strength.json,
// itself generated from the [STRENGTH:] anchors across the library by FRN's
// `node app/scripts/_build_pairing_strength.js`. So the FRN builder must be run FIRST before re-vendoring.
//
// Usage: node backend/scripts/vendor-pairing-strength.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const FRN_JSON = 'C:/Users/ryank/OneDrive/Documents/Flat Rate Nexus/flatratenexus-project/references/medical_literature/curated/pairing_strength.json';
const DEST = path.join(__dirname, '..', 'src', 'advisory', 'pairingStrength.generated.ts');

function generate() {
  if (!fs.existsSync(FRN_JSON)) {
    console.error(`vendor-pairing-strength: source not found at ${FRN_JSON}. Run FRN \`node app/scripts/_build_pairing_strength.js\` first.`);
    process.exitCode = 1;
    return;
  }
  const src = JSON.parse(fs.readFileSync(FRN_JSON, 'utf8'));
  const pairings = Array.isArray(src.pairings) ? src.pairings : [];
  // Keep only the fields the EMR matcher/formatter needs (drop volatile generated_at). Stable order.
  const slim = pairings.map((p) => ({
    upstream: p.upstream,
    downstream: p.downstream,
    grade_raw: p.grade_raw,
    grade_tier: p.grade_tier,
    verdict_anchor: p.verdict_anchor,
    framing_note: p.framing_note,
    pmids: Array.isArray(p.pmids) ? p.pmids : [],
    upstream_variants: Array.isArray(p.upstream_variants) ? p.upstream_variants : [],
    downstream_variants: Array.isArray(p.downstream_variants) ? p.downstream_variants : [],
    upstream_topics: Array.isArray(p.upstream_topics) ? p.upstream_topics : [],
    downstream_topics: Array.isArray(p.downstream_topics) ? p.downstream_topics : [],
  }));
  const out = `// AUTO-VENDORED from flatratenexus-project/references/medical_literature/curated/pairing_strength.json
// by backend/scripts/vendor-pairing-strength.cjs. DO NOT hand-edit — re-run the script on any source change.
// Source of truth is FRN's [STRENGTH:] anchors (built to .json via \`node app/scripts/_build_pairing_strength.js\`).
// This is a GRADE for the pairing the drafter already chose — it never picks the drafter's direction.
import type { PairingStrength } from './pairingStrengthLookup.js';

export const PAIRING_STRENGTH_SOURCE_VERSION = ${JSON.stringify(String(src.version || '1.0'))};

export const PAIRING_STRENGTHS: readonly PairingStrength[] = ${JSON.stringify(slim, null, 2)};
`;
  fs.writeFileSync(DEST, out);
  console.log(`vendored ${DEST}: ${slim.length} graded pairing(s); tiers ${JSON.stringify(src.stats && src.stats.tier_counts || {})}`);
}

if (require.main === module) generate();
module.exports = { generate };
