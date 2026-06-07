-- Persist the answer text so the Ask Aegis Q&A thread renders when a case is reopened.
ALTER TABLE "advisory_queries" ADD COLUMN "answer" TEXT;
