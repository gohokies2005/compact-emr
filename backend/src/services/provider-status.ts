/**
 * Provider-status classifier (Ryan 2026-06-16) — tell when the AI provider is ACTUALLY down vs. a
 * confounder, so we only show "servers down, retry later" when it's genuinely an outage.
 *
 * The whole point is to NOT confound: a 400 (our bad payload) or a 429 (our rate limit) must NEVER
 * render as "the provider is down." We key strictly on the error code/exception type:
 *   - DOWN          → 5xx / 529 overloaded / Bedrock ServiceUnavailable·InternalServer·ModelTimeout.
 *                     The ONLY class that earns the user-facing "retry in ~30 min" message (and, when a
 *                     caller wants certainty, a confirming 1-token health probe before showing it).
 *   - RATE_LIMITED  → 429 / Bedrock Throttling. WE are being throttled, not an outage → back off; a
 *                     different, quieter message ("busy, retrying"), never the scary banner.
 *   - CLIENT_ERROR  → other 4xx (bad request / auth / too large). OUR bug — never "down", never a
 *                     veteran-facing retry; surfaces as a real error to fix.
 *   - TRANSIENT     → network/timeout/unknown. Could be the provider; retry, and a caller MAY probe to
 *                     decide if it's really DOWN. Not shown as "down" on its own.
 *
 * Works for BOTH providers: the Anthropic SDK throws APIError-likes with a numeric `.status`; the AWS
 * Bedrock SDK throws with `.name` (e.g. 'ThrottlingException') + `$metadata.httpStatusCode`.
 */

export type ProviderFailure = 'down' | 'rate_limited' | 'client_error' | 'transient';

// Plain-language, role-based (no personal names — positions change). Calm, bold-not-red at the UI layer.
export const PROVIDER_DOWN_MESSAGE =
  'Our AI service is temporarily unavailable. Please try again in about 30 minutes. If it keeps ' +
  'happening, let your supervisor or system administrator know.';

export const PROVIDER_BUSY_MESSAGE =
  'The AI service is busy right now. This will retry automatically in a few moments.';

function httpStatusOf(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    const meta = e.$metadata?.httpStatusCode;
    if (typeof meta === 'number') return meta;
  }
  return null;
}

function nameOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown };
    if (typeof e.name === 'string') return e.name;
    if (typeof e.code === 'string') return e.code;
  }
  return '';
}

/**
 * Classify a thrown provider error. Pure; never throws. DOWN is the only class that should drive the
 * user-facing outage message — and a caller wanting certainty should confirm DOWN with a health probe
 * (a single tiny call to the SAME provider) before showing it, to separate "this one call hiccuped"
 * from "the provider is down."
 */
export function classifyProviderError(err: unknown): ProviderFailure {
  const status = httpStatusOf(err);
  const name = nameOf(err);

  // Rate limit FIRST (a 429 is OUR throttle, never an outage) — distinct, quieter handling.
  if (status === 429 || /throttl/i.test(name) || /rate.?limit/i.test(name)) return 'rate_limited';

  // Provider down / overloaded — server-side 5xx + the named Bedrock/Anthropic outage exceptions.
  if (
    status === 529 || status === 503 || status === 502 || status === 500 ||
    /overloaded|serviceunavailable|internalserver|modeltimeout|service_unavailable/i.test(name)
  ) {
    return 'down';
  }

  // Other 4xx = OUR problem (bad request / auth / payload too large) — never "down".
  if (status !== null && status >= 400 && status < 500) return 'client_error';

  // Network / timeout / unknown → transient (a caller may probe to decide if it's really down).
  if (/aborterror|timeout|econnreset|etimedout|enotfound|econnrefused|connection/i.test(name)) return 'transient';
  return 'transient';
}

/** True only for a genuine provider outage — the gate for the user-facing "retry in ~30 min" message. */
export function isProviderDown(err: unknown): boolean {
  return classifyProviderError(err) === 'down';
}
