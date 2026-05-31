-- D2 (per-signer credentials): render-authoritative credential facts for each signing
-- physician. Stored as JSON because these fields exist only to render Section I + the signature
-- block; the model's fullName/npi/specialty columns continue to drive listing/search.
-- Idempotent: safe to re-run.
ALTER TABLE "physicians" ADD COLUMN IF NOT EXISTS "credential_block_json" JSONB;

-- Backfill the Kasky reference signer (keyed by NPI, which is UNIQUE). No-op if the row does not
-- exist yet, and never clobbers a block already set. Keep this object in sync with
-- src/services/credential-block.ts KASKY_CREDENTIALS — the round-trip test enforces the prose.
UPDATE "physicians"
SET "credential_block_json" = '{
  "fullNameWithCredential": "Ryan J. Kasky, DO",
  "specialty": "Family Medicine",
  "boardName": "American Board of Osteopathic Family Physicians",
  "boardAbbreviation": "ABOFP",
  "licenseState": "Nevada",
  "licenseNumber": "DO2996",
  "npi": "1073018958"
}'::jsonb
WHERE "npi" = '1073018958' AND "credential_block_json" IS NULL;
