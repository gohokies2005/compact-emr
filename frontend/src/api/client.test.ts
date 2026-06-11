import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { describeApiError, ForbiddenError, ConflictError, ServiceUnavailableError } from './client';

// describeApiError must surface the REAL reason (status + server message), never a canned guess —
// the redraft/draft endpoints' HttpErrors are not logged server-side, so this string is often the
// only place the failure reason ever appears (Ryan: "every catch must surface the real reason").
function axiosErrorWith(status: number, serverMessage?: string): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_RESPONSE');
  err.response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: serverMessage === undefined ? {} : { error: { message: serverMessage } },
  };
  return err;
}

describe('describeApiError', () => {
  it('surfaces the server status AND the server error.message for a 404', () => {
    expect(describeApiError(axiosErrorWith(404, 'Case not found'))).toBe('server returned 404: Case not found');
  });

  it('surfaces status alone when the server sends no message body', () => {
    expect(describeApiError(axiosErrorWith(500))).toBe('server returned 500');
  });

  it('reports a network failure (no response) distinctly', () => {
    const err = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(describeApiError(err)).toContain('could not reach the server');
  });

  it('maps typed errors to their cause without leaking internals', () => {
    expect(describeApiError(new ForbiddenError())).toContain('403');
    expect(describeApiError(new ServiceUnavailableError())).toContain('503');
    expect(describeApiError(new ConflictError())).toContain('409');
  });

  // Sign-off incident 2026-06-09: the approve 409's precise signer-name-gate message was thrown
  // away by the interceptor (ConflictError carried only details), so the physician saw a generic
  // guess and an hour was lost. ConflictError now carries the envelope's message + code and
  // describeApiError must surface it VERBATIM.
  it('surfaces the server message verbatim on a ConflictError that carries one', () => {
    const gateMessage = 'Cannot approve: the letter does not name the assigned signing physician (Jane A. Doe, MD).';
    const err = new ConflictError({ reason: 'signer_name_absent' }, gateMessage, 'conflict');
    expect(describeApiError(err)).toBe(`server returned 409: ${gateMessage}`);
    expect(err.serverCode).toBe('conflict');
    expect(err.current).toEqual({ reason: 'signer_name_absent' });
  });

  it('keeps the canned 409 fallback ONLY when the server sent no/blank message', () => {
    expect(describeApiError(new ConflictError(undefined))).toBe('the case changed or a job is already running (409)');
    expect(describeApiError(new ConflictError(undefined, '   '))).toBe('the case changed or a job is already running (409)');
  });

  it('falls back to a plain Error message, then to a generic string', () => {
    expect(describeApiError(new Error('boom'))).toBe('boom');
    expect(describeApiError({})).toBe('unknown error');
  });
});
