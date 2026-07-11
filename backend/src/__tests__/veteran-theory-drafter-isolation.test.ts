import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── TRIPWIRE (Ryan 2026-07-11, Part B "Ankle nowhere") ─────────────────────────────────────────────
// `runVeteranTheoryAi` (advisory/veteran-theory-ai.ts) is a DISPLAY-ONLY LLM restatement of the veteran's
// own theory, served on ONE lazy physician endpoint. The owner's HARD constraint: NONE of it can influence
// the drafter, a Gate, or SOAP — "visible but not influencing anything if bad." That holds ONLY because it
// is never wired into what those paths read. This meta-test FAILS the build if the module is imported
// (static OR dynamic) into any of the drafter/gate/SOAP feed files below.
//
// This is a SEPARATE tripwire from grounded-framing's — it cannot share that one, because grounded-framing
// is legitimately imported into routes/drafter.ts (its DETECTOR PROOF asserts drafter.ts is ALLOWED),
// whereas veteran-theory-ai must be FORBIDDEN there. Contradictory allowlists can't share a FORBIDDEN list.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..'); // backend/src

// The 10 files that feed the drafter's letter/framing inputs, the Gate, or the SOAP/chart-digest assembler.
// veteran-theory-ai.ts must NEVER be imported into any of them (all verified present 2026-07-11).
const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)drafter-bundle\.ts$/, // THE Fargate drafter boundary
  /(^|\/)case-framing-stamp\.ts$/, // stamps framing onto the bundle
  /(^|\/)ai-viability-plan-stamp\.ts$/, // stamps the route-picker plan
  /(^|\/)case-viability-stamp\.ts$/, // stamps the viability block
  /(^|\/)case-stamp-refresh\.ts$/, // orchestrates the stamps
  /(^|\/)documentDigest\.ts$/, // SOAP / chart-digest assembler
  /(^|\/)soap-overview\.ts$/, // SOAP note builder
  /(^|\/)chartSlice\.ts$/, // feeds documentDigest
  /(^|\/)viability-gate\.ts$/, // the Gate
  /(^|\/)routes\/drafter\.ts$/, // the drafter route (enqueue/generation)
];
// Matches both a static `from '...veteran-theory-ai'` and a dynamic `import('...veteran-theory-ai')`.
// Does NOT match the ROUTE ('veteran-theory.js') — only the AI module ('veteran-theory-ai').
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"][^'"]*veteran-theory-ai(?:\.js)?['"]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('veteran-theory-ai drafter/gate/SOAP-isolation tripwire', () => {
  it('runVeteranTheoryAi is NEVER imported into a drafter/gate/SOAP feed file', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (!FORBIDDEN.some((re) => re.test(rel))) continue;
      if (IMPORT_RE.test(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(
      offenders,
      `veteran-theory-ai is DISPLAY-ONLY and must not reach the drafter/gate/SOAP path (would convert a display value into a letter/gate/SOAP input): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('POSITIVE INVARIANT: veteran-theory-ai is imported by EXACTLY ONE non-test file (the lazy route)', () => {
    // Strictly stronger than the denylist above (architect work-QA): the denylist is the 10 SINKS, so a new
    // importer — or a file that transitively feeds the drafter but isn't listed, or a rename of a sink that
    // makes its FORBIDDEN regex stop matching — would slip through. This asserts the single-importer fact
    // directly: the ONLY non-test file that imports veteran-theory-ai is its own route. Any new importer
    // (transitive or not) fails the build, which is the real guarantee behind "display-only, AT ALL".
    const importers = walk(SRC)
      .filter((f) => IMPORT_RE.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    expect(importers).toEqual(['routes/veteran-theory.ts']);
  });

  it('DETECTOR PROOF: the tripwire regexes actually match every forbidden path + allow the route', () => {
    const forbiddenPaths = [
      'services/drafter-bundle.ts',
      'services/case-framing-stamp.ts',
      'services/ai-viability-plan-stamp.ts',
      'services/case-viability-stamp.ts',
      'services/case-stamp-refresh.ts',
      'advisory/documentDigest.ts',
      'services/soap-overview.ts',
      'advisory/chartSlice.ts',
      'services/viability-gate.ts',
      'routes/drafter.ts',
    ];
    for (const p of forbiddenPaths) {
      expect(FORBIDDEN.some((re) => re.test(p)), `expected FORBIDDEN to match ${p}`).toBe(true);
    }
    // The lazy route file is the ALLOWED single importer — it must NOT be forbidden.
    expect(FORBIDDEN.some((re) => re.test('routes/veteran-theory.ts'))).toBe(false);
    expect(IMPORT_RE.test("import { runVeteranTheoryAi } from '../advisory/veteran-theory-ai.js';")).toBe(true);
    expect(IMPORT_RE.test("const m = await import('../advisory/veteran-theory-ai.js');")).toBe(true); // dynamic
    expect(IMPORT_RE.test("import { createVeteranTheoryRouter } from './routes/veteran-theory.js';")).toBe(false); // the route, not the AI module
  });
});
