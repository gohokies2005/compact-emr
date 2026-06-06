-- Architect gate (money path): the Stripe webhook idempotency was findFirst-then-create, which races
-- under concurrent Stripe retries → double-deliver. Enforce one payment per charge at the DB. PARTIAL
-- unique (NULL stripe_charge_id rows — stub/composed payments — are exempt and coexist), mirroring the
-- repo's existing partial-unique idiom (Prisma @@unique can't express partial, so it lives in raw SQL).
-- If existing rows already have a duplicate non-null charge id this would fail — none expected (the
-- only prior writer is the delivery stub), but the WHERE clause keeps it safe for NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_charge_id_uq"
  ON "payments" ("stripe_charge_id") WHERE "stripe_charge_id" IS NOT NULL;
