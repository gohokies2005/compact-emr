import https from 'node:https';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Jotform intake safety-net sweep (hourly, EventBridge-scheduled from WorkersStack).
 *
 * WHY: the real-time path is the webhook doorbell, but Jotform delivery can silently miss
 * submissions (Jotform outage, our 5xx during a deploy window, Jotform auto-disabling a webhook
 * after failures). Observed in production: submissions overnight that never reached the worker. A
 * webhook with no backstop = silent data loss, and intake "must work 100%".
 *
 * HOW (lean — the owner's hard constraint is no account lockout): make ONE Jotform list call per
 * run for the recent window, then REPLAY each submission through the live webhook. The replay is
 * idempotent (intakes_submission_uq + the webhook's create-catch-P2002), and the webhook only
 * RE-ENQUEUES a duplicate when it's still pending/failed — so an already-ingested submission
 * collapses to a no-op and the worker never re-fetches it (detail + files) from Jotform. Net steady
 * state: ~1 Jotform read call/hour; replays hit OUR webhook, not Jotform.
 *
 * Lookback is generous (default 180 min vs a 60-min cron) to absorb clock/timezone skew in
 * Jotform's created_at filter — over-wide is free because already-ingested replays are no-ops.
 */

interface JotformSubmission { id: string; form_id: string; created_at: string }
interface SweepDeps {
  listSubmissions: (sinceIso: string, offset: number) => Promise<JotformSubmission[]>;
  replay: (formId: string, submissionId: string) => Promise<number>; // returns HTTP status
  log: (o: Record<string, unknown>) => void;
}
export interface SweepResult { listed: number; replayed: number; failed: number; failures: Array<{ submissionId: string; reason: string }>; sinceIso: string }

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS` in US Eastern (America/New_York).
 *
 * CRITICAL (2026-06-06 incident, Arturo Perez): Jotform's `created_at:gt` filter — and the
 * created_at it returns — are in US EASTERN, NOT UTC, regardless of the account's timezone setting.
 * (Verified against Jotform's own API docs/support.) The sweep previously formatted the cutoff in
 * UTC; in EDT that cutoff is 4 HOURS in the future relative to what Jotform compares against, so the
 * filter matched NOTHING and every run logged `listed:0` — the safety net ran clean but replayed
 * zero submissions, EVER. Formatting in America/New_York (DST-aware via Intl) fixes it.
 */
export function fmtEastern(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  let hh = get('hour');
  if (hh === '24') hh = '00'; // some runtimes emit '24' for midnight under hour12:false
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')}`;
}

/** Core sweep — deps injected so it's unit-testable without network. */
export async function runSweep(sinceIso: string, deps: SweepDeps): Promise<SweepResult> {
  const subs: JotformSubmission[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await deps.listSubmissions(sinceIso, offset);
    subs.push(...page);
    if (page.length < 1000) break;
  }
  const result: SweepResult = { listed: subs.length, replayed: 0, failed: 0, failures: [], sinceIso };
  for (const s of subs) {
    try {
      const status = await deps.replay(s.form_id, s.id);
      if (status === 200) result.replayed += 1;
      else { result.failed += 1; result.failures.push({ submissionId: s.id, reason: `webhook HTTP ${status}` }); }
    } catch (err) {
      // Per-item catch surfaces the reason (FRN hard rule) — never a silent drop.
      result.failed += 1;
      result.failures.push({ submissionId: s.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.log({ msg: 'jotform-sweep: summary', ...result });
  return result;
}

// ---- Real-network deps (used by the Lambda handler) ----
let cachedApiKey: string | null = null;
let cachedSecret: string | null = null;

async function readSecret(arn: string): Promise<string> {
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return (out.SecretString ?? '').trim();
}

function jotformGet(host: string, path: string, apiKey: string): Promise<{ content?: JotformSubmission[] }> {
  return new Promise((resolve, reject) => {
    https.request({ host, path, method: 'GET', headers: { APIKEY: apiKey } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    }).on('error', reject).end();
  });
}

function postWebhook(apiDomain: string, secret: string, formId: string, submissionId: string): Promise<number> {
  const data = new URLSearchParams({ formID: formId, submissionID: submissionId }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: apiDomain, path: `/api/v1/jotform/webhook/${secret}`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      r.on('data', () => { /* drain */ }); r.on('end', () => resolve(r.statusCode ?? 0));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

export async function handler(): Promise<SweepResult> {
  const jotformHost = process.env['JOTFORM_API_HOST'] ?? 'hipaa-api.jotform.com';
  const apiDomain = (process.env['API_DOMAIN'] ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  // 360-min (6h) default lookback: wide enough that a submission Jotform's webhook dropped and which
  // then sat for a few hours still gets caught by the next hourly run (Arturo sat ~3h). Replays are
  // idempotent (the webhook's status-gated re-enqueue no-ops already-ingested ones), so over-wide is
  // free. The hourly cron means each submission gets ~6 sweep attempts before it ages out.
  const lookbackMin = Number.parseInt(process.env['LOOKBACK_MINUTES'] ?? '360', 10) || 360;
  if (cachedApiKey === null) cachedApiKey = await readSecret(process.env['JOTFORM_API_KEY_SECRET_ARN'] ?? '');
  if (cachedSecret === null) cachedSecret = await readSecret(process.env['JOTFORM_WEBHOOK_SECRET_ARN'] ?? '');
  const apiKey = cachedApiKey; const secret = cachedSecret;
  // Eastern, NOT UTC — Jotform's created_at filter is US Eastern (see fmtEastern). This was the bug.
  const sinceIso = fmtEastern(new Date(Date.now() - lookbackMin * 60 * 1000));

  return runSweep(sinceIso, {
    listSubmissions: async (since, offset) => {
      const filter = encodeURIComponent(JSON.stringify({ 'created_at:gt': since }));
      const page = await jotformGet(jotformHost, `/user/submissions?filter=${filter}&limit=1000&offset=${offset}&orderby=created_at`, apiKey);
      return page.content ?? [];
    },
    replay: (formId, submissionId) => postWebhook(apiDomain, secret, formId, submissionId),
    log: (o) => { console.log(JSON.stringify(o)); },
  });
}
