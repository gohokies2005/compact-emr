import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Outbound email via SES (Ryan chose SES over Resend — AWS-native, in the BAA). Plain-text only; the
// delivery email carries a portal link + password, never a PHI attachment. From = the verified SES
// identity (info@flatratenexus.com). No-ops loudly if SES_FROM_ADDRESS is unset (not yet configured).
const ses = new SESClient({});

export async function sendEmail(input: { to: string; subject: string; textBody: string; bcc?: string }): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
  const from = process.env.SES_FROM_ADDRESS;
  if (!from) return { sent: false, reason: 'SES_FROM_ADDRESS not configured' };
  const res = await ses.send(new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [input.to], ...(input.bcc ? { BccAddresses: [input.bcc] } : {}) },
    Message: {
      Subject: { Data: input.subject, Charset: 'UTF-8' },
      Body: { Text: { Data: input.textBody, Charset: 'UTF-8' } },
    },
  }));
  return { sent: true, messageId: res.MessageId };
}

// Runtime read of a Secrets Manager secret BY FRIENDLY NAME (never partial ARN — the AccessDenied
// footgun). Cached per-process. Used for the Stripe webhook signing secret, which the operator
// populates AFTER deploy, so it can't be a deploy-time env injection.
const secrets = new SecretsManagerClient({});
const cache = new Map<string, string>();
export async function readSecretByName(name: string | undefined): Promise<string> {
  if (!name) return '';
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  try {
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const val = r.SecretString ?? '';
    if (val) cache.set(name, val);
    return val;
  } catch { return ''; }
}
