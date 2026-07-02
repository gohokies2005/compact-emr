-- AI document titling (Haiku 4.5): persist the model-generated title, doc type, and the model
-- that produced it onto each Document. All additive + nullable, so this is a metadata-only ALTER
-- (no table rewrite) and safe to apply on a live table. Legacy rows stay NULL → the documents list
-- falls back to the deterministic regex classifier (documentClassifier.ts).
ALTER TABLE "documents" ADD COLUMN "auto_title" TEXT;
ALTER TABLE "documents" ADD COLUMN "doc_type" TEXT;
ALTER TABLE "documents" ADD COLUMN "title_model" TEXT;
