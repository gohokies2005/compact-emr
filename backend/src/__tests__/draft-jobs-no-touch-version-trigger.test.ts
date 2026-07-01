import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATION GUARD (version-inflation incident, 2026-06-29).
 *
 * The Phase-1 schema migration attaches the BEFORE-UPDATE touch-version trigger
 * (compact_emr_touch_version: NEW.version = OLD.version + 1) to a hand-listed set of tables, and
 * draft_jobs was wrongly included. For draft_jobs `version` is the SEMANTIC letter version, not an
 * optimistic-lock counter, so every /progress UPDATE inflated it and the version-derived S3 artifact
 * keys 404'd (Dick: created v5, ended v27).
 *
 * Why CI did not catch it: the unit suites mock Prisma and only SIMULATE the trigger on `cases`, never
 * on `draft_jobs` — the real DDL was never exercised. This STATIC scan of the committed migrations is
 * the test that would have. It walks every migration in apply order and asserts the net effect is that
 * NO *_touch_version trigger governs draft_jobs.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations');

function migrationSqlInOrder(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => statSync(join(MIGRATIONS_DIR, n)).isDirectory())
    .sort() // Prisma applies migrations in lexical (timestamp-prefixed) order
    .map((name) => {
      const p = join(MIGRATIONS_DIR, name, 'migration.sql');
      let sql: string;
      try { sql = readFileSync(p, 'utf8'); } catch { sql = ''; }
      return { name, sql };
    });
}

// Does this migration CREATE/attach a touch_version trigger ON draft_jobs?
//  - explicit form:  CREATE TRIGGER draft_jobs_touch_version ...
//  - loop form:      EXECUTE format('CREATE TRIGGER %I_touch_version ...  with 'draft_jobs' in the ARRAY
function attachesToDraftJobs(sql: string): boolean {
  if (/CREATE\s+TRIGGER\s+draft_jobs_touch_version/i.test(sql)) return true;
  const hasLoopCreate = /CREATE TRIGGER %I_touch_version/i.test(sql);
  const arrayIncludesDraftJobs = /ARRAY\[[^\]]*'draft_jobs'[^\]]*\]/is.test(sql);
  return hasLoopCreate && arrayIncludesDraftJobs;
}

// Does this migration PURELY drop the touch_version trigger from draft_jobs (a drop with no re-create
// of it in the same file)? The Phase-1 loop both drops AND re-creates, so it is NOT a pure drop.
function pureDropOnDraftJobs(sql: string): boolean {
  const dropsExplicit = /DROP\s+TRIGGER\s+IF\s+EXISTS\s+draft_jobs_touch_version\s+ON\s+draft_jobs/i.test(sql);
  return dropsExplicit && !attachesToDraftJobs(sql);
}

describe('draft_jobs must NOT carry a touch-version trigger (version-inflation guard)', () => {
  it('net effect across all migrations leaves NO touch_version trigger on draft_jobs', () => {
    let attached = false;
    let everAttached = false;
    for (const { sql } of migrationSqlInOrder()) {
      if (attachesToDraftJobs(sql)) { attached = true; everAttached = true; }
      else if (pureDropOnDraftJobs(sql)) { attached = false; }
    }
    // Sanity: the scan actually exercised the attach path (the Phase-1 mistake is present in history),
    // otherwise the regexes silently matched nothing and the guard would be vacuously green.
    expect(everAttached).toBe(true);
    // The load-bearing assertion: by the final migration, draft_jobs is trigger-free.
    expect(attached).toBe(false);
  });

  it('a dedicated DROP migration for draft_jobs_touch_version exists, ordered AFTER the Phase-1 attach', () => {
    const all = migrationSqlInOrder();
    const attachIdx = all.findIndex(({ sql }) => attachesToDraftJobs(sql));
    const dropIdx = all.findIndex(({ sql }) => pureDropOnDraftJobs(sql));
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(attachIdx);
  });
});
