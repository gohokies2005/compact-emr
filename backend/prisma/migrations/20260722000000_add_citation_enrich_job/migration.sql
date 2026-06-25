-- Feature B — Citation Enricher (Ryan 2026-06-24). ADDITIVE ONLY: one new table, the async
-- propose/poll/apply scratchpad for the physician grounded-NCBI citation tool. No change to any
-- existing table. Cascade-deletes with the case. Apply on deploy with `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "citation_enrich_jobs" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "condition" TEXT,
    "claim" TEXT,
    "mechanism_hints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "candidates_json" JSONB,
    "error_message" TEXT,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "citation_enrich_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "citation_enrich_jobs_case_id_idx" ON "citation_enrich_jobs"("case_id");

-- CreateIndex
CREATE INDEX "citation_enrich_jobs_created_at_idx" ON "citation_enrich_jobs"("created_at");

-- AddForeignKey
ALTER TABLE "citation_enrich_jobs" ADD CONSTRAINT "citation_enrich_jobs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
