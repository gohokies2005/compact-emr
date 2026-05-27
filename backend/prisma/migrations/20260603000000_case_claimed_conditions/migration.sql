-- Multi-condition clustered claims (2026-05-27).
-- A case can list multiple same-body-system claimed conditions argued in one letter.
-- claimed_condition stays as the primary (RN's first pick / display + drafter primary);
-- claimed_conditions is the full set CDS scores (overall verdict follows the best-odds member).
ALTER TABLE "cases" ADD COLUMN "claimed_conditions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill existing rows: the single claimed_condition becomes a one-element list.
UPDATE "cases" SET "claimed_conditions" = ARRAY["claimed_condition"] WHERE "claimed_conditions" = ARRAY[]::TEXT[];
