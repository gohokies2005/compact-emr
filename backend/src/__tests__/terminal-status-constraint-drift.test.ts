import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL_READ_STATUSES } from '../services/chart-build-state.js';

// ROOT-CAUSE GUARD for the 2026-06-17 ~$231 OCR runaway (aws-cloud-sme + code-architect-qa audit
// 2026-06-18, both flagged it CRITICAL). That incident: code added the 'auto_skipped' terminal status
// to TERMINAL_READ_STATUSES but the DB CHECK constraint was NOT updated → INSERT violated the constraint
// → /pages POST 500 → the doc never reached a terminal read status → the stuck-doc-watcher re-fired
// Sonnet vision on it FOREVER → unbounded spend, undetected for hours.
//
// This test makes that drift IMPOSSIBLE to ship silently: it parses the file_read_status terminal-status
// CHECK constraint from the LATEST migration that defines it and asserts the allowed set is EXACTLY
// TERMINAL_READ_STATUSES. Add a new terminal status in code without the matching constraint migration
// (or vice-versa) → this test goes RED in CI before it can ever reach prod.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'prisma', 'migrations');
const CONSTRAINT = 'file_read_status_terminal_check';

/** Parse the quoted values out of a `... IN ('a', 'b', ...)` clause. */
function parseInList(sql: string): string[] {
  const m = sql.match(/IN\s*\(([^)]*)\)/i);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * Walk every migration (in applied order — dir names are timestamp-prefixed and sort chronologically),
 * tracking the most recent definition of the file_read_status terminal-status CHECK constraint. A later
 * migration's ADD/CREATE CONSTRAINT supersedes an earlier one (the auto_skipped fix DROPs + re-ADDs it).
 */
function latestConstraintAllowedSet(): { values: string[]; migration: string } | null {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(); // timestamp-prefixed → chronological
  let latest: { values: string[]; migration: string } | null = null;
  for (const dir of dirs) {
    let sql: string;
    try { sql = readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'); }
    catch { continue; }
    if (!sql.includes(CONSTRAINT)) continue;
    // Consider any CHECK on terminal_status tied to this constraint name (CREATE TABLE inline OR ALTER ADD).
    // Take the LAST IN-list in the file that mentions terminal_status (a DROP-then-ADD file has the ADD last).
    const checks = [...sql.matchAll(/CHECK\s*\(\s*"?terminal_status"?\s+IN\s*\([^)]*\)\s*\)/gi)].map((x) => x[0]);
    if (checks.length === 0) continue;
    const values = parseInList(checks[checks.length - 1]);
    if (values.length > 0) latest = { values, migration: dir };
  }
  return latest;
}

/** Pure diff used by the guard — exported for the RED-proof below. */
export function diffStatusSets(codeSet: ReadonlySet<string>, dbValues: readonly string[]): { inCodeNotDb: string[]; inDbNotCode: string[] } {
  const dbSet = new Set(dbValues);
  return {
    inCodeNotDb: [...codeSet].filter((s) => !dbSet.has(s)),
    inDbNotCode: [...dbValues].filter((s) => !codeSet.has(s)),
  };
}

describe('terminal-status ↔ DB CHECK-constraint drift guard ($231 root-cause tripwire)', () => {
  it('the file_read_status CHECK constraint allows EXACTLY the code TERMINAL_READ_STATUSES set', () => {
    const found = latestConstraintAllowedSet();
    expect(found, `no ${CONSTRAINT} CHECK constraint found in any migration`).not.toBeNull();
    const { inCodeNotDb, inDbNotCode } = diffStatusSets(TERMINAL_READ_STATUSES, found!.values);
    // inCodeNotDb is the $231 failure mode: code emits a status the DB rejects → /pages 500 → infinite refire.
    expect(inCodeNotDb, `code TERMINAL_READ_STATUSES has values the DB CHECK (migration ${found!.migration}) rejects — this is the $231 drift. Add a constraint migration.`).toEqual([]);
    expect(inDbNotCode, `DB CHECK allows values not in TERMINAL_READ_STATUSES — code + constraint disagree.`).toEqual([]);
  });

  it('the guard CATCHES the exact $231 drift (a code status the DB constraint rejects)', () => {
    // Simulate: code adds 'auto_skipped' but the OLD constraint (pre-fix) only allowed three values.
    const codeWithNew = new Set(['read', 'manual_summary_provided', 'manual_summary_required', 'auto_skipped']);
    const oldDbConstraint = ['read', 'manual_summary_required', 'manual_summary_provided'];
    const { inCodeNotDb } = diffStatusSets(codeWithNew, oldDbConstraint);
    expect(inCodeNotDb).toEqual(['auto_skipped']); // the guard flags it RED — exactly what would prevent $231
  });

  it('parses the real migration constraint to the expected 4 values', () => {
    const found = latestConstraintAllowedSet();
    expect(new Set(found!.values)).toEqual(new Set(['read', 'manual_summary_required', 'manual_summary_provided', 'auto_skipped']));
  });
});
