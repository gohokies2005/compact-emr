#!/usr/bin/env node
/**
 * Backfill historical Jotform submissions into the intake pool by REPLAYING them through the live
 * webhook (so they flow through the exact same path as a real submission: Intake row → worker →
 * files in S3 → pool). Idempotent: the unique submission-ID collapses re-runs + already-live ones.
 *
 * Prereq: the webhook must be LIVE (API stack deployed with JOTFORM_WEBHOOK_SECRET). The Jotform
 * API key may be read-only (this only READS submissions + POSTs to OUR webhook).
 *
 * Usage:
 *   node scripts/backfill-jotform-intakes.mjs --since "2026-06-01 00:01:00"
 *   node scripts/backfill-jotform-intakes.mjs --since "2026-06-01 00:01:00" --dry   # list only, no replay
 *
 * Env: AWS_REGION (us-east-1), API_DOMAIN (api.emr.flatratenexus.com), ENV_NAME (staging).
 */
import { execFileSync } from 'node:child_process';
import https from 'node:https';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENV_NAME = process.env.ENV_NAME || 'staging';
// Live API host = the execute-api URL (api.emr.flatratenexus.com isn't wired yet). Override w/ env.
const API_DOMAIN = process.env.API_DOMAIN || 'nypr790pq7.execute-api.us-east-1.amazonaws.com';
const JOTFORM_HOST = 'hipaa-api.jotform.com';

function getSecret(name) {
  return execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', name, '--region', REGION, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' }).trim();
}

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

function jotformSubmissions(apiKey, sinceIso, offset) {
  const filter = encodeURIComponent(JSON.stringify({ 'created_at:gt': sinceIso }));
  const path = `/user/submissions?filter=${filter}&limit=1000&offset=${offset}&orderby=created_at`;
  return req({ host: JOTFORM_HOST, path, method: 'GET', headers: { APIKEY: apiKey } });
}

function postWebhook(secret, formId, submissionId) {
  const data = new URLSearchParams({ formID: formId, submissionID: submissionId }).toString();
  return req({ host: API_DOMAIN, path: `/api/v1/jotform/webhook/${secret}`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, data);
}

async function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
  const dry = args.includes('--dry');
  if (!since) { console.error('Required: --since "YYYY-MM-DD HH:MM:SS"'); process.exit(1); }

  const apiKey = getSecret(`compact-emr-${ENV_NAME}/jotform-api-key`);
  const secret = dry ? '' : getSecret(`compact-emr-${ENV_NAME}/jotform-webhook-secret`);

  const subs = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await jotformSubmissions(apiKey, since, offset);
    const items = page.json?.content || [];
    subs.push(...items.map((s) => ({ id: s.id, formId: s.form_id, created: s.created_at })));
    if (items.length < 1000) break;
  }
  console.log(`Found ${subs.length} submission(s) since ${since}.`);
  if (dry) { subs.forEach((s) => console.log(`  ${s.created}  form ${s.formId}  sub ${s.id}`)); return; }

  let ok = 0; const fail = [];
  for (const s of subs) {
    const res = await postWebhook(secret, s.formId, s.id);
    if (res.status === 200) ok += 1; else fail.push(`${s.id} (HTTP ${res.status})`);
  }
  console.log(`Replayed: ${ok} accepted${fail.length ? `, ${fail.length} failed — ${fail.join(', ')}` : ''}. Watch the /intake pool (pending → ready as the worker processes).`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
