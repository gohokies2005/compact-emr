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
const MAX_TOKENS = 1500;
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
  '- Alter the Section VII opinion or the legal holding. NEVER change, weaken, strengthen, or restate the "at least as likely as not" / "more likely than not" conclusion or its CFR citation. If the highlighted passage contains the holding sentence, leave that sentence word-for-word identical inside new_text.',
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
  const anthropic = new Anthropic({ apiKey });
  return async ({ instruction, letterText, mode, passage }: SurgicalProposeInput): Promise<SurgicalProposeOutput> => {
    const isGuided = mode === 'guided_revision';
    // Guided revision (Guided Revision, 2026-06-13): the user message frames the highlighted passage
    // explicitly so the model reshapes ONLY it. The route has already validated `passage` is a
    // verbatim substring of the letter; we surface it to the model AND pin the anchor server-side.
    const userContent = isGuided
      ? `CURRENT LETTER:\n${letterText}\n\nHIGHLIGHTED PASSAGE (reshape ONLY this, return it as anchor_text verbatim):\n${passage ?? ''}\n\nINSTRUCTION:\n${instruction}`
      : `CURRENT LETTER:\n${letterText}\n\nINSTRUCTION:\n${instruction}`;
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // NOTE: Opus 4.8 (claude-opus-4-8) DEPRECATED the `temperature` param — sending it returns a
      // 400 invalid_request_error and the edit fails ("could not be done"). Determinism here comes
      // from forced tool_choice + the strict system prompt, not sampling temperature. Do NOT re-add.
      system: isGuided ? GUIDED_REVISION_SYSTEM_PROMPT : SYSTEM_PROMPT,
      tools: [PROPOSE_TOOL],
      tool_choice: { type: 'tool', name: 'propose_edit' },
      messages: [{ role: 'user', content: userContent }],
    });

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUse === undefined) throw new Error('surgical proposer: model returned no structured edit');
    const raw = toolUse.input as { operation?: unknown; anchor_text?: unknown; new_text?: unknown };
    if (typeof raw.new_text !== 'string') {
      throw new Error('surgical proposer: malformed tool input');
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
        throw new Error('surgical proposer: malformed tool input');
      }
      proposal = { operation: raw.operation as EditOperation, anchor_text: raw.anchor_text, new_text: raw.new_text };
    }
    const costUsd = resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;
    return { proposal, costUsd, model: MODEL };
  };
}
