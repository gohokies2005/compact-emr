import { badRequest, isRecord, optionalString, requiredNonEmptyString } from './validation-helpers.js';
import type { FileReadAttempt } from './db-types.js';

const VALID_METHODS = ['native_pdf_text', 'tesseract_ocr', 'claude_vision'] as const;
type ReadMethod = (typeof VALID_METHODS)[number];

const MAX_FILE_PATH_LEN = 500;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_TEXT_LEN = 5_000_000; // 5 MB UTF-8 cap

export interface ParsedReadAttempt {
  filePath: string;
  fileSha256: string;
  method: ReadMethod;
  extractedText: string;
  note: string | null;
}

/**
 * Parse a read-attempt payload posted by the OCR worker. The endpoint accepts the EXTRACTED
 * TEXT and computes the corrupted-token-ratio server-side — never trust client-side gating
 * decisions because the worker could be buggy or compromised.
 */
export function parseReadAttempt(body: unknown): ParsedReadAttempt {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const filePath = requiredNonEmptyString(body, 'filePath', MAX_FILE_PATH_LEN);
  const fileSha256 = requiredNonEmptyString(body, 'fileSha256', 64);
  if (!SHA256_PATTERN.test(fileSha256)) {
    badRequest('fileSha256 must be a lowercase hex SHA-256 (64 chars)', { field: 'fileSha256' });
  }
  const method = body['method'];
  if (typeof method !== 'string' || !(VALID_METHODS as readonly string[]).includes(method)) {
    badRequest(`method must be one of: ${VALID_METHODS.join(', ')}`, { field: 'method', allowed: VALID_METHODS });
  }
  const extractedText = body['extractedText'];
  if (typeof extractedText !== 'string') {
    badRequest('extractedText is required (string; may be empty if the worker got nothing)', { field: 'extractedText' });
  }
  if ((extractedText as string).length > MAX_TEXT_LEN) {
    badRequest(`extractedText exceeds ${MAX_TEXT_LEN} bytes`, { field: 'extractedText', max: MAX_TEXT_LEN });
  }

  return {
    filePath,
    fileSha256: fileSha256.toLowerCase(),
    method: method as ReadMethod,
    extractedText: extractedText as string,
    note: optionalString(body, 'note', 500),
  };
}

export interface ParsedManualSummary {
  summary: string;
}

const MAX_MANUAL_SUMMARY_LEN = 10_000;

export function parseManualSummary(body: unknown): ParsedManualSummary {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const summary = requiredNonEmptyString(body, 'summary', MAX_MANUAL_SUMMARY_LEN);
  if (summary.length < 40) {
    badRequest('summary must be at least 40 characters (FRN HARD RULE; manual interpretation must convey actual content)', { field: 'summary', min: 40 });
  }
  return { summary };
}

export type { ReadMethod };
export { VALID_METHODS as VALID_READ_METHODS };

// Re-export FileReadAttempt for downstream typing convenience.
export type { FileReadAttempt };
