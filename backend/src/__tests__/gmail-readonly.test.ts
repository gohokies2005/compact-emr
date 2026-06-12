import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same hoisted-mock shape as mailer-transport.test.ts: gmail-readonly.ts imports mailer.ts, which
// constructs its AWS clients at import time, so both SDK modules must be class-mocked up front.
const { sesSend, smSend } = vi.hoisted(() => ({
  sesSend: vi.fn(async () => ({ MessageId: 'ses-1' })),
  smSend: vi.fn(async () => ({
    SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'cs', refresh_token: 'rt', user: 'info@flatratenexus.com' }),
  })),
}));
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class { send = sesSend; },
  SendEmailCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = smSend; },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

import { listVeteranCorrespondence } from '../services/gmail-readonly.js';

const ENV_KEYS = ['GMAIL_OAUTH_SECRET_NAME'] as const;
const saved: Record<string, string | undefined> = {};

// Distinct marker strings so the PHI-logging test can assert NONE of them ever hits the console.
const SNIPPET_1 = 'MARKER-SNIPPET-my back pain got worse after the deployment';
const SUBJECT_1 = 'MARKER-SUBJECT-Re: your nexus letter records';
const SNIPPET_2 = 'MARKER-SNIPPET-we received your intake';
const SUBJECT_2 = 'MARKER-SUBJECT-Welcome to Flat Rate Nexus';

function meta(id: string, from: string, to: string, subject: string, snippet: string) {
  return {
    id,
    snippet,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Wed, 10 Jun 2026 14:03:00 -0700' },
      ],
    },
  };
}

/** Stub fetch for the full happy path: token mint + messages.list + 2 metadata fetches. */
function mockFetchHappy(vetEmail: string): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'at-ro', expires_in: 3600 }), text: async () => '' } as unknown as Response;
    }
    if (u.includes('/messages?')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }] }), text: async () => '' } as unknown as Response;
    }
    if (u.includes('/messages/m1')) {
      // Inbound: the veteran is the From side (mixed case on purpose — match must be case-insensitive).
      return { ok: true, status: 200, json: async () => meta('m1', `Vet Person <${vetEmail.toUpperCase()}>`, 'info@flatratenexus.com', SUBJECT_1, SNIPPET_1), text: async () => '' } as unknown as Response;
    }
    if (u.includes('/messages/m2')) {
      // Outbound: we wrote to the veteran.
      return { ok: true, status: 200, json: async () => meta('m2', 'Flat Rate Nexus <info@flatratenexus.com>', vetEmail, SUBJECT_2, SNIPPET_2), text: async () => '' } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}

describe('gmail-readonly listVeteranCorrespondence', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    smSend.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('token grant 401/unauthorized_client (scope not yet delegated) → degrades, never throws', async () => {
    // Distinct secret NAME (dodges readSecretByName's 60s name-keyed cache across tests) and a
    // distinct vetEmail (dodges this service's own 60s per-vetEmail cache).
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-401-test';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: false, status: 401, json: async () => ({}), text: async () => '{"error":"unauthorized_client"}' } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }));
    const r = await listVeteranCorrespondence('vet-401@example.com');
    expect(r).toEqual({ available: false, reason: 'workspace_scope_not_granted' });
  });

  it('happy path: list + 2 metadata fetches → direction + otherParty correct (SA-shaped secret)', async () => {
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-sa-test';
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ type: 'service_account', client_email: 'frn-gmail-delegate@flat-rate-nexus.iam.gserviceaccount.com', private_key: privateKey, user: 'info@flatratenexus.com' }),
    } as never);
    const vetEmail = 'vet-happy@example.com';
    const f = mockFetchHappy(vetEmail);

    const r = await listVeteranCorrespondence(vetEmail);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.messages).toHaveLength(2);
    const [m1, m2] = r.messages;
    expect(m1).toMatchObject({ id: 'm1', direction: 'inbound', otherParty: `Vet Person <${vetEmail.toUpperCase()}>`, subject: SUBJECT_1, snippet: SNIPPET_1 });
    expect(m2).toMatchObject({ id: 'm2', direction: 'outbound', otherParty: vetEmail, subject: SUBJECT_2, snippet: SNIPPET_2 });
    expect(m1.date).toContain('10 Jun 2026');

    // The list query is the spec'd encoded (from OR to) newer_than:2y window, metadata-only fetches.
    const listCall = f.mock.calls.find((c) => String(c[0]).includes('/messages?'));
    expect(String(listCall![0])).toContain(encodeURIComponent(`(from:${vetEmail} OR to:${vetEmail}) newer_than:2y`));
    expect(String(listCall![0])).toContain('maxResults=50');
    const metaCalls = f.mock.calls.filter((c) => /\/messages\/m[12]\?/.test(String(c[0])));
    expect(metaCalls).toHaveLength(2);
    for (const c of metaCalls) expect(String(c[0])).toContain('format=metadata');
    // NEVER full bodies.
    expect(f.mock.calls.some((c) => String(c[0]).includes('format=full'))).toBe(false);
  });

  it('Gmail 403 on messages.list (refresh-token credential without the readonly scope) → scope-not-granted', async () => {
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-403-test';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at-ro', expires_in: 3600 }), text: async () => '' } as unknown as Response;
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'insufficient scope' } as unknown as Response;
    }));
    const r = await listVeteranCorrespondence('vet-403@example.com');
    expect(r).toEqual({ available: false, reason: 'workspace_scope_not_granted' });
  });

  it('non-auth failure (network/5xx) → gmail_unreachable, never throws', async () => {
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-500-test';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at-ro', expires_in: 3600 }), text: async () => '' } as unknown as Response;
      }
      return { ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' } as unknown as Response;
    }));
    const r = await listVeteranCorrespondence('vet-500@example.com');
    expect(r).toEqual({ available: false, reason: 'gmail_unreachable' });
  });

  it('PHI-SAFETY: no snippet/subject/address ever reaches the console (counts only)', async () => {
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-phi-test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const vetEmail = 'vet-phi@example.com';
    mockFetchHappy(vetEmail);

    const r = await listVeteranCorrespondence(vetEmail);
    expect(r.available).toBe(true);

    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls, ...infoSpy.mock.calls]
      .flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n');
    expect(allOutput).not.toContain('MARKER-SNIPPET');
    expect(allOutput).not.toContain('MARKER-SUBJECT');
    expect(allOutput).not.toContain(vetEmail);
    // The count line IS expected (observability without PHI).
    expect(allOutput).toContain('gmail_readonly_listed');
    expect(allOutput).toContain('"count":2');
  });

  it('60s cache: a second call for the SAME vetEmail makes no further fetches', async () => {
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-ro-cache-test';
    const vetEmail = 'vet-cache@example.com';
    const f = mockFetchHappy(vetEmail);
    const r1 = await listVeteranCorrespondence(vetEmail);
    const callsAfterFirst = f.mock.calls.length;
    const r2 = await listVeteranCorrespondence(vetEmail);
    expect(r2).toEqual(r1);
    expect(f.mock.calls.length).toBe(callsAfterFirst);
  });
});
