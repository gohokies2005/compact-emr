// The advisory model caller — Claude Opus 4.6 on Bedrock.
//
// Opus 4.6 via the US cross-region inference profile. 4.7/4.8 are AccessDenied on this account
// (live-tested 2026-06-07); 4.6 is the newest available + live-tested working. Swap to 4.8 here when
// access clears — one line. The model is given NO tools (read-only-by-architecture); it only sees the
// system prompt + the assembled (retrieved chunks + redacted chart slice + question) user content.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export const ADVISORY_MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';
// Sonnet 4.6 US inference profile — live-invokable on this account (verified via the Ask-Aegis email
// Lambda, which runs Sonnet 4.6 on Bedrock today). Cheaper + faster than Opus; adequate for a small
// GROUNDED classification call (the strategy-preview dx-match / PACT check). NOT the advisory default.
export const SONNET_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
// Output cap = the cost ceiling on each answer. 1536 tokens (~1100 words) — raised +50% from 1024 on
// 2026-06-25 (Dr. Kasky: answers were truncating, forcing repeated "ask me to continue" clicks). Cost
// stays modest: output 1536 @ $75/M ≈ 11.5¢ + input (cached system prompt) ≈ 1-3¢. Answers should
// still be concise; this just buys headroom so a normal grounded answer finishes in one pass.
export const ADVISORY_MAX_TOKENS = 1536;

// Bedrock list price for Opus-class, per 1M tokens. VERIFY against the AWS Bedrock pricing page before
// trusting the cost log for billing — these are cost-attribution rates for the oversight dashboard.
export const PRICE_PER_M_INPUT_USD = 15;
export const PRICE_PER_M_OUTPUT_USD = 75;
// Sonnet 4.6 list price, per 1M tokens (Bedrock). Pass these to computeCostUsd / invokeAdvisory so a
// Sonnet call doesn't get attributed at Opus rates in the cost log.
export const SONNET_PRICE_PER_M_INPUT_USD = 3;
export const SONNET_PRICE_PER_M_OUTPUT_USD = 15;

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

export function computeCostUsd(
  usage: AdvisoryUsage,
  // Default to Opus-class rates (the advisory path). A Sonnet caller passes the Sonnet rates so the
  // cost log attributes the cheaper model correctly.
  pricePerMInput: number = PRICE_PER_M_INPUT_USD,
  pricePerMOutput: number = PRICE_PER_M_OUTPUT_USD,
): number {
  const inT =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outT = usage.output_tokens ?? 0;
  const usd = (inT / 1_000_000) * pricePerMInput + (outT / 1_000_000) * pricePerMOutput;
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
  temperature?: number,
): Record<string, unknown> {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    // Optional determinism knob (doctor-pack page picker uses temperature 0 so the same chart
    // selects the same pages across regenerations). Omitted → Bedrock/Claude default.
    ...(temperature !== undefined ? { temperature } : {}),
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
  // modelId / pricing default to the advisory Opus path — every existing caller is byte-identical.
  // A Sonnet caller (the strategy-preview AI checks) passes SONNET_MODEL_ID + the Sonnet rates.
  opts: {
    maxTokens?: number;
    temperature?: number;
    modelId?: string;
    pricePerMInput?: number;
    pricePerMOutput?: number;
  } = {},
): Promise<AdvisoryResult> {
  const body = buildAdvisoryBody(systemPrompt, userContent, opts.maxTokens ?? ADVISORY_MAX_TOKENS, opts.temperature);
  const res = await client().send(
    new InvokeModelCommand({
      modelId: opts.modelId ?? ADVISORY_MODEL_ID,
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
  return {
    text: extractText(parsed),
    usage,
    stopReason: parsed.stop_reason ?? null,
    costUsd: computeCostUsd(usage, opts.pricePerMInput, opts.pricePerMOutput),
  };
}
