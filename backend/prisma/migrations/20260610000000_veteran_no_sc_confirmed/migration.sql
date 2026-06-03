-- Draft-readiness: RN affirmation that a veteran has NO service-connected conditions.
-- Disambiguates "SC chart not entered yet" from "confirmed none" so a secondary claim can be told
-- it has no SC primary to attach to. Additive, defaulted, idempotent.
ALTER TABLE "veterans" ADD COLUMN IF NOT EXISTS "no_sc_conditions_confirmed" BOOLEAN NOT NULL DEFAULT false;
