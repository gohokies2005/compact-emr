-- Phase 5: link Physician records to Cognito users via cognito_sub.
-- Optional (nullable) so existing physician rows without a Cognito user remain valid.

ALTER TABLE "physicians" ADD COLUMN IF NOT EXISTS "cognito_sub" VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS "physicians_cognito_sub_key" ON "physicians"("cognito_sub");
