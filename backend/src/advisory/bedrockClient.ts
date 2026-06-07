// The advisory model caller — Claude Opus 4.6 on Bedrock.
//
// Opus 4.6 via the US cross-region inference profile. 4.7/4.8 are AccessDenied on this account
// (live-tested 2026-06-07); 4.6 is the newest available + live-tested working. Swap to 4.8 here when
// access clears — one line. The model is given NO tools (read-only-by-architecture); it only sees the
// system prompt + the assembled (retrieved chunks + redacted chart slice + question) user content.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export const ADVISORY_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';
// Output cap = the cost ceiling on each answer. 1024 tokens (~750 words) keeps a typical question at
// ~5-10¢ (Ryan target): output 1024 @ $75/M ≈ 7.7¢ + input (cached system prompt) ≈ 1-3¢. Advisory
// answers should be concise anyway.
export const ADVISORY_MAX_TOKENS = 1024;

// Bedrock list price for Opus-class, per 1M tokens. VERIFY against the AWS Bedrock pricing page before
// trusting the cost log for billing — these are cost-attribution rates for the oversight dashboard.
export const PRICE_PER_M_INPUT_USD = 15;
export const PRICE_PER_M_OUTPUT_USD = 75;

export interface AdvisoryUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface AdvisoryResult {
  text: string;
  usage: AdvisoryUsage;
  stopReason: string | null;
  costUsd: number;
}

// Cheap pre-call estimate (~4 chars/token) so the ask endpoint can refuse an over-budget prompt BEFORE
// the paid call (architect gap #7). Approximate; a hardening follow-up could use Bedrock CountTokens.
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export function computeCostUsd(usage: AdvisoryUsage): number {
  const inT =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outT = usage.output_tokens ?? 0;
  const usd = (inT / 1_000_000) * PRICE_PER_M_INPUT_USD + (outT / 1_000_000) * PRICE_PER_M_OUTPUT_USD;
  return Math.round(usd * 10000) / 10000;
}

// The Anthropic-on-Bedrock request body. The SYSTEM prompt is the CACHED prefix (cache_control ephemeral)
// — it's the only stable part. Everything volatile (retrieved chunks + chart slice + question) goes in the
// user message AFTER it, so a per-question change never invalidates the cached preamble. NEVER put a
// case_id / veteran name / timestamp into the system text or caching breaks (architect gap #8).
export function buildAdvisoryBody(
  systemPrompt: string,
  userContent: string,
  maxTokens: number = ADVISORY_MAX_TOKENS,
): Record<string, unknown> {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  };
}

// Pull the assistant text out of the Anthropic response content array.
export function extractText(parsed: { content?: Array<{ type?: string; text?: string }> }): string {
  return (parsed.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

let cached: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (cached === null) cached = new BedrockRuntimeClient({});
  return cached;
}

export async function invokeAdvisory(
  systemPrompt: string,
  userContent: string,
  opts: { maxTokens?: number } = {},
): Promise<AdvisoryResult> {
  const body = buildAdvisoryBody(systemPrompt, userContent, opts.maxTokens ?? ADVISORY_MAX_TOKENS);
  const res = await client().send(
    new InvokeModelCommand({
      modelId: ADVISORY_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: AdvisoryUsage;
    stop_reason?: string;
  };
  const usage = parsed.usage ?? {};
  return { text: extractText(parsed), usage, stopReason: parsed.stop_reason ?? null, costUsd: computeCostUsd(usage) };
}
