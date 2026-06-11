-- Keystone pkg 4b (reprocess endpoint): widen trigger_hash 64 -> 128 so a FORCED reprocess run can
-- store the salted form `<sha256 hex 64>:manual:<uuid 36>` (108 chars). The base hash stays
-- prefix-recoverable, letting deriveChartBuildState tie a forced run back to the current doc set
-- (otherwise the draft-readiness door would sit in 'extracting' forever after a forced run
-- completes). Widening a VARCHAR is metadata-only in Postgres -- no table rewrite, safe live.
ALTER TABLE "chart_extraction_runs" ALTER COLUMN "trigger_hash" TYPE VARCHAR(128);
