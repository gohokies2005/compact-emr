-- Intake pool: capture DOB (normalized ISO), claim type, and the source form title so the assign
-- drawer can PRE-FILL them (the RN must not have to log into Jotform to look up a veteran's DOB) and
-- label the stage correctly from the real form name instead of guessing by form ID.
ALTER TABLE "intakes" ADD COLUMN IF NOT EXISTS "submitted_dob" VARCHAR(10);
ALTER TABLE "intakes" ADD COLUMN IF NOT EXISTS "submitted_claim_type" VARCHAR(20);
ALTER TABLE "intakes" ADD COLUMN IF NOT EXISTS "submitted_form_title" TEXT;
