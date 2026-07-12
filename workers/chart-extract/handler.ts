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
import { classifyEvents, eventClassifierEnabled } from '../../backend/src/services/event-classifier.js';
import Anthropic from '@anthropic-ai/sdk';

interface SqsRecord { body: string; attributes?: { ApproximateReceiveCount?: string } }
interface SqsEvent { Records?: SqsRecord[] }
interface ExtractMessage { runId: string; caseId: string; veteranId: string; triggerHash: string }
// Minimal shape of the Lambda invocation Context — we need only the countdown to the hard kill. The
// runtime always passes it as the 2nd handler arg; typed optional so unit tests can invoke handler(event).
interface LambdaContext { getRemainingTimeInMillis(): number }

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

// Idempotency precheck (audit 2026-06-13 ROOT FIX for double/triple-billing). Returns the run's current
// status, or null if it can't be read. FAIL-OPEN: a status-read failure returns null → the caller
// proceeds with extraction (better to risk a re-run than block a legitimate first run on a transient).
async function getRunStatus(caseId: string, runId: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/chart-extract-run/${runId}`, {
      headers: { 'X-Internal-Worker-Token': workerToken() },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { status?: string } };
    return json.data?.status ?? null;
  } catch { return null; }
}

async function postMerge(caseId: string, runId: string, items: unknown[], costUsd: number, gaps: { truncatedWindows: number; uncoveredPages: number; fullRead: boolean }): Promise<void> {
  const res = await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/extracted-chart-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Worker-Token': workerToken() },
    // Thread the coverage/truncation signal (audit 2026-06-13): the merge stamps complete_with_gaps when
    // either is >0 so a gapped extraction is never silently recorded as a clean 'complete'.
    body: JSON.stringify({ runId, items, costUsd, ...gaps }),
  });
  if (!res.ok) throw new Error(`extracted-chart-items POST failed: ${res.status}`);
}

async function postScreeningSummary(caseId: string, runId: string, screenings: unknown[]): Promise<void> {
  const res = await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/screening-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Worker-Token': workerToken() },
    body: JSON.stringify({ runId, screenings }),
  });
  if (!res.ok) throw new Error(`screening-summary POST failed: ${res.status}`);
}

async function postFailed(caseId: string, runId: string, error: string): Promise<void> {
  await fetch(`${apiBase()}/api/v1/internal/cases/${caseId}/chart-extract-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Worker-Token': workerToken() },
    body: JSON.stringify({ runId, error }),
  }).catch(() => { /* best-effort: the stuck-run watcher is the backstop */ });
}

export async function handler(event: SqsEvent, context?: LambdaContext): Promise<void> {
  for (const rec of event.Records ?? []) {
    let msg: ExtractMessage;
    try { msg = JSON.parse(rec.body) as ExtractMessage; } catch { console.error('chart-extract: bad message body', rec.body); continue; }
    const receiveCount = Number(rec.attributes?.ApproximateReceiveCount ?? '1');
    try {
      // ROOT idempotency guard: a redelivery of a run whose extraction already COMPLETED must not
      // re-spend ~$6 of Anthropic (the double/triple-bill class — the actual incident was a merge-500
      // redeliver). Check status BEFORE any LLM work; if already terminal-complete, ack-and-skip.
      const priorStatus = await getRunStatus(msg.caseId, msg.runId);
      if (priorStatus === 'complete' || priorStatus === 'complete_with_gaps') {
        console.log(JSON.stringify({ msg: 'chart_extract_idempotent_skip', caseId: msg.caseId, runId: msg.runId, priorStatus }));
        continue; // terminal — message is deleted on handler return; zero tokens spent
      }
      const key = await resolveAnthropicKey();
      const documents = await fetchDocuments(msg.caseId);
      // Pass the Lambda's ABSOLUTE kill time so the extractor stops launching/splitting before the 900s
      // wall and degrades to complete_with_gaps — the structural fix for the Reckart CLM-84B137F353 DLQ
      // (a dense page's late re-read outrunning the wall). Absent context (unit tests) → self-budget only.
      const deadlineMs = context ? Date.now() + context.getRemainingTimeInMillis() : undefined;
      const result = await makeChartExtractor(key).extract(documents, { deadlineMs });
      await postMerge(msg.caseId, msg.runId, result.items, result.costUsd, { truncatedWindows: result.truncatedWindows ?? 0, uncoveredPages: result.uncoveredPages ?? 0, fullRead: result.fullRead ?? false });
      console.log(JSON.stringify({ msg: 'chart_extract_done', caseId: msg.caseId, runId: msg.runId, items: result.items.length, screenings: result.screenings?.length ?? 0, costUsd: result.costUsd, model: result.model, fullRead: result.fullRead, windowsProcessed: result.windowsProcessed, chunksProcessed: result.chunksProcessed, uncoveredPages: result.uncoveredPages, truncatedWindows: result.truncatedWindows }));
      // A truncated window means the extraction is INCOMPLETE for this chart — make it loud so it's
      // not mistaken for a clean parse (the full-read chunker, PR-1, eliminates the cause).
      if (result.truncatedWindows > 0) {
        console.warn(JSON.stringify({ msg: 'chart_extract_INCOMPLETE_truncation', caseId: msg.caseId, runId: msg.runId, truncatedWindows: result.truncatedWindows }));
      }
      // ── DARK: LLM in-service EVENT classifier (additive recall layer) ──────────────────────────
      // Present-but-dark behind DIRECT_SC_VIABILITY_ENABLED (same flag that gates the EMR direct-SC
      // path; default OFF). When off this block is a no-op and NOTHING about chart-extract changes.
      // When on, it runs ONE extra Sonnet call over the chart text and LOGS the grounded events — there
      // is no write endpoint for events yet, so it cannot alter chart output. Best-effort: any failure
      // is swallowed (the chart rows already committed above must never be put at risk by this layer).
      if (eventClassifierEnabled()) {
        try {
          const chartText = documents
            .flatMap((d) => d.pages.map((p) => `[p.${p.pageNumber}] ${p.text}`))
            .join('\n');
          const events = await classifyEvents({ chartText, anthropic: new Anthropic({ apiKey: key }) });
          console.log(JSON.stringify({ msg: 'event_classifier_done', caseId: msg.caseId, runId: msg.runId, events: events.length, eventTypes: events.map((e) => e.event_canonical) }));
        } catch (err) {
          console.warn(JSON.stringify({ msg: 'event_classifier_failed', caseId: msg.caseId, runId: msg.runId, error: err instanceof Error ? err.message : String(err) }));
        }
      }

      // Consolidated screening-summary Documents file (best-effort, log-only — the chart rows already
      // committed above, so a summary failure must never fail this callback).
      if (result.screenings && result.screenings.length > 0) {
        try {
          await postScreeningSummary(msg.caseId, msg.runId, result.screenings);
          console.log(JSON.stringify({ msg: 'screening_summary_written', caseId: msg.caseId, runId: msg.runId, screenings: result.screenings.length }));
        } catch (err) {
          console.warn(JSON.stringify({ msg: 'screening_summary_failed', caseId: msg.caseId, runId: msg.runId, error: err instanceof Error ? err.message : String(err) }));
        }
      }
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
