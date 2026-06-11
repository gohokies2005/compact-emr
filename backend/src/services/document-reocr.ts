/**
 * The re-OCR primitive (extracted from POST /documents/:id/reocr — keystone 4b makes the
 * case-level reprocess route a second caller, so both call ONE copy).
 *
 * Re-fires the deployed OCR pipeline by COPYING the S3 object onto itself
 * (MetadataDirective REPLACE) → a fresh ObjectCreated event → ocr-start → Textract → Claude
 * fallback. No extra Textract/Anthropic perms on the API; reuses everything already wired.
 */

import { CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export interface ReocrDocumentRef {
  readonly s3Key: string;
  readonly contentType?: string | null;
}

export async function nudgeDocumentReocr(s3: S3Client, bucketName: string, document: ReocrDocumentRef): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: bucketName,
    Key: document.s3Key,
    CopySource: `${bucketName}/${document.s3Key}`,
    MetadataDirective: 'REPLACE',
    ServerSideEncryption: 'aws:kms',
    ...(document.contentType ? { ContentType: document.contentType } : {}),
  }));
}
