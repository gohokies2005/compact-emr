-- Phase 7B-revised Build 1: physician override for Doctor Pack page selection.
-- When the page-selector's rules either over- or under-narrow the included pages, the
-- physician can flip this flag on a per-file basis to force "include all pages" for that doc.
-- Default false matches existing behavior (rules + page-selector decide what's in).
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "physician_include_all_pages" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "needs_rn_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "selector_version" VARCHAR(50);
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "selector_rationale" TEXT;

CREATE INDEX IF NOT EXISTS "key_docs_needs_rn_review_idx" ON "key_docs"("needs_rn_review");
