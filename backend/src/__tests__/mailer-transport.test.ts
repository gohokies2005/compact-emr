import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the SES client so the SES branch is observable without AWS.
// vi.mock factories are hoisted above imports AND module-level consts — and mailer.ts constructs
// its clients at import time — so the spies must be hoisted too.
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

import { sendEmail } from '../services/mailer.js';

const ENV_KEYS = ['SES_FROM_ADDRESS', 'EMAIL_REDIRECT_ALL_TO', 'EMAIL_TRANSPORT', 'GMAIL_OAUTH_SECRET_NAME'] as const;
const saved: Record<string, string | undefined> = {};

function mockFetchOk(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3600 }), text: async () => '' } as unknown as Response;
    }
    return { ok: true, json: async () => ({ id: 'gmail-msg-1' }), text: async () => '' } as unknown as Response;
  });
  vi.stubGlobal('fetch', f);
  return f;
}

describe('mailer transport fork', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.SES_FROM_ADDRESS = 'info@flatratenexus.com';
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth';
    sesSend.mockClear();
    smSend.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
  });

  it('default (no EMAIL_TRANSPORT) → SES branch', async () => {
    const r = await sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B' });
    expect(r.sent).toBe(true);
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it('EMAIL_TRANSPORT=gmail → Gmail branch (token refresh + send), SES untouched', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    const f = mockFetchOk();
    const r = await sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B' });
    expect(r.sent).toBe(true);
    expect(r.messageId).toBe('gmail-msg-1');
    expect(sesSend).not.toHaveBeenCalled();
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    expect(sendCall).toBeDefined();
    // The RFC822 From header must be the OAuth user's mailbox.
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    expect(rfc).toContain('From: Flat Rate Nexus <info@flatratenexus.com>');
    expect(rfc).toContain('To: vet@example.com');
  });

  it('PHI-SAFETY: EMAIL_REDIRECT_ALL_TO is honored IN THE GMAIL BRANCH (architect plan-gate D3)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    process.env.EMAIL_REDIRECT_ALL_TO = 'info@flatratenexus.com';
    const f = mockFetchOk();
    const r = await sendEmail({ to: 'real-veteran@example.com', subject: 'Your nexus letter is ready', textBody: 'link only' });
    expect(r.sent).toBe(true);
    expect(r.redirectedFrom).toBe('real-veteran@example.com');
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    // Delivered to the staff inbox — NEVER the real veteran while the guard is on.
    expect(rfc).toContain('To: info@flatratenexus.com');
    expect(rfc).not.toContain('To: real-veteran@example.com');
    expect(rfc).toContain('[FWD to real-veteran@example.com]');
    expect(rfc).toContain('Forward this email to: real-veteran@example.com');
  });

  it('redirect drops the BCC (no duplicate to the same inbox family) — both branches', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    process.env.EMAIL_REDIRECT_ALL_TO = 'info@flatratenexus.com';
    const f = mockFetchOk();
    await sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B', bcc: 'admin@flatratenexus.com' });
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    expect(rfc).not.toContain('Bcc:');
  });

  it('gmail send failure throws with the status (caller breadcrumbs it; payment never rolls back)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3600 }), text: async () => '' } as unknown as Response;
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' } as unknown as Response;
    }));
    await expect(sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B' })).rejects.toThrow(/gmail transport: send failed \(403/);
  });

  it('missing/empty gmail secret throws loudly (never a silent no-op)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    // Distinct name — the suite-wide name is already in readSecretByName's 60s cache, which would
    // swallow this Once-mock and leak it into a later test.
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-empty-test';
    smSend.mockResolvedValueOnce({ SecretString: '' } as never);
    await expect(sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B' })).rejects.toThrow(/gmail transport/);
  });

  it('SERVICE-ACCOUNT secret shape → JWT-bearer grant impersonating the user (the primary credential)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    // Distinct secret NAME: readSecretByName caches by name for 60s, so reusing the suite-wide
    // name would serve the refresh-token JSON cached by earlier tests and skip the SA branch.
    process.env.GMAIL_OAUTH_SECRET_NAME = 'compact-emr-staging/gmail-oauth-sa-test';
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ type: 'service_account', client_email: 'frn-gmail-delegate@flat-rate-nexus.iam.gserviceaccount.com', private_key: privateKey, user: 'info@flatratenexus.com' }),
    } as never);
    const f = mockFetchOk();
    const r = await sendEmail({ to: 'vet@example.com', subject: 'S', textBody: 'B' });
    expect(r.sent).toBe(true);
    const tokenCall = f.mock.calls.find((c) => String(c[0]).includes('oauth2.googleapis.com'));
    const body = String((tokenCall![1] as { body: URLSearchParams }).body);
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(body).toContain('assertion=');
    // Decode the JWT claims: must impersonate the user with gmail.send scope.
    const assertion = new URLSearchParams(body).get('assertion')!;
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims.sub).toBe('info@flatratenexus.com');
    expect(claims.scope).toContain('gmail.send');
    expect(claims.iss).toContain('frn-gmail-delegate@');
  });

  it('To/Bcc addresses are CRLF-sanitized and shape-validated (intake-supplied data cannot inject headers)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    const f = mockFetchOk();
    await expect(sendEmail({ to: 'vet@example.com\r\nBcc: evil@example.com', subject: 'S', textBody: 'B' })).rejects.toThrow(/to address is not a valid email/);
    // A merely-whitespaced address is repaired, not rejected.
    await sendEmail({ to: ' vet@example.com ', subject: 'S', textBody: 'B' });
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    expect(rfc).toContain('To: vet@example.com');
  });

  it('non-ASCII subject is RFC 2047 B-encoded (legacy encodeSubject parity)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    const f = mockFetchOk();
    await sendEmail({ to: 'vet@example.com', subject: 'Payment received — your letter', textBody: 'B' });
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    const subjectLine = rfc.split('\r\n').find((l) => l.startsWith('Subject:'))!;
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(subjectLine.replace('Subject: =?UTF-8?B?', '').replace('?=', ''), 'base64').toString('utf8')).toBe('Payment received — your letter');
  });

  it('subject header newlines are stripped (header-injection guard)', async () => {
    process.env.EMAIL_TRANSPORT = 'gmail';
    const f = mockFetchOk();
    await sendEmail({ to: 'vet@example.com', subject: 'S\r\nBcc: evil@example.com', textBody: 'B' });
    const sendCall = f.mock.calls.find((c) => String(c[0]).includes('gmail.googleapis.com'));
    const raw = JSON.parse((sendCall![1] as { body: string }).body).raw as string;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    expect(rfc).toContain('Subject: S Bcc: evil@example.com');
    // No header LINE may start with the injected Bcc — it must stay inline in the subject text.
    expect(rfc.split('\r\n').some((l) => l.startsWith('Bcc:'))).toBe(false);
  });
});
