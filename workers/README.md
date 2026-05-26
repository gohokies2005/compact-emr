# Compact EMR — workers

Two AWS Lambda workers ship in this directory. Both are Python; they're packaged + deployed
by the `WorkersStack` CDK stack (see `infra/lib/workers-stack.ts`, scaffold pending in part 3
of Phase 7B-revised Build 3).

## `ocr/` — Textract OCR pipeline

Two handlers in one Lambda artifact:

- `handler.start_handler` — S3 EventBridge trigger. When a PDF lands in
  `s3://<records-bucket>/records/<caseId>/<documentId>/<filename>`, this kicks off a Textract
  async `StartDocumentTextDetection` job and registers the documentId as the JobTag.

- `handler.completion_handler` — SNS-subscribed. Textract notifies when async jobs finish.
  Handler pulls the result blocks, groups `LINE` blocks by Page, averages confidence per
  page, and POSTs to `/api/v1/internal/documents/<documentId>/pages`.

**Env vars required:**
- `COMPACT_EMR_API_URL` — base URL of the API (e.g. `https://api.emr.flatratenexus.com`)
- `INTERNAL_WORKER_TOKEN` — shared secret matching the API's `INTERNAL_WORKER_TOKEN`. From
  Secrets Manager in production.
- `COMPLETION_SNS_TOPIC_ARN` — SNS topic Textract notifies on completion.
- `TEXTRACT_SNS_ROLE_ARN` — IAM role Textract assumes to publish to the SNS topic.

**IAM:** `textract:StartDocumentTextDetection`, `textract:GetDocumentTextDetection`,
`s3:GetObject` on the records bucket, `sns:Publish` on the completion topic (for Textract).

**Per FRN ingest spec:** never LLM-as-OCR. Textract is the only OCR provider on this path.
Claude vision was retained in the FileReadMethod enum for transition compatibility but new
workers must not use it.

## `doctor-pack-assembler/` — PDF concatenation worker

SQS-triggered. The API route `POST /cases/:id/doctor-pack/generate` enqueues a message
carrying `{doctorPackId, manifest, pdfS3Key}` after it persists the queued DoctorPack row.

On invocation:
1. PATCH the DoctorPack to `state='generating'`.
2. Render the chart-summary cover page via WeasyPrint (HTML→PDF).
3. Render the table-of-contents page.
4. For each manifest entry: fetch the source PDF from S3, extract the specified page ranges
   via `pypdf`, append to the output writer.
5. Upload the assembled PDF to the server-computed `pdfS3Key`.
6. PATCH `state='ready'` with `pdfS3Key` + `pageCount`. On exception: PATCH `state='failed'`
   with `errorMessage`.

**Env vars required:**
- `COMPACT_EMR_API_URL`
- `INTERNAL_WORKER_TOKEN`
- `RECORDS_BUCKET` — S3 bucket where source PDFs live.
- `DOCTOR_PACKS_BUCKET` — S3 bucket where assembled packs go.

**IAM:** `s3:GetObject` on records, `s3:PutObject` on doctor-packs.

**Layer dependencies:**
- `boto3` — Lambda runtime ships this; bundle if pinned.
- `pypdf` — pure Python; bundle in the function code.
- `weasyprint` — needs `cairo`, `pango`, `gobject`. Use the official WeasyPrint Lambda layer
  or build a custom layer with Docker (`amazonlinux:2023` base + apt-get the libs).
  *Documented gotcha:* WeasyPrint's font fallback for unknown languages can take 2-3 seconds
  on cold start; consider Provisioned Concurrency if cover-page latency matters.

**Timing:** a 250-page pack assembles in ~20-40 s warm. Cold start adds ~5-8 s for the
WeasyPrint layer. Well under the 15-min Lambda ceiling. If we ever hit packs over 1000
pages, swap to ECS Fargate per the architect plan's FFC-3.

## Local development

```bash
# OCR start handler — simulate an S3 event
cd workers/ocr
pip install -r requirements.txt
export COMPACT_EMR_API_URL=http://localhost:3000
export INTERNAL_WORKER_TOKEN=local-dev-token-must-be-16+chars
export COMPLETION_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:000000000000:textract-completion
export TEXTRACT_SNS_ROLE_ARN=arn:aws:iam::000000000000:role/textract-publisher
python -c "from handler import start_handler; print(start_handler({'Records': [{'s3': {'bucket': {'name': 'records'}, 'object': {'key': 'records/CASE-1/DOC-1/dd214.pdf'}}}]}, None))"
```

## Deployment

The CDK `WorkersStack` (part 3 of this build) wires:
- Two Lambda functions (`ocr-start`, `ocr-completion`, `doctor-pack-assembler`)
- S3 EventBridge rule on the records bucket → `ocr-start`
- SNS topic + IAM role for Textract → `ocr-completion`
- SQS queue + DLQ for doctor-pack jobs → `doctor-pack-assembler`
- Shared `INTERNAL_WORKER_TOKEN` in Secrets Manager
- WeasyPrint Lambda layer

The route handler in `backend/src/routes/doctor-pack.ts` already publishes to the SQS queue
when it creates a queued DoctorPack row — see the FIXME(phase7a-part3) comment in the
handler.
