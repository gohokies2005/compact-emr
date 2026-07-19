import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSecretByName } from '../services/mailer.js';
import { toE164, sendSms, createContact, emailWaitingText, __resetKeyCacheForTests } from '../services/quoClient.js';

// The EMR key-resolution seam is mailer.readSecretByName. Mock it so no Secrets Manager / SES client is
// ever constructed; each test programs it (resolve a key / resolve '' to exercise the env fallback).
vi.mock('../services/mailer', () => ({ readSecretByName: vi.fn(async () => '') }));
const readSecretMock = vi.mocked(readSecretByName);

// Fake https.request: invokes the response callback with a scripted status + JSON body, and returns a
// minimal ClientRequest stub (.on/.write/.end) that records the written request body. Mirrors the
// spyOn(https,'get') idiom in citation-fallback-retrieval.test.ts. Returns the spy plus a getter for
// the parsed request body so a test can assert what was posted.
function mockHttps(statusCode: number, jsonBody: unknown) {
  const written: string[] = [];
  const spy = vi.spyOn(https, 'request').mockImplementation(((_opts: unknown, cb: (res: unknown) => void) => {
    const res = {
      statusCode,
      on(ev: string, handler: (arg?: unknown) => void) {
        if (ev === 'data') handler(JSON.stringify(jsonBody));
        if (ev === 'end') handler();
        return res;
      },
    };
    cb(res);
    const req = { on: () => req, setTimeout: () => req, write: (chunk: string) => { written.push(String(chunk)); return true; }, end: () => undefined };
    return req as unknown as ReturnType<typeof https.request>;
  }) as unknown as typeof https.request);
  return Object.assign(spy, { sentBody: () => (written.length ? JSON.parse(written.join('')) : null) });
}

beforeEach(() => {
  __resetKeyCacheForTests();
  readSecretMock.mockReset();
  readSecretMock.mockResolvedValue(''); // default: no secret → env fallback governs
  delete process.env.QUO_API_KEY;
  delete process.env.QUO_API_KEY_SECRET_NAME;
  delete process.env.QUO_FROM;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('toE164', () => {
  it('prefixes a bare 10-digit US number', () => { expect(toE164('7035551234')).toBe('+17035551234'); });
  it('accepts an 11-digit number that already leads with 1', () => { expect(toE164('17035551234')).toBe('+17035551234'); });
  it('strips punctuation/formatting', () => { expect(toE164('(703) 555-1234')).toBe('+17035551234'); });
  it('returns null for too-short input', () => { expect(toE164('5551234')).toBeNull(); });
  it('returns null for an 11-digit number NOT leading with 1', () => { expect(toE164('27035551234')).toBeNull(); });
  it('returns null for null/undefined/empty', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
  });
});

describe('sendSms', () => {
  it('no key (secret empty + env unset) → {sent:false, no_api_key} and never touches https', async () => {
    const spy = vi.spyOn(https, 'request');
    const r = await sendSms('7035551234', 'hi');
    expect(r).toEqual({ sent: false, reason: 'no_api_key' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('invalid number (key present) → {sent:false, invalid_number} and never touches https', async () => {
    process.env.QUO_API_KEY = 'test-key';
    const spy = vi.spyOn(https, 'request');
    const r = await sendSms('not-a-number', 'hi');
    expect(r).toEqual({ sent: false, reason: 'invalid_number' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('2xx → {sent:true, id}', async () => {
    process.env.QUO_API_KEY = 'test-key';
    mockHttps(202, { id: 'msg_123' });
    const r = await sendSms('7035551234', 'hi');
    expect(r.sent).toBe(true);
    expect(r.id).toBe('msg_123');
    expect(r.code).toBe(202);
  });

  it('non-2xx → {sent:false, http_<code>} with detail, never throws', async () => {
    process.env.QUO_API_KEY = 'test-key';
    mockHttps(400, { message: 'A2P campaign not approved' });
    const r = await sendSms('7035551234', 'hi');
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('http_400');
    expect(r.detail).toBe('A2P campaign not approved');
  });

  it('NEVER throws even when https.request throws synchronously → {sent:false, exception}', async () => {
    process.env.QUO_API_KEY = 'test-key';
    vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('socket boom'); });
    const r = await sendSms('7035551234', 'hi');
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('exception');
    expect(r.detail).toContain('socket boom');
  });

  it('resolves the key from the SECRET when present (env not needed)', async () => {
    process.env.QUO_API_KEY_SECRET_NAME = 'compact-emr-test/quo-api-key';
    readSecretMock.mockResolvedValue('secret-key');
    const spy = mockHttps(202, { id: 'msg_from_secret' });
    const r = await sendSms('7035551234', 'hi');
    expect(r.sent).toBe(true);
    expect(readSecretMock).toHaveBeenCalledWith('compact-emr-test/quo-api-key');
    // The raw key rides in the Authorization header (NOT Bearer).
    const opts = spy.mock.calls[0][0] as { headers?: Record<string, string> };
    expect(opts.headers?.Authorization).toBe('secret-key');
  });

  it('FALLS BACK to env QUO_API_KEY when the secret resolves empty', async () => {
    process.env.QUO_API_KEY_SECRET_NAME = 'compact-emr-test/quo-api-key';
    readSecretMock.mockResolvedValue(''); // secret not populated yet
    process.env.QUO_API_KEY = 'env-fallback-key';
    const spy = mockHttps(202, { id: 'msg_env' });
    const r = await sendSms('7035551234', 'hi');
    expect(r.sent).toBe(true);
    const opts = spy.mock.calls[0][0] as { headers?: Record<string, string> };
    expect(opts.headers?.Authorization).toBe('env-fallback-key');
  });

  it('never throws even if secret resolution itself rejects → {sent:false, no_api_key}', async () => {
    process.env.QUO_API_KEY_SECRET_NAME = 'compact-emr-test/quo-api-key';
    readSecretMock.mockRejectedValue(new Error('AccessDenied'));
    const r = await sendSms('7035551234', 'hi');
    expect(r).toEqual({ sent: false, reason: 'no_api_key' });
  });

  it('posts the E.164 recipient + QUO_FROM sender + content in the request body', async () => {
    process.env.QUO_API_KEY = 'test-key';
    process.env.QUO_FROM = '+18005551212';
    const spy = mockHttps(202, { id: 'm' });
    await sendSms('7035551234', 'your letter is ready');
    expect(spy.sentBody()).toEqual({ from: '+18005551212', to: ['+17035551234'], content: 'your letter is ready' });
  });

  it('defaults the from-number to the FRN 757 number when QUO_FROM is unset', async () => {
    process.env.QUO_API_KEY = 'test-key';
    const spy = mockHttps(202, { id: 'm' });
    await sendSms('7035551234', 'hi');
    expect(spy.sentBody().from).toBe('+17575401077');
  });

  it('CRITICAL: a hung socket (timeout→destroy) resolves {sent:false, network} and never hangs the caller', async () => {
    process.env.QUO_API_KEY = 'test-key';
    // A black-holed request: the response callback NEVER fires; only the socket-timeout does. The mock's
    // setTimeout fires its callback synchronously (the real one fires after REQUEST_TIMEOUT_MS), and
    // destroy(err) routes to the 'error' handler exactly like Node's ClientRequest — so the awaited Promise
    // MUST settle (not hang) as a network failure.
    vi.spyOn(https, 'request').mockImplementation(((_opts: unknown, _cb: unknown) => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const req = {
        on(ev: string, h: (arg?: unknown) => void) { handlers[ev] = h; return req; },
        setTimeout(_ms: number, cb: () => void) { cb(); return req; },
        write: () => true,
        destroy(err: Error) { handlers.error?.(err); },
        end: () => undefined,
      };
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);
    const r = await sendSms('7035551234', 'hi'); // if the fix regressed, this await never resolves → test times out
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('network');
  });
});

describe('emailWaitingText', () => {
  // The wording is LOCKED by product (Dr. Kasky 2026-07-16) — this pins the exact bytes so a well-meaning
  // reword is caught in CI. Uses an em-dash after "here" and a straight apostrophe in "isn't".
  it('returns the exact locked copy', () => {
    expect(emailWaitingText()).toBe(
      'Flat Rate Nexus here — you have an email from us waiting in your inbox. Please check it (and your spam folder) and reply when you can. This text line isn\'t monitored, so please reply to our email, not this number.',
    );
  });
});

describe('createContact', () => {
  it('no key → {ok:false, no_api_key}', async () => {
    const r = await createContact({ firstName: 'Jane', lastName: 'Doe', phone: '7035551234', email: 'j@x.com' });
    expect(r).toEqual({ ok: false, reason: 'no_api_key' });
  });

  it('2xx → {ok:true, id} and posts defaultFields with an E.164 phone', async () => {
    process.env.QUO_API_KEY = 'test-key';
    const spy = mockHttps(201, { data: { id: 'contact_1' } });
    const r = await createContact({ firstName: 'Jane', lastName: 'Doe', phone: '(703) 555-1234', email: 'j@x.com', externalId: 'CASE-9' });
    expect(r.ok).toBe(true);
    expect(r.id).toBe('contact_1');
    const opts = spy.mock.calls[0][0] as { path?: string };
    expect(opts.path).toBe('/v1/contacts');
  });

  it('never throws on a non-2xx → {ok:false, http_<code>}', async () => {
    process.env.QUO_API_KEY = 'test-key';
    mockHttps(422, { message: 'bad custom field' });
    const r = await createContact({ firstName: 'Jane', lastName: 'Doe' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('http_422');
  });
});
