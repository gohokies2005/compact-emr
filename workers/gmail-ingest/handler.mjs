// gmail-ingest — Feature B inbound email poller (Ryan 2026-06-06). STAGED / NOT YET WIRED INTO CDK.
// Pulls new mail from Google Workspace mailboxes (domain-wide delegation) and POSTs each message to the
// EMR internal ingest route, which dedupes (Message-ID) + matches the veteran + stores raw/attachments.
//
// ⚠️ NEEDS LIVE VERIFICATION against a real Workspace before enabling — it has not been run. See README.
//
// SELF-GATES: if the monitored-mailbox list (SSM) is empty OR the service-account secret is the
// placeholder, it logs "not configured" and returns — safe to deploy idle.
//
// WHY THIS SHAPE: the heavy/variable Gmail I/O lives here (thin); the dedupe + veteran-match + insert
// (the part worth testing) lives in the EMR route POST /internal/emails/ingest (unit-tested in TS).
// "Easily add staff emails" = just add an address to the SSM StringList; one service account with
// domain-wide delegation impersonates any mailbox in the domain (no per-mailbox OAuth).

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { JWT } from 'google-auth-library';
import { createHash } from 'node:crypto';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const s3 = new S3Client({});

const deriveEmailId = (messageId) => `eml_${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;

async function getMailboxes() {
  const name = process.env.MONITORED_MAILBOXES_PARAM; // SSM StringList, operator-edited
  if (!name) return [];
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    return (r.Parameter?.Value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
}

async function getServiceAccount() {
  // Read by FRIENDLY NAME, never partial ARN (the Secrets-Manager partial-ARN AccessDenied footgun).
  const name = process.env.GMAIL_SA_SECRET_NAME;
  if (!name) return null;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  try {
    const sa = JSON.parse(r.SecretString ?? '{}');
    if (!sa.client_email || !sa.private_key || sa.private_key.includes('PLACEHOLDER')) return null;
    return sa;
  } catch { return null; }
}

function header(payload, name) {
  const h = (payload?.headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}
function b64urlToBuf(data) { return Buffer.from((data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// Walk the MIME tree → { body, attachments: [{filename, data, contentType}] }.
function extractParts(payload) {
  let body = '';
  const attachments = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) attachments.push({ filename: p.filename, attachmentId: p.body.attachmentId, contentType: p.mimeType });
    else if (p.mimeType === 'text/plain' && p.body?.data && !body) body = b64urlToBuf(p.body.data).toString('utf8');
    else if (p.mimeType === 'text/html' && p.body?.data && !body) body = b64urlToBuf(p.body.data).toString('utf8').replace(/<[^>]+>/g, ' ');
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return { body, attachments };
}

async function pollMailbox(sa, mailbox, frnAddresses) {
  const auth = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES, subject: mailbox });
  const token = (await auth.getAccessToken()).token;
  const call = async (path) => {
    const res = await fetch(`${GMAIL}/users/${encodeURIComponent(mailbox)}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`gmail ${path} ${res.status}`);
    return res.json();
  };
  // Last ~1 day, unprocessed. (A durable historyId cursor in SSM is a fast-follow; newer:1d + the
  // EMR-side Message-ID dedupe makes re-listing idempotent + cheap.)
  const list = await call('/messages?q=newer_than:1d&maxResults=50');
  let ingested = 0;
  for (const ref of list.messages ?? []) {
    const msg = await call(`/messages/${ref.id}?format=full`);
    const messageId = header(msg.payload, 'Message-ID') || `gmail:${ref.id}`;
    const emailId = deriveEmailId(messageId);
    const { body, attachments } = extractParts(msg.payload);

    // Upload raw + attachments to phiBucket under the Message-ID-derived prefix (idempotent storage).
    const bucket = process.env.PHI_BUCKET_NAME;
    const attachMeta = [];
    if (bucket) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `emails/${emailId}/raw.json`, Body: JSON.stringify(msg), ContentType: 'application/json' }));
      for (let i = 0; i < attachments.length; i += 1) {
        const a = attachments[i];
        const data = await call(`/messages/${ref.id}/attachments/${a.attachmentId}`);
        const buf = b64urlToBuf(data.data);
        const key = `emails/${emailId}/attachments/${i}_${a.filename.replace(/[^\w.\-]/g, '_')}`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: a.contentType ?? 'application/octet-stream' }));
        attachMeta.push({ filename: a.filename, s3Key: key, contentType: a.contentType, sizeBytes: buf.length });
      }
    }

    // Hand to the EMR ingest route (it owns dedupe + match + insert; idempotent on Message-ID).
    const res = await fetch(`${process.env.EMR_API_BASE}/api/v1/internal/emails/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_WORKER_TOKEN}` },
      body: JSON.stringify({
        messageId, mailbox,
        subject: header(msg.payload, 'Subject'), body,
        fromAddress: header(msg.payload, 'From'), toAddress: header(msg.payload, 'To'),
        toAddresses: header(msg.payload, 'To').split(','), ccAddresses: header(msg.payload, 'Cc').split(','),
        frnAddresses,
        receivedAt: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
        rawS3Key: bucket ? `emails/${emailId}/raw.json` : undefined,
        attachments: attachMeta,
      }),
    });
    if (res.ok) ingested += 1;
    else console.error(JSON.stringify({ msg: 'ingest POST failed', status: res.status, emailId }));
  }
  return ingested;
}

export const handler = async () => {
  const mailboxes = await getMailboxes();
  const sa = await getServiceAccount();
  if (mailboxes.length === 0 || !sa) {
    console.log(JSON.stringify({ msg: 'gmail-ingest: not configured (no mailboxes or placeholder SA) — no-op', mailboxes: mailboxes.length, saConfigured: !!sa }));
    return { ok: true, configured: false };
  }
  let total = 0;
  for (const mailbox of mailboxes) {
    try { total += await pollMailbox(sa, mailbox, mailboxes); }
    catch (e) { console.error(JSON.stringify({ msg: 'gmail-ingest: mailbox failed', mailbox, error: String(e?.message ?? e) })); }
  }
  console.log(JSON.stringify({ msg: 'gmail-ingest: done', mailboxes: mailboxes.length, ingested: total }));
  return { ok: true, configured: true, ingested: total };
};
