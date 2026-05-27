-- Phase 7B-revised Build 1: per-page text extraction storage.
-- The OCR worker (Phase 7A, separate build) populates one row per page of each Document with
-- the extracted text + Textract confidence. The page-selector service queries by
-- (document_id, page_number) to decide which pages of which docs become the Doctor Pack.
--
-- Why a table (vs S3 prefix): page-selector + drafter-citation reverse-index both query by
-- (documentId, pageNumber); RDS join with Document is one SQL hop. Text is small
-- (median ~2 KB, worst ~30 KB) and PostgreSQL TOAST compresses transparently.

CREATE TABLE IF NOT EXISTS "document_pages" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "document_id"  TEXT NOT NULL,
  "page_number"  INTEGER NOT NULL,
  "text"         TEXT NOT NULL,
  "confidence"   REAL,
  "extracted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "document_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_pages_doc_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
  CONSTRAINT "document_pages_page_check" CHECK ("page_number" >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_pages_doc_page_uq" ON "document_pages"("document_id", "page_number");
CREATE INDEX IF NOT EXISTS "document_pages_doc_id_idx" ON "document_pages"("document_id");
