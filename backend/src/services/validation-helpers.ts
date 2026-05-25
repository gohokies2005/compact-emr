import { HttpError } from '../http/errors.js';

/**
 * Shared validation primitives used by every `*-validation.ts` file in this directory.
 *
 * Extracted Phase 5.1 (architect QA REVIEW.md ¶3): six validators inline-duplicated these
 * helpers. Centralize so a future tightening (e.g. rejecting `Date` instances or arrays from
 * the body) updates one place, not six.
 *
 * Keep this file minimal — only the truly identical primitives. Validator-family-specific
 * helpers (e.g. PHI-pattern rejection in case-validation) stay in their own files so future
 * divergence does not become a shared-helper concern.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, 'bad_request', message, details);
}

export function requiredNonEmptyString(body: Record<string, unknown>, field: string, max?: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} is required`, { field });
  }
  const trimmed = (value as string).trim();
  if (max !== undefined && trimmed.length > max) {
    badRequest(`${field} exceeds maximum length of ${max} characters`, { field, max });
  }
  return trimmed;
}

export function optionalString(body: Record<string, unknown>, field: string, max?: number): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    badRequest(`${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (max !== undefined && trimmed.length > max) {
    badRequest(`${field} exceeds maximum length of ${max} characters`, { field, max });
  }
  return trimmed;
}
