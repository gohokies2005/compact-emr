-- Keystone pkg 5 (stamp provenance): per-field-group source columns so a refresh can distinguish
-- RN-set from derivation-stamped values. Values: 'derived' | 'manual'. NULL = legacy/unknown
-- provenance = IMMUTABLE to auto-refresh (conservative: pre-migration values are presumed possibly
-- RN-set; backfill intentionally SKIPPED). The post-merge restamp hook (pkg 4c) overwrites a field
-- group ONLY when its source === 'derived'.
-- All NULLABLE, no default -> no table rewrite, safe on a live table. IF NOT EXISTS for idempotent
-- re-runs (codebuild-prisma-migrate psql flow).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "framing_stamp_source" VARCHAR(16);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "viability_stamp_source" VARCHAR(16);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "cds_stamp_source" VARCHAR(16);
