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

export function makeSurgicalProposer(apiKey: string): SurgicalProposer {
  const anthropic = new Anthropic({ apiKey });
  return async ({ instruction, letterText }: SurgicalProposeInput): Promise<SurgicalProposeOutput> => {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [PROPOSE_TOOL],
      tool_choice: { type: 'tool', name: 'propose_edit' },
      messages: [{ role: 'user', content: `CURRENT LETTER:\n${letterText}\n\nINSTRUCTION:\n${instruction}` }],
    });

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUse === undefined) throw new Error('surgical proposer: model returned no structured edit');
    const raw = toolUse.input as { operation?: unknown; anchor_text?: unknown; new_text?: unknown };
    if (typeof raw.operation !== 'string' || typeof raw.anchor_text !== 'string' || typeof raw.new_text !== 'string') {
      throw new Error('surgical proposer: malformed tool input');
    }
    const proposal: EditProposal = {
      operation: raw.operation as EditOperation,
      anchor_text: raw.anchor_text,
      new_text: raw.new_text,
    };
    const costUsd = resp.usage.input_tokens * INPUT_USD_PER_TOKEN + resp.usage.output_tokens * OUTPUT_USD_PER_TOKEN;
    return { proposal, costUsd, model: MODEL };
  };
}
