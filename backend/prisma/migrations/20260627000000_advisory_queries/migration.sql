-- Advisory "Ask AI" oversight + cost log (one row per question). No FK to cases — the audit survives
-- case deletion. coverage_gap (JSONB) feeds the library-build roadmap.
CREATE TABLE "advisory_queries" (
  "id" TEXT NOT NULL,
  "case_id" TEXT,
  "veteran_id" TEXT,
  "user_id" TEXT NOT NULL,
  "user_role" VARCHAR(20) NOT NULL,
  "view" VARCHAR(24) NOT NULL,
  "question" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "mode_ran" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "citations_json" JSONB,
  "coverage_gap" JSONB,
  "cost_usd" DECIMAL(10,5),
  "answer_chars" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "advisory_queries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "advisory_queries_case_id_idx" ON "advisory_queries" ("case_id");
CREATE INDEX "advisory_queries_created_at_idx" ON "advisory_queries" ("created_at");
