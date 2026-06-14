-- Import final letter, 2026-06-14. A new LetterRevisionSource value for operator-imported
-- finished letter PDFs (rig-origin drafts or externally-signed letters) that land directly in
-- the RN review queue via POST /cases/:id/letter/import. ADDITIVE only — existing rows and the
-- drafter/editor/surgical/approve paths are unaffected.
--
-- ALTER TYPE ... ADD VALUE must run OUTSIDE a transaction (Postgres restriction); the
-- codebuild-prisma-migrate psql flow runs each statement standalone. IF NOT EXISTS keeps the
-- migration idempotent on re-run (same convention as 20260616000000_gate2_enums).
ALTER TYPE "letter_revision_source" ADD VALUE IF NOT EXISTS 'external_import';
