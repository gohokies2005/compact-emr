-- doctor-pack grounded pages, 2026-06-13.
--
-- WHY: the Doctor Pack "grounded source pages" back-map (doctor-pack-grounded-pages.ts) maps
-- the case's EXTRACTED chart facts back to the EXACT source-document pages that grounded them,
-- so the pack pulls (e.g.) the rating-grant page, the sleep-study AHI page, and the med-list
-- page even out of a 1,000-page Blue Button dump. The query joins each provenance-carrying
-- chart table to its source Document on `source_document_id`, scoped to the rows the extractor
-- wrote (`source = 'extracted'`, non-null `source_document_id`/`source_page`).
--
-- None of sc_conditions / active_problems / active_medications had an index on
-- `source_document_id` (they index veteran_id / condition / problem / drug_name / etc. — the
-- chart-edit access patterns — but never the provenance join column). Without it the back-map's
-- per-document lookup is a sequential scan. These tables are small per-veteran today, but the
-- index keeps the lookup a probe as extracted-row volume grows and matches the @@index added to
-- schema.prisma in the same change.
--
-- Additive + reversible: pure CREATE INDEX, no column/table rewrite, no backfill. IF NOT EXISTS
-- for idempotent re-runs (the codebuild prisma-migrate / psql flow). To reverse, DROP INDEX the
-- three names below.
CREATE INDEX IF NOT EXISTS "sc_conditions_source_document_id_idx" ON "sc_conditions"("source_document_id");
CREATE INDEX IF NOT EXISTS "active_problems_source_document_id_idx" ON "active_problems"("source_document_id");
CREATE INDEX IF NOT EXISTS "active_medications_source_document_id_idx" ON "active_medications"("source_document_id");
