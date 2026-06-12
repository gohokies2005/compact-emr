import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Outbound email. TWO transports behind ONE function (Ryan 2026-06-11, SES production access
// DENIED — case 178094063100860):
//   EMAIL_TRANSPORT=gmail → Gmail API as info@flatratenexus.com (BAA-covered under the Google
//                           Workspace agreement; the SAME OAuth grant the legacy FRN system sends
//                           all templates with). Creds read at RUNTIME from Secrets Manager
//                           (GMAIL_OAUTH_SECRET_NAME) — never env-injected (audit INF-2).
//   anything else        → SES (sandbox; kept as the fallback + the path if the appeal succeeds).
// Plain-text only; the delivery email carries a portal link ONLY — no password, no PHI attachment.
const ses = new SESClient({});

/**
 * FORWARDING MODE (Ryan 2026-06-10): when EMAIL_REDIRECT_ALL_TO is set, EVERY outbound email is
 * delivered to that address instead of the real recipient, with a [FWD to <real recipient>]
 * subject prefix + staff banner. TRANSPORT-AGNOSTIC BY CONSTRUCTION: the redirect is computed
 * BEFORE the transport fork below, so the gmail branch can never leak a real send while the
 * guard is on (architect plan-gate item D3 — the highest-consequence wiring detail).
 * To turn OFF: clear `email_redirect_all_to` in infra/cdk.json and deploy.
 */
export async function sendEmail(input: { to: string; subject: string; textBody: string; bcc?: string }): Promise<{ sent: boolean; messageId?: string; reason?: string; redirectedFrom?: string }> {
  const from = process.env.SES_FROM_ADDRESS;
  if (!from) return { sent: false, reason: 'SES_FROM_ADDRESS not configured' };
  // ── 1. Redirect guard (before ANY transport decision) ──
  const redirect = (process.env.EMAIL_REDIRECT_ALL_TO ?? '').trim();
  const redirected = redirect.length > 0 && redirect.toLowerCase() !== input.to.trim().toLowerCase();
  const to = redirected ? redirect : input.to;
  const subject = redirected ? `[FWD to ${input.to}] ${input.subject}` : input.subject;
  const textBody = redirected
    ? `=== STAFF ACTION (forwarding mode) ===\nForward this email to: ${input.to}\nDelete these banner lines first. Target: within a few hours of receipt.\n===\n\n${input.textBody}`
    : input.textBody;
  // BCC dropped in redirect mode — the admin copy would just duplicate the same inbox family.
  const bcc = !redirected ? input.bcc : undefined;

  // ── 2. Transport fork ──
  if ((process.env.EMAIL_TRANSPORT ?? '').trim().toLowerCase() === 'gmail') {
    const messageId = await gmailSend({ from, to, subject, textBody, bcc });
    return { sent: true, messageId, ...(redirected ? { redirectedFrom: input.to } : {}) };
  }
  const res = await ses.send(new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to], ...(bcc ? { BccAddresses: [bcc] } : {}) },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: textBody, Charset: 'UTF-8' } },
    },
  }));
  return { sent: true, messageId: res.MessageId, ...(redirected ? { redirectedFrom: input.to } : {}) };
}

// ── Gmail transport ───────────────────────────────────────────────────────────────────────────
// TWO supported secret JSON shapes (auto-detected):
//   SERVICE-ACCOUNT (preferred — Workspace domain-wide delegation; never expires, survives
//   password changes): the full SA key JSON (client_email + private_key + …) PLUS a "user" field
//   naming the mailbox to impersonate ("info@flatratenexus.com"). This is the frn-gmail-delegate
//   key Ryan authorized 2026-06-10 — verified live for info@ gmail.send before this shipped.
//   REFRESH-TOKEN (legacy fallback): {"client_id","client_secret","refresh_token","user"}.
//   NOTE 2026-06-11: the .env info@ refresh token was found DEAD (invalid_grant — revoked when
//   delegation was set up), which is why the SA path is primary.
// The From header MUST be the impersonated/OAuth user's mailbox (or a verified send-as alias) —
// Gmail silently rewrites or rejects anything else. SES_FROM_ADDRESS and "user" are both info@.
import { sign as cryptoSign } from 'node:crypto';

interface GmailSecret {
  user?: string;
  // refresh-token shape
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  // service-account shape
  client_email?: string;
  private_key?: string;
}

// Cache is bound to the SECRET BYTES that minted it — a rotated/repopulated secret takes effect
// within readSecretByName's 60s TTL instead of riding a stale access token to its expiry.
let gmailAccessToken: { token: string; exp: number; secretRaw: string } | null = null;

async function gmailAccess(): Promise<{ token: string; user: string }> {
  const raw = await readSecretByName(process.env.GMAIL_OAUTH_SECRET_NAME);
  if (!raw) throw new Error('gmail transport: GMAIL_OAUTH_SECRET_NAME secret is empty or unreadable');
  let cfg: GmailSecret;
  try { cfg = JSON.parse(raw) as GmailSecret; } catch {
    throw new Error('gmail transport: secret is not valid JSON — was it populated after deploy? (CDK seeds a random placeholder)');
  }
  if (!cfg.user) throw new Error('gmail transport: secret JSON missing "user" (the mailbox to send as)');
  if (gmailAccessToken !== null && gmailAccessToken.exp > Date.now() && gmailAccessToken.secretRaw === raw) {
    return { token: gmailAccessToken.token, user: cfg.user };
  }

  let body: URLSearchParams;
  if (cfg.private_key && cfg.client_email) {
    // Service-account JWT-bearer grant, impersonating cfg.user via domain-wide delegation.
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: cfg.client_email,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      aud: 'https://oauth2.googleapis.com/token',
      sub: cfg.user,
      iat: now,
      exp: now + 300,
    })}`;
    const sig = cryptoSign('RSA-SHA256', Buffer.from(unsigned), cfg.private_key).toString('base64url');
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` });
  } else if (cfg.client_id && cfg.client_secret && cfg.refresh_token) {
    body = new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    });
  } else {
    throw new Error('gmail transport: secret JSON is neither a service-account key (client_email+private_key) nor a refresh-token grant (client_id+client_secret+refresh_token)');
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`gmail transport: token grant failed (${r.status} ${await r.text().then((t) => t.slice(0, 200)).catch(() => '')})`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('gmail transport: token response had no access_token');
  // Cache to ~80% of the granted lifetime (typ. 3600s) so a warm Lambda never sends with a stale token.
  gmailAccessToken = { token: j.access_token, exp: Date.now() + Math.floor((j.expires_in ?? 3600) * 0.8) * 1000, secretRaw: raw };
  return { token: j.access_token, user: cfg.user };
}

/** RFC 2047 B-encode a subject when it carries non-ASCII (ported from the proven legacy
 * gmail.js encodeSubject — em-dash subjects would otherwise ship as raw UTF-8 in a header). */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

/** Address fields come from intake-supplied data (vet.email) — strip CRLF + spaces so a crafted
 * value can never inject headers into the raw RFC822 message, and sanity-check the shape. */
function safeAddr(addr: string, field: string): string {
  const v = addr.replace(/[\r\n\s]+/g, '');
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(v)) throw new Error(`gmail transport: ${field} address is not a valid email`);
  return v;
}

async function gmailSend(input: { from: string; to: string; subject: string; textBody: string; bcc?: string }): Promise<string | undefined> {
  const { token } = await gmailAccess();
  const rfc822 = [
    `From: Flat Rate Nexus <${safeAddr(input.from, 'from')}>`,
    `To: ${safeAddr(input.to, 'to')}`,
    ...(input.bcc ? [`Bcc: ${safeAddr(input.bcc, 'bcc')}`] : []),
    `Subject: ${encodeSubject(input.subject.replace(/[\r\n]+/g, ' '))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.textBody,
  ].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(rfc822, 'utf8').toString('base64url') }),
  });
  if (!r.ok) throw new Error(`gmail transport: send failed (${r.status} ${await r.text().then((t) => t.slice(0, 200)).catch(() => '')})`);
  const j = (await r.json()) as { id?: string };
  return j.id;
}

// Runtime read of a Secrets Manager secret BY FRIENDLY NAME (never partial ARN — the AccessDenied
// footgun). Cached per-process with a SHORT TTL: the Stripe webhook signing secret is populated AFTER
// deploy and can be ROTATED (e.g. cutover from test→live whsec_); an unbounded cache meant a warm
// Lambda kept a stale secret forever → every live webhook 400s on signature mismatch. A 60s TTL lets a
// rotated secret take effect without a redeploy, at the cost of one extra GetSecretValue per minute.
const secrets = new SecretsManagerClient({});
const SECRET_TTL_MS = 60_000;
const cache = new Map<string, { val: string; exp: number }>();
export async function readSecretByName(name: string | undefined): Promise<string> {
  if (!name) return '';
  const hit = cache.get(name);
  if (hit !== undefined && hit.exp > Date.now()) return hit.val;
  try {
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const val = r.SecretString ?? '';
    if (val) cache.set(name, { val, exp: Date.now() + SECRET_TTL_MS });
    return val;
  } catch (e) {
    // NEVER swallow silently — AccessDenied vs missing vs throttling must be distinguishable in
    // CloudWatch (the 2026-06-05 masked-AccessDenied incident class). Still returns '' (fail-soft).
    console.error(JSON.stringify({ msg: 'secret_read_failed', name, error: e instanceof Error ? e.message : String(e) }));
    return '';
  }
}
