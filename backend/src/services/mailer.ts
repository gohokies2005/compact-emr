import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Outbound email via SES (Ryan chose SES over Resend — AWS-native, in the BAA). Plain-text only; the
// delivery email carries a portal link + password, never a PHI attachment. From = the verified SES
// identity (info@flatratenexus.com). No-ops loudly if SES_FROM_ADDRESS is unset (not yet configured).
const ses = new SESClient({});

/**
 * SES-SANDBOX FORWARDING MODE (Ryan 2026-06-10, until SES production access is granted — support
 * case 178094063100860): when EMAIL_REDIRECT_ALL_TO is set, EVERY outbound email is delivered to
 * that address instead of the real recipient (sandbox can deliver to any @flatratenexus.com because
 * the DOMAIN identity is verified). The subject is prefixed [FWD to <real recipient>] and a banner
 * is prepended to the body so staff forwards it manually (target: within a few hours). The original
 * body is untouched below the banner — strip the banner lines, forward, done.
 * To turn OFF after production access: clear `email_redirect_all_to` in infra/cdk.json and deploy.
 */
export async function sendEmail(input: { to: string; subject: string; textBody: string; bcc?: string }): Promise<{ sent: boolean; messageId?: string; reason?: string; redirectedFrom?: string }> {
  const from = process.env.SES_FROM_ADDRESS;
  if (!from) return { sent: false, reason: 'SES_FROM_ADDRESS not configured' };
  const redirect = (process.env.EMAIL_REDIRECT_ALL_TO ?? '').trim();
  const redirected = redirect.length > 0 && redirect.toLowerCase() !== input.to.trim().toLowerCase();
  const to = redirected ? redirect : input.to;
  const subject = redirected ? `[FWD to ${input.to}] ${input.subject}` : input.subject;
  const textBody = redirected
    ? `=== STAFF ACTION (SES sandbox) ===\nForward this email to: ${input.to}\nDelete these banner lines first. Target: within a few hours of receipt.\n===\n\n${input.textBody}`
    : input.textBody;
  const res = await ses.send(new SendEmailCommand({
    Source: from,
    // BCC dropped in redirect mode — the admin copy would just duplicate the same inbox family.
    Destination: { ToAddresses: [to], ...(!redirected && input.bcc ? { BccAddresses: [input.bcc] } : {}) },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: textBody, Charset: 'UTF-8' } },
    },
  }));
  return { sent: true, messageId: res.MessageId, ...(redirected ? { redirectedFrom: input.to } : {}) };
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
  } catch { return ''; }
}
