-- Phase 5: ICD-10 code on active problems (optional, populated when chosen from typeahead).
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "icd10" VARCHAR(16);
CREATE INDEX IF NOT EXISTS "active_problems_icd10_idx" ON "active_problems"("icd10");
