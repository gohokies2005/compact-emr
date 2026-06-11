-- P3 identity block + avatar (docs/UI_SWEEP_BUILD_PLAN_2026-06-11.md §P3a). Nullable avatar S3 key
-- on BOTH app_users and physicians (Ryan decision: both, matching the signature-on-Physician
-- pattern). Keys live under avatars/<userId>/<uuid>.<ext> in the PHI bucket — the existing
-- bucket-wide grantReadWrite covers the prefix, so there is NO CDK change. Both columns NULLABLE,
-- default null -> existing rows unaffected (additive, converge-safe, reversible). IF NOT EXISTS
-- for idempotent re-runs (codebuild-prisma-migrate psql flow).
ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "avatar_s3_key" TEXT;
ALTER TABLE "physicians" ADD COLUMN IF NOT EXISTS "avatar_s3_key" TEXT;
