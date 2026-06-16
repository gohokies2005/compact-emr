import { HttpError } from './errors.js';
import { classifyProviderError, PROVIDER_DOWN_MESSAGE, PROVIDER_BUSY_MESSAGE } from '../services/provider-status.js';

/**
 * Bridge the pure provider-status classifier (services/provider-status.ts) to an HTTP response, for the
 * user-triggered AI routes where a failure is SHOWN to a person (surgical edit, guided revision, etc.).
 *
 * Returns an HttpError to throw when the AI provider is genuinely DOWN (→ 503 + the calm plain-language
 * "retry in ~30 min, else tell your supervisor" message) or rate-limited (→ 429 + "busy, retrying"), so
 * the UI shows that instead of a scary generic error. Returns NULL for our-own errors / transient
 * network blips — the caller rethrows the original so a real bug isn't masked as "provider down".
 *
 * Kept OUT of provider-status.ts so that module stays HTTP-free (the drafter + Python-adjacent callers
 * use the classifier without pulling in the HTTP layer).
 */
export function providerErrorToHttp(err: unknown): HttpError | null {
  switch (classifyProviderError(err)) {
    case 'down':
      return new HttpError(503, 'provider_unavailable', PROVIDER_DOWN_MESSAGE, { retryAfterMinutes: 30 });
    case 'rate_limited':
      return new HttpError(429, 'provider_busy', PROVIDER_BUSY_MESSAGE);
    default:
      return null; // client_error / transient → not a provider outage; caller handles as before
  }
}
