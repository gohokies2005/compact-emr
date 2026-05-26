# Phase 7B-revised — End-to-end staging smoke test

Run after `npx cdk deploy compact-emr-staging-workers` succeeds. Validates the full path:

```
S3 upload → OCR worker → /internal/documents/:id/pages (per-page text)
                       → Document.pageCount populated
chart-readiness GREEN  → POST /generate
                       → queued DoctorPack row
                       → SQS message published
                       → assembler Lambda fires
                       → /internal/doctor-packs/:id state=ready
                       → physician opens signed PDF URL
```

## Pre-flight (one-time)

1. `INTERNAL_WORKER_TOKEN` Secrets Manager entry exists (created by the WorkersStack).
2. API stack has `DOCTOR_PACK_QUEUE_URL` env var pointing at the queue from WorkersStack.
3. PHI bucket has EventBridge notifications enabled for the `records/` prefix.
4. Test veteran created (any non-PHI test data — Kasky-last-name auto-skipped per FRN drainer rule, fine here).
5. Test case created on the veteran with `claimType=initial`, `framingChoice=secondary`, `upstreamScCondition=PTSD`, `claimedCondition=Obstructive sleep apnea`.

## The smoke case — PTSD → OSA secondary

This is the architect's reference case for the 41 → 12 page reduction.

### Records to upload (test fixtures live at `docs/smoke-tests/fixtures/`)

| File | Doc type | Expected pages | Selector expectation |
|---|---|---|---|
| `DD-214.pdf` | dd_214 | 2 | all 2 (small doc) |
| `ClaimLetter-2024-3-12.pdf` | rating_decision | 18 | pages with "we have granted" / "service connection" only (~3-5) |
| `DBQ-PTSD-2023.pdf` | dbq | 8 | checked-box + signed cert pages (~3-4) |
| `PSG-Sleep-Study-2024.pdf` | sleep_study | 4 | impression + AHI summary (~2) |
| `Audiogram-2024.pdf` | audiogram | 2 | all 2 (small doc) |
| `Lay_Statement_Spouse.pdf` | lay_statement | 1 | all 1 (small doc) |
| `Blue_Button_VA_Records.pdf` | blue_button | 412 | 0 — bulk excluded |
| `garbled_scan.pdf` | unspecified | 5 | one Textract failure → manual_summary_required |

### Steps

#### 1. Upload records to S3

```bash
export CASE_ID=CASE-SMOKE-001
export VET_ID=VET-SMOKE-001
export RECORDS_BUCKET=compact-emr-staging-phi
export DOC_ID_DD214=$(uuidgen)
# ...one DOC_ID per file

aws s3 cp docs/smoke-tests/fixtures/DD-214.pdf \
  s3://$RECORDS_BUCKET/records/$CASE_ID/$DOC_ID_DD214/DD-214.pdf

# Repeat for each fixture. The S3 PUT fires EventBridge → ocr-start Lambda.
```

#### 2. Wait for OCR completion (~5-10 minutes for full set)

```bash
# Watch the ocr-completion Lambda logs for "POSTED" entries per documentId:
aws logs tail /aws/lambda/compact-emr-staging-ocr-completion --since 10m --follow
```

Expected log lines per document:
```
processed.append({"jobId": "<id>", "documentId": "<doc>", "status": "POSTED", "pages": <N>})
```

For `garbled_scan.pdf`, expect:
```
processed.append({"jobId": "<id>", "documentId": "<doc>", "status": "FAILED", "posted": False, "flaggedForRn": True})
```

#### 3. Verify per-page text + page-count writes (API GET)

```bash
# Each Document should now have pageCount set + DocumentPage rows.
curl -s -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/key-docs" | jq '.data[] | {filePath, classification, docType}'
```

Expected: 8 entries (the 7 successful + 1 manual_summary_required gets a `needsRnReview=true` flag).

#### 4. Check chart-readiness

```bash
curl -s -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/chart-readiness" | jq
```

**Expected:** `ready: false` because `garbled_scan.pdf` is in `manual_summary_required`. The blockingFiles array names that file.

#### 5. RN clears the blocker via the RN page

Open `https://emr.compact-emr-staging.../rn` in a browser (admin or ops_staff role). Should see `garbled_scan.pdf` in the queue. Click → write a ≥40-char summary → submit.

```bash
# Verify chart-readiness flips to ready:
curl -s -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/chart-readiness" | jq '.data.ready'
# Expected: true
```

#### 6. Generate the Doctor Pack

```bash
curl -s -X POST -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/doctor-pack/generate" | jq
```

**Expected:** 201, `data.state = 'queued'`, `data.keyDocCount = 7`, `data.pageCount ≈ 12-16` (the architect's target range for this case).

Watch the assembler Lambda:
```bash
aws logs tail /aws/lambda/compact-emr-staging-doctor-pack-assembler --since 5m --follow
```

Expect:
```
state=generating → state=ready (pages=12, pdfS3Key=doctor-packs/CASE-SMOKE-001/v1/<uuid>.pdf)
```

#### 7. Open the assembled PDF

```bash
# Get the latest pack:
DP_ID=$(curl -s -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/doctor-pack/latest" | jq -r '.data.id')
DP_KEY=$(curl -s -H "Authorization: Bearer $COGNITO_JWT" \
  "https://api.compact-emr-staging.../api/v1/cases/$CASE_ID/doctor-pack/latest" | jq -r '.data.pdfS3Key')

# Sign a URL + open
aws s3 presign "s3://compact-emr-staging-doctor-packs/$DP_KEY" --expires-in 3600
```

**Verify the PDF contents:**
- Page 1: cover page (vet name, claimed condition, SC conditions, framing, CDS verdict)
- Page 2: TOC listing 7 included docs + their page ranges
- Pages 3+: source doc pages in importance order. ClaimLetter pages should be ONLY the decision/reasons, NOT the appeal-rights boilerplate. DBQ pages should be ONLY findings + signed cert.

## Pass criteria (all must be GREEN)

- [ ] OCR worker POSTed per-page text for all 7 valid records
- [ ] Document.pageCount populated on all 7 valid records
- [ ] garbled_scan.pdf landed in file_read_status with terminalStatus='manual_summary_required'
- [ ] chart-readiness returned ready=false before RN summary; ready=true after
- [ ] /generate returned 201 with refined pageCount in the 12-18 range
- [ ] SQS message visible in the doctor-pack-assembler queue (CloudWatch metric)
- [ ] Assembler state went queued → generating → ready
- [ ] Final PDF page 1 is the cover page (chart summary, not the rating decision)
- [ ] Final PDF page 2 is the TOC
- [ ] Final PDF total page count matches the API's `pageCount` field
- [ ] ClaimLetter pages in the PDF are 3-5 (not the full 18)
- [ ] No Blue Button pages in the PDF

## If it fails — diagnostic decision tree

| Symptom | Likely cause | First check |
|---|---|---|
| EventBridge rule doesn't trigger ocr-start | S3 bucket notifications not enabled | `aws s3api get-bucket-notification-configuration --bucket $RECORDS_BUCKET` |
| ocr-start Lambda 5xx | INTERNAL_WORKER_TOKEN mismatch | CloudWatch logs |
| Textract job hangs | TEXTRACT_SNS_ROLE_ARN not granting publish | check role trust policy |
| Pages never POSTed | ocr-completion not subscribed to SNS topic | `aws sns list-subscriptions-by-topic --topic-arn $T` |
| chart-readiness still false after RN summary | manual_summary < 40 chars / wrong status | check FileReadStatus row directly via DB |
| /generate returns 409 chart_not_ready | a different file is still pending | inspect blockingFiles |
| /generate returns 409 conflict (already in flight) | partial-unique index hit | wait for state to flip ready/failed, or manually flag the queued row failed |
| SQS message never delivered | DOCTOR_PACK_QUEUE_URL env not set on API Lambda | check API Lambda env vars |
| Assembler state stuck at generating | timeout / WeasyPrint layer missing | CloudWatch logs |
| PDF includes appeal-rights pages | page-selector regex didn't match the new boilerplate phrasing | inspect KeyDoc.selectorRationale; if needed, add the new phrasing to RULES.rating_decision.exclude |
| Cover page missing | manifestJson.coverPage not populated | check the /generate route logs |

## After a successful run

Commit the smoke test result to `docs/verification/staging-smoke/<date>.md`:
- Total time from first upload to PDF ready
- Final page count (should be 12-18 for this case)
- Per-doc selectorRationale for the rating decision + DBQ (paste from the KeyDoc rows)
- Screenshots of the cover page + TOC + one selected source page
