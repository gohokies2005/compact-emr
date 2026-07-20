-- Physician co-sign (DPT docket 2026-07-19). ADDITIVE only: a provider whose SIGNED letters are
-- co-signed by the referenced physician (the account owner, Dr. Kasky). NULL = the provider signs
-- alone — the historical single-signer path, unchanged. Self-FK on physicians; ON DELETE SET NULL so
-- removing the co-signer physician just clears the flag (never cascades a provider away).
ALTER TABLE "physicians" ADD COLUMN "cosigned_by_physician_id" TEXT;
CREATE INDEX "physicians_cosigned_by_physician_id_idx" ON "physicians"("cosigned_by_physician_id");
ALTER TABLE "physicians" ADD CONSTRAINT "physicians_cosigned_by_physician_id_fkey" FOREIGN KEY ("cosigned_by_physician_id") REFERENCES "physicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;
