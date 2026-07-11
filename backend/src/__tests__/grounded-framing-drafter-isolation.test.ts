import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── TRIPWIRE (Ryan 2026-07-11, CLM-47FAC163B8) ─────────────────────────────────────────────────────
// `resolveGroundedFraming` (services/grounded-framing.ts) is a DISPLAY-ONLY resolver: it returns the
// anchor SAFE TO SHOW so a stale mechanism-blind `upstreamScCondition` ("Ankle") never reaches a chart
// surface. The owner's HARD constraint: NONE of it can influence the drafter or break a letter. That
// holds ONLY because it is never wired into what the drafter reads. The single way it could become a
// drafter/gate input is if it were imported into the DRAFTER BUNDLE or a FRAMING STAMP (the two paths
// that feed the Fargate drafter). This meta-test FAILS the build if that ever happens — making the
// display-only guarantee bypass-proof at the harness level, not just by convention (3-agent QA).
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..'); // backend/src

// Files that feed the drafter's letter/framing inputs — the resolver must NEVER appear here.
const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)drafter-bundle\.ts$/, // the bundle the Fargate drafter reads
  /-stamp\.ts$/, // case-framing-stamp.ts / ai-viability-plan-stamp.ts — what stamps the bundle
];
const IMPORT_RE = /from\s+['"][^'"]*grounded-framing(?:\.js)?['"]/;

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

describe('grounded-framing drafter-isolation tripwire', () => {
  it('resolveGroundedFraming is NEVER imported into the drafter bundle or a *-stamp file', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (!FORBIDDEN.some((re) => re.test(rel))) continue;
      if (IMPORT_RE.test(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(
      offenders,
      `grounded-framing is DISPLAY-ONLY and must not reach the drafter/stamp path (would convert a display value into a letter/gate input): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('DETECTOR PROOF: the tripwire regexes actually match', () => {
    expect(FORBIDDEN.some((re) => re.test('services/drafter-bundle.ts'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('services/case-framing-stamp.ts'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('services/ai-viability-plan-stamp.ts'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('routes/drafter.ts'))).toBe(false); // a display route MAY use it
    expect(IMPORT_RE.test("import { resolveGroundedFraming } from './grounded-framing.js';")).toBe(true);
  });
});
