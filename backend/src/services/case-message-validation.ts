// Validation for per-case RN<->physician messages. The body is CLINICAL communication — PHI
// (names, dates, symptoms) is expected and must NOT be stripped. Validate length + non-empty only.
import { badRequest, isRecord, requiredNonEmptyString } from './validation-helpers.js';

const MAX_BODY = 4000;

export function parseCaseMessageCreate(body: unknown): { body: string } {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return { body: requiredNonEmptyString(body, 'body', MAX_BODY) };
}

export function parseMarkRead(body: unknown): { upToMessageId: string | null } {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const v = body.upToMessageId;
  if (v !== undefined && v !== null && typeof v !== 'string') badRequest('upToMessageId must be a string', { field: 'upToMessageId' });
  return { upToMessageId: typeof v === 'string' ? v : null };
}
