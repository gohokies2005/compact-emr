// Provider-status classifier (2026-06-16) — the contract that matters: a provider OUTAGE (5xx/529/named
// Bedrock outage) is 'down', but OUR errors (4xx) and OUR rate-limit (429) are NEVER 'down'. This is the
// "only when actually down, not confounded" guarantee, pinned.
import { describe, it, expect } from 'vitest';
import { classifyProviderError, isProviderDown, PROVIDER_DOWN_MESSAGE } from '../services/provider-status.js';

describe('classifyProviderError', () => {
  it('Anthropic 529 overloaded → down', () => {
    expect(classifyProviderError({ status: 529 })).toBe('down');
    expect(isProviderDown({ status: 529 })).toBe(true);
  });
  it('5xx (500/502/503) → down', () => {
    for (const s of [500, 502, 503]) expect(classifyProviderError({ status: s })).toBe('down');
  });
  it('Bedrock named outage exceptions → down', () => {
    expect(classifyProviderError({ name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } })).toBe('down');
    expect(classifyProviderError({ name: 'InternalServerException' })).toBe('down');
    expect(classifyProviderError({ name: 'ModelTimeoutException' })).toBe('down');
  });
  it('429 / Throttling → rate_limited, NOT down (our throttle, not an outage)', () => {
    expect(classifyProviderError({ status: 429 })).toBe('rate_limited');
    expect(classifyProviderError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } })).toBe('rate_limited');
    expect(isProviderDown({ status: 429 })).toBe(false);
  });
  it('4xx client errors → client_error, NEVER down (our bug)', () => {
    for (const s of [400, 401, 403, 413, 422]) {
      expect(classifyProviderError({ status: s })).toBe('client_error');
      expect(isProviderDown({ status: s })).toBe(false);
    }
  });
  it('network/timeout → transient (not down on its own)', () => {
    expect(classifyProviderError({ name: 'AbortError' })).toBe('transient');
    expect(classifyProviderError({ code: 'ECONNRESET' })).toBe('transient');
    expect(classifyProviderError(new Error('socket timeout'))).toBe('transient');
    expect(isProviderDown({ code: 'ECONNRESET' })).toBe(false);
  });
  it('the user message is plain, role-based (no names), and points to a ~30 min retry', () => {
    expect(PROVIDER_DOWN_MESSAGE).toMatch(/30 minutes/);
    expect(PROVIDER_DOWN_MESSAGE).toMatch(/supervisor or system administrator/);
    expect(PROVIDER_DOWN_MESSAGE).not.toMatch(/Dr\.|Ryan|Kasky/);
  });
});
