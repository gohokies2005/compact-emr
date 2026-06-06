-- Feature B — in-EMR managed list of Google Workspace mailboxes the gmail-ingest poller monitors
-- (Ryan 2026-06-06). Managed from an admin page; the ingester reads active addresses via
-- GET /internal/monitored-mailboxes. Additive, standalone table.
CREATE TABLE IF NOT EXISTS "monitored_mailboxes" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "address"    TEXT NOT NULL,
  "label"      TEXT,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "added_by"   TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "monitored_mailboxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "monitored_mailboxes_address_key" ON "monitored_mailboxes" ("address");
