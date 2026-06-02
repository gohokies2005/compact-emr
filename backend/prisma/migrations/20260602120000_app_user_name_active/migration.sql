-- Staff provisioning: AppUser gains a display name + an active flag (offboarding / picker filter).
-- Additive + idempotent. `active` defaults true so existing rows (the bootstrap admin) stay live
-- with no data migration; `name` is nullable so the bootstrap admin row backfills clean.
ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "name" VARCHAR(120);
ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS "app_users_active_idx" ON "app_users" ("active");
