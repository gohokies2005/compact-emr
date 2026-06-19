// The advisory "Ask AI about this case" endpoint. Case-scoped (the tab is open on a case, so the patient
// is unambiguous — the wrong-patient guard applies to the future name-resolution path, not this one).
// Both views (admin/ops_staff/physician) get full access (no per-role content gating). Every question is
// logged (oversight + cost), including refusals. Deps are injectable for testing; defaults are the real
// chart reader + retrieve stub + Bedrock(4.6) + the cached system prompt (with canonical_facts).

import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';
import { buildChartSlice } from '../advisory/chartSlice.js';
import { invokeAdvisory } from '../advisory/bedrockClient.js';
import { buildSystemPrompt } from '../advisory/systemPrompt.js';
import { stubRetrieve, type RetrieveFn } from '../advisory/retrieveContract.js';
import { realRetrieve, realRetrieveAvailable } from '../advisory/realRetrieve.js';
import { vendoredSanitize } from '../advisory/vendoredSanitize.js';
import { answerQuestion, type AnswerDeps, type ChartSliceLike, type InvokeResultLike } from '../advisory/advisoryAnswer.js';
import { buildAiPlanGroundingBlock } from '../advisory/aiViabilityPlanBlock.js';

interface RequestActor { readonly sub: string; readonly role: Role; }
function currentUser(req: Request): RequestActor {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const priority: readonly Role[] = ['admin', 'physician', 'ops_staff'];
  const role = priority.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role found in JWT');
  return { sub: u.sub, role };
}

export interface AdvisoryRouterDeps {
  retrieve?: RetrieveFn;
  buildChartSlice?: (db: AppDb, caseId: string) => Promise<ChartSliceLike | null>;
  invoke?: (systemPrompt: string, userContent: string) => Promise<InvokeResultLike>;
  systemPrompt?: string;
  sanitize?: (s: string) => string;
}

export function createAdvisoryRouter(db: AppDb, overrides: AdvisoryRouterDeps = {}): Router {
  const router = Router();
  // Real retrieve when the advisory_ro DB URL is wired (prod); stub otherwise (dev/tests). Overrides win.
  const retrieve = overrides.retrieve ?? (realRetrieveAvailable() ? realRetrieve : stubRetrieve);
  const buildSliceFn = overrides.buildChartSlice ?? buildChartSlice;
  const invoke = overrides.invoke ?? ((s: string, u: string) => invokeAdvisory(s, u));
  const systemPrompt = overrides.systemPrompt ?? buildSystemPrompt();
  const sanitize = overrides.sanitize ?? vendoredSanitize;

  router.post(
    '/cases/:id/advisory/ask',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const caseId = String(req.params.id);
      const question = typeof (req.body as { question?: unknown } | undefined)?.question === 'string'
        ? ((req.body as { question: string }).question)
        : '';
      const view = user.role === 'physician' ? 'physician_chart' : 'rn_chart';
      const baseLog = { caseId, userId: user.sub, userRole: user.role, view, question };

      const deps: AnswerDeps = {
        retrieve,
        buildChartSlice: (cid: string) => buildSliceFn(db, cid),
        invoke,
        systemPrompt,
        sanitize,
      };

      // One-brain alignment: for a viability-shaped question, ground the answer in the PERSISTED
      // route-picker plan (the same pick the drafter + Overview card use). Read-only DB lookup, no LLM
      // call here (29s-safe). Fail-open: empty → corpus-only answer (unchanged behavior). The plan's
      // excluded anchors feed the deterministic self-check so a revived excluded pathway is caught.
      const grounding = await buildAiPlanGroundingBlock(db, caseId, question).catch(() => ({ block: null, excludedHints: [] as string[] }));

      let outcome;
      try {
        outcome = await answerQuestion(deps, { caseId, question, viabilityPlanBlock: grounding.block, viabilityExcludedHints: grounding.excludedHints });
      } catch (e) {
        // The model / retrieval threw — log it (oversight) and return a clean error, never a stack trace.
        const reason = e instanceof Error ? e.message : String(e);
        await db.advisoryQuery
          .create({ data: { ...baseLog, status: 'error', modeRan: [], citationsJson: { error: reason.slice(0, 300) } } })
          .catch(() => undefined);
        throw new HttpError(502, 'internal_error', 'The advisory model could not be reached. Please retry.');
      }

      if (outcome.ok === false) {
        await db.advisoryQuery
          .create({ data: { ...baseLog, status: 'refused', modeRan: [], citationsJson: { refused: outcome.reason } } })
          .catch(() => undefined);
        if (outcome.reason === 'case_not_found') throw new HttpError(404, 'not_found', 'Case not found', { caseId });
        if (outcome.reason === 'empty_question') throw new HttpError(400, 'bad_request', 'A question is required.');
        throw new HttpError(413, 'bad_request', 'That question is too large to process — shorten it.');
      }

      // coverage_gap feeds the library-build roadmap (red-team). v1: flag an empty retrieval; the real
      // retrieve.js will provide richer {condition, pubmed_pmids, reason}.
      const coverageGap = outcome.status === 'empty' ? { reason: 'no_library_match', notes: outcome.notes } : null;
      await db.advisoryQuery
        .create({
          data: {
            ...baseLog,
            status: outcome.status,
            modeRan: outcome.modeRan,
            citationsJson: outcome.citations,
            coverageGap,
            costUsd: outcome.costUsd,
            answerChars: outcome.answer.length,
            answer: outcome.answer,
          },
        })
        .catch(() => undefined);

      res.json({
        data: {
          answer: outcome.answer,
          citations: outcome.citations,
          status: outcome.status,
          guidance: outcome.guidance,
          costUsd: outcome.costUsd,
          notes: outcome.notes,
        },
      });
    }),
  );

  // The Q&A thread for a case (answered questions only), oldest-first, so Ask Aegis renders the history
  // when the case is reopened. Both views.
  router.get(
    '/cases/:id/advisory/queries',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.advisoryQuery.findMany({
        where: { caseId, answer: { not: null } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      const thread = rows.map((r) => ({
        id: r.id,
        question: r.question,
        answer: r.answer,
        status: r.status,
        citations: r.citationsJson,
        createdAt: r.createdAt,
      }));
      res.json({ data: thread });
    }),
  );

  return router;
}
