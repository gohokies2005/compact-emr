-- Per-condition VA claim status (2026-05-30).
-- The SC-conditions chart tab listed only already-granted conditions. Add a status so each row
-- can be marked service_connected (granted/established — the default, and what every existing row
-- is), pending (claim filed, awaiting decision), or denied. Gives the chart the veteran's full
-- claim history in one place for nexus-strategy context.
DO $$ BEGIN
  CREATE TYPE sc_condition_status AS ENUM ('service_connected', 'pending', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "sc_conditions"
  ADD COLUMN IF NOT EXISTS "status" "sc_condition_status" NOT NULL DEFAULT 'service_connected';
