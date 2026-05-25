# Phase 3A-2 Summary — Document presigned URL flow

## Files touched

Changed/added files in this patch package:

- `backend/src/routes/documents.ts` — document metadata, presign, download, and delete routes.
- `backend/src/__tests__/documents.test.ts` — route tests with mocked Prisma and S3/presigner clients.
- `backend/package.json` — adds `@aws-sdk/s3-request-presigner` dependency required for S3 presigned URLs.
- `docs/verification/phase3A2-evidence/*` — verification notes/output.
- `phase3A2.patch` — unified patch for review/application against current main.

## Explicitly skipped

- No UI changes; those ship in Phase 3B.
- No database migration; the existing `documents` table already supports this flow.
- No broad CDK rewrite. The current API stack already grants `phiBucket.grantReadWrite(handler)` and `documentsKey.grantEncryptDecrypt(handler)` and provides `PHI_BUCKET_NAME`; if current main lacks proxy API routing after 3A-1, add the existing Lambda integration to `/api/v1/{proxy+}` before deploying.

## Assumptions

- Since `Document.caseId` is required by the Prisma schema, the veteran document upload endpoints require `caseId` in the presign and metadata-create bodies, then validate that the case belongs to the veteran.
- Uploads are direct-to-S3 only. Lambda never receives document bytes.
- Presigned PUT forces `x-amz-server-side-encryption: aws:kms`; bucket default KMS key controls the actual key.

## Tests

- Added route tests for unauthenticated rejection, list, presign success, max-size rejection, metadata activity logging, and admin-only delete.
- Evidence is in `docs/verification/phase3A2-evidence/`.

## Ryan should test first

1. Confirm API Gateway has proxy routing for `/api/v1/*` after 3A-1.
2. Create a test case for a veteran, presign a small PDF, upload to S3, then record metadata.
3. Verify `activity_log` rows show `document_created` and `document_deleted` with IDs only, no PHI.
