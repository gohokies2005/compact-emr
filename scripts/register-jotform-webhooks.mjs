#!/usr/bin/env node
/**
 * One-time Jotform webhook registration for intake ingestion.
 *
 * Reads the webhook secret from AWS Secrets Manager (never printed), builds the webhook URL, and
 * registers it on the given Jotform forms via the HIPAA API. The Jotform API KEY is also read from
 * Secrets Manager. Registering a webhook is a WRITE op, so the key must be FULL-ACCESS for this run
 * (toggle it back to read-only after). Idempotent: skips a form that already has our URL.
 *
 * Prereqs: the CDK deploy that wires JOTFORM_WEBHOOK_SECRET onto the API Lambda must have landed
 * (so the endpoint accepts), and the worker must be deployed (so submissions get processed).
 *
 * Usage:
 *   node scripts/register-jotform-webhooks.mjs --list                 # list account forms (read-only OK)
 *   node scripts/register-jotform-webhooks.mjs 260898029223159 <id2>  # register on these form ids
 *   node scripts/register-jotform-webhooks.mjs --all-active           # register on every ENABLED form
 *
 * Env (optional): AWS_REGION (default us-east-1), API_DOMAIN (default api.emr.flatratenexus.com),
 *   ENV_NAME (default staging) — selects the compact-emr-<env>/jotform-* secrets.
 */
import { execFileSync } from 'node:child_process';
import https from 'node:https';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENV_NAME = process.env.ENV_NAME || 'staging';
// The live, publicly-resolvable API host is the HttpApi execute-api URL (what the frontend uses).
// api.emr.flatratenexus.com is NOT set up (no DNS / custom-domain mapping) — a stable custom domain
// is a follow-up. Override with API_DOMAIN once that's wired.
const API_DOMAIN = process.env.API_DOMAIN || 'nypr790pq7.execute-api.us-east-1.amazonaws.com';
const JOTFORM_BASE = 'hipaa-api.jotform.com';

function getSecret(name) {
  const out = execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', name, '--region', REGION, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' });
  return out.trim();
}

function jotform(method, path, apiKey, formBody) {
  return new Promise((resolve, reject) => {
    const data = formBody ? new URLSearchParams(formBody).toString() : null;
    const req = https.request({
      host: JOTFORM_BASE, path, method,
      headers: { APIKEY: apiKey, ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apiKey = getSecret(`compact-emr-${ENV_NAME}/jotform-api-key`);
  const secret = getSecret(`compact-emr-${ENV_NAME}/jotform-webhook-secret`);
  const webhookUrl = `https://${API_DOMAIN}/api/v1/jotform/webhook/${secret}`;
  console.log(`Webhook URL host+path (secret hidden): https://${API_DOMAIN}/api/v1/jotform/webhook/****`);

  if (args.includes('--list') || args.includes('--all-active')) {
    const forms = await jotform('GET', '/user/forms?limit=1000', apiKey);
    const list = (forms.json?.content || []).map((f) => ({ id: f.id, title: f.title, status: f.status, count: f.count }));
    if (args.includes('--list')) {
      list.forEach((f) => console.log(`${f.status === 'ENABLED' ? '●' : '○'} ${f.id}  ${f.count ?? 0} subs  ${f.title}`));
      return;
    }
    args.push(...list.filter((f) => f.status === 'ENABLED').map((f) => f.id));
  }

  const formIds = args.filter((a) => /^\d{10,}$/.test(a));
  if (formIds.length === 0) { console.error('No form ids. Use --list to see them, or pass ids / --all-active.'); process.exit(1); }

  const replace = args.includes('--replace'); // delete any existing intake webhook first (fix a wrong URL)
  // GUARD: --all-active --replace would DELETE+POST on every enabled form (~180 calls) — a perfect
  // way to re-trip the account lockout the owner warned about. --replace is for fixing ONE form's URL.
  if (replace && args.includes('--all-active')) {
    console.error('Refusing --all-active --replace (mass delete+recreate risks an account lockout). Use --replace with explicit form ids only.');
    process.exit(1);
  }
  // THROTTLE: the owner's hard constraint is "never lock the Jotform account" (a 10-min poller did,
  // once). Pace every Jotform call so a bulk run is gentle (~2.5 req/s) instead of an unbounded burst.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`Plan: ${formIds.length} form(s)${replace ? ' (REPLACE mode)' : ''}, paced ~2.5 req/s.`);
  let registered = 0, skipped = 0, failed = 0;
  for (const id of formIds) {
    await sleep(400);
    const existing = await jotform('GET', `/form/${id}/webhooks`, apiKey);
    const ours = Object.entries(existing.json?.content || {}).filter(([, u]) => typeof u === 'string' && u.includes('/jotform/webhook/'));
    if (ours.length > 0 && !replace) { console.log(`= ${id}  already has an intake webhook — skipped (use --replace to update the URL)`); skipped++; continue; }
    if (replace) { for (const [whId] of ours) { await sleep(400); await jotform('DELETE', `/form/${id}/webhooks/${whId}`, apiKey); } }
    await sleep(400);
    const res = await jotform('POST', `/form/${id}/webhooks`, apiKey, { webhookURL: webhookUrl });
    if (res.status < 300) registered++; else failed++;
    console.log(`${res.status < 300 ? '+' : '!'} ${id}  ${replace && ours.length ? 'replaced' : 'registered'} (HTTP ${res.status})`);
  }
  console.log(`Done: ${registered} registered, ${skipped} already-had, ${failed} failed.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
