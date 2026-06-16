-- Per-page extraction provenance (vision rebuild, 2026-06-16).
-- Additive + nullable: legacy rows and the Textract/native paths leave these NULL ("no per-page
-- signal"). The per-page vision path stamps them so chart-extraction coverage can be counted
-- per-page truthfully (the false-"100% read" fix) instead of per-file.
--   extraction_method    — textract | native_pdf | native_text | vision_haiku | vision_sonnet | image_describe
--   extraction_coverage  — the model's honest per-page self-report: full | partial | illegible | blank
--   handwriting_present  — TRUE when the page carries ANY handwriting (combo printed+handwritten forms)
ALTER TABLE "document_pages" ADD COLUMN "extraction_method" TEXT;
ALTER TABLE "document_pages" ADD COLUMN "extraction_coverage" TEXT;
ALTER TABLE "document_pages" ADD COLUMN "handwriting_present" BOOLEAN;
