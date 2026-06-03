/**
 * Chart-extract worker (SQS-triggered Lambda). Lightweight: NO Prisma. For each queued message it
 *   1. resolves the Anthropic key (from ANTHROPIC_SECRET_ARN at cold start),
 *   2. GETs the case's documents+pages from the API (/internal/cases/:id/extract-documents),
 *   3. runs the content-based extractor (makeChartExtractor),
 *   4. POSTs the grounded items to the merge endpoint (.../extracted-chart-items) — the single
 *      writer. CHART_AUTOFILL governs whether the merge writes chart rows or just records (shadow).
 *
 * Error handling: transient failures rethrow so SQS retries (up to the queue's maxReceiveCount);
 * on the FINAL attempt the run is marked failed so the build-state shows extract_failed (a retry
 * message) instead of a stuck "still building" forever.
 */

import { makeChartExtractor } from '../../backend/src/services/chart-extract-llm.js';
import type { BundleDocument } from '../../backend/src/services/chart-extractor.js';

interface SqsRecord { body: string; attributes?: { ApproximateReceiveCount?: string } }
interface SqsEvent { Records?: SqsRecord[] }
interface ExtractMessage { runId: string; caseId: string; veteranId: string; triggerHash: string }

const MAX_RECEIVE = Number(process.env.CHART_EXTRACT_MAX_RECEIVE ?? '3');

let cachedKey: string | null = null;
async function resolveAnthropicKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct && direct.trim()) { cachedKey = direct.trim(); return cachedKey; }
  const arn = process.env.ANTHROPIC_SECRET_ARN;
  if (!arn) throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_SECRET_ARN is required');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const resp = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!resp.SecretString) throw new Error('Anthropic secret has no SecretString');
  let key = resp.SecretString.trim();
  if (key.startsWith('{')) {
    const o = JSON.parse(key) as Record<string, string>;
    key = (o.apiKey ?? o.ANTHROPIC_API_KEY ?? o.api_key ?? '').trim();
  }
  if (!key) throw new Error('resolved Anthropic key is empty');
  cachedKey = key;
  return key;
}

function apiBase(): string {
  const u = process.env.COMPACT_EMR_API_URL;
  if (!u) throw new Error('COMPACT_EMR_API_URL is required');
  return u.replace(/\/$/, '');
}
function workerToken(): string {
  const t = process.env.INTERNAL_WORKER_TOKEN;
  if (!t) throw new Error('INTERNAL_WORKER_TOKEN is required');
  return t;
}

async function fetchDocuments(caseId: string): Promise<BundleDocument[]> {
  const res = await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/extract-documents`, {
    headers: { 'X-Internal-Worker-Token': workerToken() },
  });
  if (!res.ok) throw new Error(`extract-documents GET failed: ${res.status}`);
  const json = (await res.json()) as { data: { documents: BundleDocument[] } };
  return json.data.documents;
}

async function postMerge(caseId: string, runId: string, items: unknown[], costUsd: number): Promise<void> {
  const res = await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/extracted-chart-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Worker-Token': workerToken() },
    body: JSON.stringify({ runId, items, costUsd }),
  });
  if (!res.ok) throw new Error(`extracted-chart-items POST failed: ${res.status}`);
}

async function postFailed(caseId: string, runId: string, error: string): Promise<void> {
  await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/chart-extract-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Worker-Token': workerToken() },
    body: JSON.stringify({ runId, error }),
  }).catch(() => { /* best-effort: the stuck-run watcher is the backstop */ });
}

export async function handler(event: SqsEvent): Promise<void> {
  for (const rec of event.Records ?? []) {
    let msg: ExtractMessage;
    try { msg = JSON.parse(rec.body) as ExtractMessage; } catch { console.error('chart-extract: bad message body', rec.body); continue; }
    const receiveCount = Number(rec.attributes?.ApproximateReceiveCount ?? '1');
    try {
      const key = await resolveAnthropicKey();
      const documents = await fetchDocuments(msg.caseId);
      const result = await makeChartExtractor(key).extract(documents);
      await postMerge(msg.caseId, msg.runId, result.items, result.costUsd);
      console.log(JSON.stringify({ msg: 'chart_extract_done', caseId: msg.caseId, runId: msg.runId, items: result.items.length, costUsd: result.costUsd }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: 'chart_extract_error', caseId: msg.caseId, runId: msg.runId, receiveCount, error: message }));
      if (receiveCount >= MAX_RECEIVE) {
        // Final attempt — mark the run failed so the door shows extract_failed (retry), not stuck.
        await postFailed(msg.caseId, msg.runId, message);
        return; // do not rethrow: terminal
      }
      throw err; // transient — let SQS redeliver
    }
  }
}
