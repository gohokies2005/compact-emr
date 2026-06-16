// QA C1 guard: providerErrorToHttp must map ONLY real Anthropic SDK errors. An AWS-shaped error
// (S3/Cognito/SES/Bedrock) with the same .status/.name shape must NOT be mis-tagged "AI unavailable".
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { providerErrorToHttp } from '../http/provider-error.js';

describe('providerErrorToHttp — domain gate (C1)', () => {
  it('an AWS-shaped 503 (ServiceUnavailable) → null (NOT provider_unavailable)', () => {
    expect(providerErrorToHttp({ name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } })).toBeNull();
  });
  it('an AWS-shaped 429 (ThrottlingException) → null (NOT provider_busy)', () => {
    expect(providerErrorToHttp({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } })).toBeNull();
  });
  it('a plain Error → null', () => {
    expect(providerErrorToHttp(new Error('something broke'))).toBeNull();
  });
  it('an Anthropic APIError 529 → 503 provider_unavailable', () => {
    const err = new Anthropic.APIError(529, undefined, 'overloaded', undefined);
    const mapped = providerErrorToHttp(err);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe('provider_unavailable');
  });
  it('an Anthropic APIError 429 → 429 provider_busy', () => {
    const err = new Anthropic.APIError(429, undefined, 'rate limited', undefined);
    expect(providerErrorToHttp(err)?.code).toBe('provider_busy');
  });
  it('an Anthropic APIError 400 (our bad request) → null (never "down")', () => {
    const err = new Anthropic.APIError(400, undefined, 'bad request', undefined);
    expect(providerErrorToHttp(err)).toBeNull();
  });
});
