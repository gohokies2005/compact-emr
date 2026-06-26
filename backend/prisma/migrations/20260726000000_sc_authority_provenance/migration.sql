-- SC-status provenance / source-authority (Woodley fix, 2026-06-26). ADDITIVE ONLY: two new nullable
-- columns on "sc_conditions" so the migration is a metadata-only ALTER (no table rewrite, no lock at this
-- row count) and every existing row stays NULL = "unknown authority", which consumers fail-safe on.
-- source_authority_tier = the source document's authority over SC status (sc-authority.ts ScAuthorityTier);
-- sc_status_authoritative = the derived trust bit (true ONLY for a VA rating decision / benefit summary).
-- service_connected is never trusted from a non-authoritative source once SC_PROVENANCE_ENFORCED is on.
ALTER TABLE "sc_conditions" ADD COLUMN "source_authority_tier" TEXT;
ALTER TABLE "sc_conditions" ADD COLUMN "sc_status_authoritative" BOOLEAN;
