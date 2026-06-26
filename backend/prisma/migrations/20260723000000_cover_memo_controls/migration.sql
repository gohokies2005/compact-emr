-- Cover-memo staff controls (Dr. Kasky 2026-06-26, Spring). ADDITIVE ONLY: two new columns on
-- "cases", both defaulted/nullable so every existing row is unaffected. cover_memo_suppressed =
-- send ONLY the nexus letter (no cover memo); cover_memo_text_override = a staff-edited memo body
-- that replaces the composed text. Read by delivery.composeMemo. Apply with `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN "cover_memo_suppressed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cases" ADD COLUMN "cover_memo_text_override" TEXT;
