// Shared advisory-answer compute — the SINGLE place that turns (caseId, question) + deps into an
// AnswerOutcome. Called by BOTH the synchronous POST .../advisory/ask route AND the async self-invoke
// worker (placeholder-lambda's __advisoryAnswer branch), so the two paths can never drift on how the LLM
// context is assembled (grounding block + current-letter + answerQuestion). Deps are passed IN (not built
// here) so the route keeps its test-injectable overrides and the worker passes the real Bedrock deps.
//
// This module adds NO new behavior vs the old inline /ask body — it is a lift-and-shift of the
// grounding + letter + answerQuestion assembly. The existing advisory-routes tests prove /ask is unchanged.

import type { AppDb } from '../services/db-types.js';
import { buildChartSlice } from './chartSlice.js';
import { invokeAdvisory } from './bedrockClient.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { stubRetrieve } from './retrieveContract.js';
import { realRetrieve, realRetrieveAvailable } from './realRetrieve.js';
import { vendoredSanitize } from './vendoredSanitize.js';
import { buildAiPlanGroundingBlock } from './aiViabilityPlanBlock.js';
import { answerQuestion, type AnswerDeps, type AnswerOutcome } from './advisoryAnswer.js';

// Compute the advisory outcome for a question, given the resolved deps + a current-letter fetcher. The
// route and the worker both call this; grounding + letter are best-effort (fail-open to null) exactly as
// the inline /ask body did.
export async function computeAdvisoryOutcome(
  db: AppDb,
  deps: AnswerDeps,
  fetchLetterText: (caseId: string) => Promise<string | null>,
  caseId: string,
  question: string,
): Promise<AnswerOutcome> {
  const grounding = await buildAiPlanGroundingBlock(db, caseId, question).catch(
    () => ({ block: null as string | null, excludedHints: [] as string[] }),
  );
  const letterText = await fetchLetterText(caseId).catch(() => null);
  return answerQuestion(deps, {
    caseId,
    question,
    viabilityPlanBlock: grounding.block,
    viabilityExcludedHints: grounding.excludedHints,
    letterText,
  });
}

// The REAL advisory deps (Bedrock Opus 4.6 + real retrieve when the advisory_ro URL is wired). Used by the
// async worker, which has no Express router / test overrides. Mirrors createAdvisoryRouter's defaults.
export function buildRealAdvisoryDeps(db: AppDb): AnswerDeps {
  return {
    retrieve: realRetrieveAvailable() ? realRetrieve : stubRetrieve,
    buildChartSlice: (cid: string) => buildChartSlice(db, cid),
    invoke: (s: string, u: string) => invokeAdvisory(s, u),
    systemPrompt: buildSystemPrompt(),
    sanitize: vendoredSanitize,
  };
}
