/**
 * Concrete SurgicalProposer — the Opus-4.8 bounded-edit LLM call for the surgical-AI editor.
 * Uses tool-use so the model returns a STRUCTURED {operation, anchor_text, new_text} that the
 * deterministic applyStructuredEdit applies. Wired at mount (server.ts) from the
 * api-anthropic-api-key secret. Injected (LetterRouterDeps.proposeSurgicalEdit) so the router
 * is stub-testable and has no @anthropic-ai/sdk dependency at type-check time.
 *
 * Cost: cloud meters the key (no free Claude-Max lane in a Lambda — per the owner's rule, the
 * spend is recorded; the surgical-ai route logs costUsd at propose time).
 */

import Anthropic from '@anthropic-ai/sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SurgicalProposer, SurgicalProposeInput, SurgicalProposeOutput } from '../routes/letter.js';
import type { EditProposal, EditOperation } from './letter-edit-apply.js';

const MODEL = 'claude-opus-4-8';
// The proposer's output is the RESHAPED passage (new_text). At 1500 a full-section / 1-2 page highlight
// truncated (stop_reason:max_tokens) → passage_too_complex → "try a single sentence" (Dr. Kasky 2026-06-26:
// "harden so up to 1-2 pages can be highlighted"). 2 letter pages ≈ ~6000 chars ≈ ~1700 output tokens, so
// 6000 gives comfortable headroom; an unusually expansive reshape escalates ONCE to the ceiling.
const MAX_TOKENS = 6000;
const MAX_TOKENS_CEILING = 12000;
// Transient-resilience (Guided-revision robustness, 2026-06-24): the SDK's own retry already
// handles 429 / 5xx / 529-overloaded / timeouts / connection errors with exponential backoff +
// jitter and honors retry-after, so we just RAISE its budget (default 2 -> 4) rather than hand-roll
// a loop. A wedged socket otherwise burns the whole budget on one attempt, so cap each attempt with
// an explicit timeout. This is the "it works after waiting" fix: a brief Anthropic overload no longer
// surfaces as the generic "could not be generated."
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 60_000;
// Beyond ~3 pages even the raised + escalated budget may truncate; the route surfaces this in the
// failure detail so the message stays accurate ("it may be too long"). Raised with MAX_TOKENS so a
// normal 1-2 page section no longer trips it.
const LONG_PASSAGE_CHARS = 9000;

/**
 * A proposer failure the route can turn into a SPECIFIC, actionable 422 (never the generic
 * "could not be generated"). `detail` discriminates the cause so the UI can say the right thing:
 *  - 'model_unavailable'   : Anthropic was transiently down even after retries -> "click Propose again"
 *  - 'passage_too_complex' : the model truncated (max_tokens) -> the edit couldn't be shaped cleanly
 *  - 'no_change_proposed'  : the model returned no/empty/malformed structured edit
 */
export type ProposerFailureDetail = 'model_unavailable' | 'passage_too_complex' | 'no_change_proposed';
export class ProposerUnavailableError extends Error {
  readonly isProposerUnavailable = true;
  constructor(readonly detail: ProposerFailureDetail, readonly passageTooLong = false, message?: string) {
    super(message ?? `proposer unavailable: ${detail}`);
    this.name = 'ProposerUnavailableError';
  }
}

/**
 * Classify a thrown Anthropic error as transient (worth surfacing as a retry-now message) vs a
 * 4xx/validation we should NOT dress up as transient. The SDK has already retried the transient
 * classes by the time it throws, so reaching here means they were EXHAUSTED — still transient from
 * the user's view ("the service was briefly unavailable, try again"). Connection/timeout errors
 * carry no .status, so test them first. Non-Anthropic errors are treated as non-transient.
 */
export function isTransientAnthropicError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // incl. APIConnectionTimeoutError
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    if (s === 429 || s === 529) return true;
    if (typeof s === 'number' && s >= 500 && s <= 599) return true;
    return false; // 400/401/403/404/413/422 — a real request problem, not a blip
  }
  return false;
}
// Opus per-MTok pricing (input $15 / output $75). Update if pricing changes.
const INPUT_USD_PER_TOKEN = 15 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 75 / 1_000_000;

const SYSTEM_PROMPT = [
  'You are a surgical editor for a board-certified physician\'s VA nexus letter (an independent medical opinion).',
  'The physician gives ONE instruction; you propose ONE LIMITED-SCOPE edit — NOT a redraft.',
  'Return the edit via the propose_edit tool, never as prose. Rules:',
  '- anchor_text MUST be a verbatim substring copied exactly from the CURRENT LETTER (including punctuation/spacing). Keep it short + distinctive.',
  '- operation: "replace" swaps anchor_text for new_text; "insert_after"/"insert_before" add new_text adjacent to anchor_text.',
  '- Change ONLY what the instruction asks. Do not rewrite surrounding sentences.',
  '- NEVER alter or remove the locked blocks: the Section I credentials sentence ("I, Ryan J. Kasky, DO, am board-certified..."), the "no treatment relationship" sentence, or the Section II Nieves-Rodriguez paragraph.',
  '- NEVER fabricate a citation. If the instruction asks to add a reference you cannot support from the letter\'s own content, propose the smallest faithful edit and do not invent a PMID/author/year.',
  '- NEVER emit bracketed placeholders like [VERIFY ...] or [citation needed].',
  '- FRN style: no em dashes, no smart quotes. Use plain commas/parentheses.',
].join('\n');

/**
 * Guided Revision system prompt (Guided Revision, 2026-06-13) — the BROADER tier. The physician
 * highlights a passage and gives an instruction; you reshape THAT PASSAGE ONLY. Softer PROSE rules
 * (you may reorganize, re-emphasize, adjust tone, strengthen or soften an argument) but HARD
 * structural guards. The route ALSO enforces these mechanically (§VII holding lock +
 * citation-integrity guard), so this prompt is the first line, not the only line.
 */
const GUIDED_REVISION_SYSTEM_PROMPT = [
  'You are a guided-revision editor for a board-certified physician\'s VA nexus letter (an independent medical opinion).',
  'The physician has HIGHLIGHTED a passage of the letter and given an instruction for how to reshape it.',
  'You return ONE structured edit via the propose_edit tool that REPLACES the highlighted passage with a revised version. Never return prose.',
  'You MUST set operation to "replace" and set anchor_text to the EXACT highlighted passage, copied verbatim (including punctuation/spacing). new_text is your revised passage.',
  '',
  'You MAY (softer prose rules): reorganize sentences within the passage, change emphasis, adjust tone, strengthen or soften an argument, tighten wording, improve flow.',
  '',
  'You MUST NOT (hard rules):',
  '- Edit ANYTHING outside the highlighted passage. anchor_text is the highlighted passage and nothing more; new_text replaces only it.',
  '- Weaken, strengthen, or remove the Section VII PROBABILITY conclusion. You MAY rephrase the CAUSAL THEORY of the opinion when the instruction asks (e.g. "caused by" -> "aggravated by", i.e. causation <-> secondary aggravation, or which condition is primary vs secondary), but you MUST keep the "more likely than not (>50%)" probability conclusion and its CFR citation WORD-FOR-WORD unchanged. Never downgrade it to "at least as likely as not" or below.',
  '- Add, remove, or change ANY citation (PMID, author-year like "Smith 2019") or ANY statistic (a percentage, OR/RR/HR value, n=, or confidence interval). You may rephrase the prose AROUND a cited fact, but the cited facts themselves are FIXED. Do not invent a citation or statistic to make a reworded argument sound supported. If softening an argument would leave a citation unsupported, reword around it rather than deleting it.',
  '- Alter or remove the locked blocks: the Section I credentials sentence ("I, Ryan J. Kasky, DO, am board-certified..."), the "no treatment relationship" sentence, or the Section II Nieves-Rodriguez paragraph.',
  '- Emit bracketed placeholders like [VERIFY ...] or [citation needed], or any fabricated fact.',
  '',
  'FRN style: no em dashes, no smart quotes. Use plain commas/parentheses.',
].join('\n');

const PROPOSE_TOOL: Anthropic.Tool = {
  name: 'propose_edit',
  description: 'Propose one limited-scope structured edit to the nexus letter.',
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['replace', 'insert_after', 'insert_before'], description: 'how new_text relates to anchor_text' },
      anchor_text: { type: 'string', description: 'a verbatim substring of the current letter to anchor the edit' },
      new_text: { type: 'string', description: 'the replacement (replace) or the text to insert (insert_*)' },
    },
    required: ['operation', 'anchor_text', 'new_text'],
  },
};

/**
 * Extract the API key from a Secrets Manager SecretString. Accepts a RAW key (the simplest thing
 * an operator can paste) or a JSON wrapper ({apiKey|ANTHROPIC_API_KEY|api_key}). Throws on blank.
 * Pure (no I/O) so it is unit-testable.
 */
export function parseAnthropicSecretString(secretString: string): string {
  const raw = secretString.trim();
  if (raw.length === 0) throw new Error('Anthropic secret is empty.');
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const v = obj.apiKey ?? obj.ANTHROPIC_API_KEY ?? obj.api_key;
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    } catch {
      /* not JSON; fall through to treating the whole thing as the key */
    }
  }
  return raw;
}

/**
 * Resolve the Anthropic key at runtime: prefer a literal ANTHROPIC_API_KEY, else fetch the value
 * from API_ANTHROPIC_KEY_SECRET_ARN (Secrets Manager). Mirrors db/database-url.ts so that filling
 * the secret needs NO redeploy — the value is read on first surgical-AI use.
 */
export async function resolveAnthropicApiKey(): Promise<string> {
  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct && direct.trim().length > 0) return direct.trim();
  const secretArn = process.env.API_ANTHROPIC_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('ANTHROPIC_API_KEY or API_ANTHROPIC_KEY_SECRET_ARN is required for surgical-AI.');
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Anthropic secret did not contain a SecretString value.');
  return parseAnthropicSecretString(response.SecretString);
}

/**
 * Lazily-resolved proposer for production: the key is fetched + the Anthropic client built on the
 * FIRST surgical-AI call, then cached. A failed resolve (e.g. the secret not yet filled) is NOT
 * cached, so once the operator pastes the key the next click works without a redeploy or cold
 * start. Mount this whenever ANTHROPIC_API_KEY or API_ANTHROPIC_KEY_SECRET_ARN is set.
 */
export function makeSurgicalProposerFromEnv(): SurgicalProposer {
  let delegate: SurgicalProposer | null = null;
  let resolving: Promise<SurgicalProposer> | null = null;
  async function ensure(): Promise<SurgicalProposer> {
    if (delegate) return delegate;
    if (!resolving) {
      resolving = resolveAnthropicApiKey()
        .then((key) => { delegate = makeSurgicalProposer(key); return delegate; })
        .catch((e: unknown) => { resolving = null; throw e; });
    }
    return resolving;
  }
  return async (input: SurgicalProposeInput): Promise<SurgicalProposeOutput> => (await ensure())(input);
}

export function makeSurgicalProposer(apiKey: string): SurgicalProposer {
  // maxRetries here gives the SDK its own exponential-backoff-with-jitter retry on the transient
  // classes (429/5xx/529/timeouts/connection) — the robust transient fix, no hand-rolled loop.
  const anthropic = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });
  return async ({ instruction, letterText, mode, passage }: SurgicalProposeInput): Promise<SurgicalProposeOutput> => {
    const isGuided = mode === 'guided_revision';
    // Guided revision (Guided Revision, 2026-06-13): the user message frames the highlighted passage
    // explicitly so the model reshapes ONLY it. The route has already validated `passage` is a
    // verbatim substring of the letter; we surface it to the model AND pin the anchor server-side.
    const userContent = isGuided
      ? `CURRENT LETTER:\n${letterText}\n\nHIGHLIGHTED PASSAGE (reshape ONLY this, return it as anchor_text verbatim):\n${passage ?? ''}\n\nINSTRUCTION:\n${instruction}`
      : `CURRENT LETTER:\n${letterText}\n\nINSTRUCTION:\n${instruction}`;
    const passageTooLong = typeof passage === 'string' && passage.length > LONG_PASSAGE_CHARS;
    // Try at the standard budget; if a forced tool_use TRUNCATES (stop_reason 'max_tokens' → incomplete
    // tool input), the reshaped passage didn't fit — escalate ONCE to the ceiling so a full 1-2 page
    // section reshape completes instead of failing (Dr. Kasky 2026-06-26). Cost is bounded + physician-
    // initiated; the escalation only fires on a genuinely large reshape.
    let resp: Anthropic.Message | undefined;
    for (const budget of [MAX_TOKENS, MAX_TOKENS_CEILING]) {
      try {
        resp = await anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: budget,
            // NOTE: Opus 4.8 (claude-opus-4-8) DEPRECATED the `temperature` param — sending it returns a
            // 400 invalid_request_error and the edit fails ("could not be done"). Determinism here comes
            // from forced tool_choice + the strict system prompt, not sampling temperature. Do NOT re-add.
            system: isGuided ? GUIDED_REVISION_SYSTEM_PROMPT : SYSTEM_PROMPT,
            tools: [PROPOSE_TOOL],
            tool_choice: { type: 'tool', name: 'propose_edit' },
            messages: [{ role: 'user', content: userContent }],
          },
          { timeout: REQUEST_TIMEOUT_MS },
        );
      } catch (err: unknown) {
        // The SDK has already retried the transient classes; reaching here means they were exhausted
        // (or it's a non-retryable error). Surface transient as 'model_unavailable' so the route can
        // tell the physician to simply click Propose again — NOT the generic could-not-be-generated.
        if (isTransientAnthropicError(err)) throw new ProposerUnavailableError('model_unavailable', passageTooLong);
        throw err;
      }
      if (resp && resp.stop_reason !== 'max_tokens') break; // complete edit — done
      // truncated at this budget: loop escalates to the ceiling; after the last budget we fall through.
    }

    // TRUNCATION GUARD: still truncated even at the ceiling → the passage is genuinely too large to
    // reshape in one structured edit. Flag distinctly so the message is "too long, narrow the selection".
    if (!resp || resp.stop_reason === 'max_tokens') {
      throw new ProposerUnavailableError('passage_too_complex', passageTooLong);
    }

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUse === undefined) throw new ProposerUnavailableError('no_change_proposed', passageTooLong, 'model returned no structured edit');
    const raw = toolUse.input as { operation?: unknown; anchor_text?: unknown; new_text?: unknown };
    if (typeof raw.new_text !== 'string' || raw.new_text.length === 0) {
      throw new ProposerUnavailableError('no_change_proposed', passageTooLong, 'malformed or empty tool input');
    }
    // Guided revision is a passage-scoped REPLACE by construction: the route guarantees `passage`
    // is a verbatim substring, so we PIN operation='replace' + anchor_text=passage server-side. This
    // makes "edit ONLY within the highlighted passage" a structural guarantee, not a prompt promise
    // (the model cannot widen the edit beyond the highlight by returning a longer anchor).
    let proposal: EditProposal;
    if (isGuided) {
      if (typeof passage !== 'string' || passage.length === 0) {
        throw new Error('guided-revision proposer: passage is required');
      }
      proposal = { operation: 'replace', anchor_text: passage, new_text: raw.new_text };
    } else {
      if (typeof raw.operation !== 'string' || typeof raw.anchor_text !== 'string') {
        throw new ProposerUnavailableError('no_change_proposed', passageTooLong, 'malformed tool input');
      }
      proposal = { operation: raw.operation as EditOperation, anchor_text: raw.anchor_text, new_text: raw.new_text };
    }
    const costUsd = resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;
    return { proposal, costUsd, model: MODEL };
  };
}
