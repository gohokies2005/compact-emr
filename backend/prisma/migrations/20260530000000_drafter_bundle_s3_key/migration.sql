-- Architect QA F1: drafter-export materialization bundle lives in S3.
-- The GET endpoint can blow past API Gateway / Lambda payload limits (~6-10 MB) on a
-- 100-doc case with full OCR'd text. Instead: POST /draft writes the bundle JSON to
-- s3://<phi-bucket>/drafter-exports/<caseId>/<jobId>.json, the Fargate drafter wrapper
-- reads it from S3 directly using its existing phiBucket read grant, and GET endpoint
-- returns a presigned URL pointing at the bundle.
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "bundle_s3_key" VARCHAR(500);
