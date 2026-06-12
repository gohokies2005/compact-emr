-- Delivery identity-unlock (HIPAA audit APP-1 CRITICAL fix, Ryan 2026-06-11).
-- The delivery email previously carried the portal link AND the password together — one
-- compromised mailbox yielded the signed letter. New tokens are IDENTITY-MODE: password_hash
-- is NULL and the portal unlock verifies DOB + phone last-4 (data the veteran already knows,
-- nothing secret in transit). Legacy password tokens keep their hash and keep working.
--
-- password_hash    NOT NULL → nullable. Metadata-only catalog change (no rewrite, no backfill);
--                  existing rows keep their values and stay password-mode.
-- failed_attempts  per-token unlock failure counter; resets to 0 on successful unlock.
-- locked_at        set when failed_attempts reaches the lockout threshold (5) — the portal then
--                  returns 423 and directs the veteran to the out-of-band support path.
ALTER TABLE "delivery_tokens" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "delivery_tokens" ADD COLUMN IF NOT EXISTS "failed_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "delivery_tokens" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMPTZ(6);
