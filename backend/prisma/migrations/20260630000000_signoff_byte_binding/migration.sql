-- Byte-binding (#9 Fix 3): a sign-off must bind to the exact letter BYTES it attested.
-- We hash the version's TXT (the deterministic source of truth — NOT the DOCX/PDF render,
-- whose byte-determinism is unverified). The delivery /send gate re-hashes the CURRENT
-- version's TXT and 409s ('signed_bytes_changed') if it no longer matches the signed hash,
-- so any edit/approve after sign-off blocks delivery until the letter is re-signed.
--
-- Two NULLABLE columns (existing sign-offs predate them; null = no byte check, back-compat).
-- We do NOT reuse the generic `version` optimistic-concurrency counter — these are distinct.
-- Applied via codebuild-prisma-migrate psql flow (raw SQL), idempotent for safe re-runs.
ALTER TABLE "sign_offs" ADD COLUMN IF NOT EXISTS "signed_version" INTEGER;
ALTER TABLE "sign_offs" ADD COLUMN IF NOT EXISTS "signed_content_sha256" TEXT;
