import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Guided-revision robustness (2026-06-24): unit-tests for the proposer's transient-resilience +
// clean failure classification. We mock @anthropic-ai/sdk so we can drive messages.create's
// outcome (success / max_tokens truncation / no tool_use / transient APIError after the SDK's own
// retries are exhausted / a non-retryable 400) WHILE keeping the REAL error classes so the
// proposer's `instanceof Anthropic.APIError / APIConnectionError` checks behave like production.

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  // The real default export is the Anthropic class (it also carries the error classes as static
  // members, e.g. Anthropic.APIError). We wrap it so messages.create is our controllable mock but
  // every static error class is preserved for instanceof.
  const RealAnthropic = actual.default;
  function MockAnthropic(this: unknown, opts: unknown) {
    void opts;
    (this as { messages: { create: typeof createMock } }).messages = { create: createMock };
  }
  // Preserve ALL static error classes (APIError, APIConnectionError, …). On this SDK build they are
  // INHERITED statics (resolved through the class's prototype chain, not own props), so copying own
  // descriptors misses them. Setting the prototype makes MockAnthropic.APIError resolve to the real
  // class — keeping the proposer's `instanceof Anthropic.APIError` checks valid under the mock.
  Object.setPrototypeOf(MockAnthropic, RealAnthropic);
  return { ...actual, default: MockAnthropic };
});

// Import AFTER the mock is registered so the proposer binds to the mocked SDK.
const { makeSurgicalProposer, isTransientAnthropicError, ProposerUnavailableError } = await import(
  '../services/letter-surgical-propose.js'
);
// The error classes are NAMED exports (this SDK build has no OverloadedError class — 529 is a plain
// APIError with status 529). The APIError ctor reads headers.get('request-id'), so pass a Headers.
const SDK = await import('@anthropic-ai/sdk');
const { APIError, APIConnectionError, BadRequestError } = SDK;
const HDRS = new Headers();

// Build a well-formed tool_use response the proposer can parse.
function okResponse(newText = 'revised passage') {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'propose_edit', input: { operation: 'replace', anchor_text: 'x', new_text: newText } }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

// A transient error the SDK would have already retried; reaching the proposer means it was exhausted.
// 529 (overloaded) is a plain APIError with status 529 in this SDK build.
function overloaded() {
  return new APIError(529, { type: 'overloaded_error' }, 'Overloaded', HDRS, 'overloaded_error');
}
function badRequest() {
  return new BadRequestError(400, { type: 'invalid_request_error' }, 'Bad request', HDRS, 'invalid_request_error');
}

beforeEach(() => { createMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('isTransientAnthropicError', () => {
  it('treats 429 / 529 / 5xx / connection errors as transient', () => {
    expect(isTransientAnthropicError(overloaded())).toBe(true); // 529
    const apiError = new APIError(503, { type: 'api_error' }, 'unavailable', HDRS, 'api_error');
    expect(isTransientAnthropicError(apiError)).toBe(true); // 5xx
    const conn = new APIConnectionError({ message: 'socket hang up' });
    expect(isTransientAnthropicError(conn)).toBe(true); // no status, connection
  });
  it('does NOT treat 400 / a plain Error as transient', () => {
    expect(isTransientAnthropicError(badRequest())).toBe(false);
    expect(isTransientAnthropicError(new Error('boom'))).toBe(false);
  });
});

describe('makeSurgicalProposer — resilience + failure classification', () => {
  it('returns a proposal on a clean tool_use response', async () => {
    createMock.mockResolvedValueOnce(okResponse('the tightened passage'));
    const propose = makeSurgicalProposer('sk-ant-test');
    const out = await propose({ instruction: 'tighten', letterText: 'L', mode: 'guided_revision', passage: 'orig' });
    expect(out.proposal).toEqual({ operation: 'replace', anchor_text: 'orig', new_text: 'the tightened passage' });
    expect(out.model).toBe('claude-opus-4-8');
  });

  it('SUCCEEDS after a simulated transient error THEN a good response (SDK-style retry surfaced by a re-call)', async () => {
    // The SDK normally retries internally; here we simulate the *effect* by having the underlying
    // create reject once (as if all internal retries failed) then a second propose() succeeding —
    // proving the proposer surfaces a clean retry path rather than a generic failure. A direct
    // single-call retry is owned by the SDK (maxRetries:4); this asserts the recover-on-retry shape.
    createMock.mockRejectedValueOnce(overloaded());
    const propose = makeSurgicalProposer('sk-ant-test');
    await expect(propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' })).rejects.toMatchObject({ detail: 'model_unavailable' });
    createMock.mockResolvedValueOnce(okResponse('ok now'));
    const out = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' });
    expect(out.proposal.new_text).toBe('ok now');
  });

  it('classifies an exhausted transient error as model_unavailable (not a generic throw)', async () => {
    createMock.mockRejectedValueOnce(overloaded());
    const propose = makeSurgicalProposer('sk-ant-test');
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposerUnavailableError);
    expect((err as InstanceType<typeof ProposerUnavailableError>).detail).toBe('model_unavailable');
  });

  it('does NOT dress up a non-retryable 400 as model_unavailable (re-throws the original)', async () => {
    createMock.mockRejectedValueOnce(badRequest());
    const propose = makeSurgicalProposer('sk-ant-test');
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProposerUnavailableError);
    expect((err as { status?: number }).status).toBe(400);
  });

  it('classifies a max_tokens truncation as passage_too_complex', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: 'propose_edit', input: {} }], usage: { input_tokens: 100, output_tokens: 1500 } });
    const propose = makeSurgicalProposer('sk-ant-test');
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ProposerUnavailableError>).detail).toBe('passage_too_complex');
  });

  it('classifies a missing tool_use block as no_change_proposed', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry' }], usage: { input_tokens: 100, output_tokens: 5 } });
    const propose = makeSurgicalProposer('sk-ant-test');
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ProposerUnavailableError>).detail).toBe('no_change_proposed');
  });

  it('classifies an empty new_text as no_change_proposed', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'propose_edit', input: { operation: 'replace', anchor_text: 'x', new_text: '' } }], usage: { input_tokens: 100, output_tokens: 5 } });
    const propose = makeSurgicalProposer('sk-ant-test');
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: 'p' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ProposerUnavailableError>).detail).toBe('no_change_proposed');
  });

  it('flags passageTooLong on the failure detail for a very long passage', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: 'propose_edit', input: {} }], usage: { input_tokens: 100, output_tokens: 1500 } });
    const propose = makeSurgicalProposer('sk-ant-test');
    const longPassage = 'a'.repeat(2000);
    const err = await propose({ instruction: 'x', letterText: 'L', mode: 'guided_revision', passage: longPassage }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ProposerUnavailableError>).passageTooLong).toBe(true);
  });
});
