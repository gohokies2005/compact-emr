import { HttpError } from '../http/errors.js';

const MAX_BODY = 5000;

function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, 'bad_request', message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Chart notes are PHI by nature, so there is NO PHI-pattern rejection here — only trim + length + non-empty.
function parseBody(body: Record<string, unknown>): string {
  const value = body.body;
  if (typeof value !== 'string') badRequest('body is required', { field: 'body' });
  const trimmed = value.trim();
  if (trimmed.length === 0) badRequest('body cannot be empty', { field: 'body' });
  if (trimmed.length > MAX_BODY) badRequest('body is too long', { field: 'body', maxLength: MAX_BODY });
  return trimmed;
}

export function parseChartNoteCreate(body: unknown): { body: string } {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return { body: parseBody(body) };
}

export function parseChartNotePatch(body: unknown): { version: number; body: string } {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const version = body.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) badRequest('version must be a positive integer', { field: 'version' });
  return { version, body: parseBody(body) };
}
