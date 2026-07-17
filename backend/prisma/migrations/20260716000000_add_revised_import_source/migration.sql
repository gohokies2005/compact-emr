-- Revised-letter recovery, 2026-07-16. A new LetterRevisionSource value for an out-of-band,
-- physician-corrected nexus-letter TXT pushed into physician_review via
-- POST /api/v1/internal/drafter/cases/:id/revised-letter (the endpoint re-renders the trio and
-- advances Case.currentVersion). ADDITIVE only — existing rows and the
-- drafter/editor/surgical/approve/external-import paths are unaffected.
--
-- ALTER TYPE ... ADD VALUE must run OUTSIDE a transaction (Postgres restriction); the
-- codebuild-prisma-migrate psql flow runs each statement standalone. IF NOT EXISTS keeps the
-- migration idempotent on re-run (same convention as 20260710000000_letter_revision_external_import).
ALTER TYPE "letter_revision_source" ADD VALUE IF NOT EXISTS 'revised_import';
