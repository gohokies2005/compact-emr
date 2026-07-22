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
import { type AnswerDeps, type ChartSliceLike, type InvokeResultLike } from '../advisory/advisoryAnswer.js';
import { resolveCurrentTxtWithHash } from '../services/letter-current.js';
import { computeAdvisoryOutcome } from '../advisory/runAdvisoryAnswer.js';
import { fireAdvisoryAnswer } from '../services/advisory-answer-trigger.js';
import type { S3Client } from '@aws-sdk/client-s3';

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
  // FEATURE A — "critique THIS letter" (Ryan 2026-06-24): fetch the case's current drafted letter so the
  // RN/physician can ask Ask Aegis about the draft. The default fetcher uses s3+bucketName; if those are
  // absent (tests) it returns null → no letter in context (today's behavior). Override fetchLetterText in tests.
  s3?: S3Client;
  bucketName?: string;
  fetchLetterText?: (caseId: string) => Promise<string | null>;
}

// Best-effort current-letter-text fetcher. Fail-open: any error / no letter / no s3 → null (the advisory
// answer simply runs corpus+chart only, exactly as before). The letter is TRANSIENT context — never indexed.
export function buildLetterFetcher(db: AppDb, s3?: S3Client, bucketName?: string): (caseId: string) => Promise<string | null> {
  if (s3 === undefined || !bucketName) return async () => null;
  return async (caseId: string) => {
    try {
      const c = await db.case.findFirst({ where: { id: caseId }, select: { currentVersion: true } });
      if (c === null || c.currentVersion === null || c.currentVersion === undefined) return null;
      const r = await resolveCurrentTxtWithHash(db, s3, bucketName, caseId, c.currentVersion);
      return r !== null && typeof r.txt === 'string' && r.txt.trim().length > 0 ? r.txt : null;
    } catch {
      return null;
    }
  };
}

export function createAdvisoryRouter(db: AppDb, overrides: AdvisoryRouterDeps = {}): Router {
  const router = Router();
  // Real retrieve when the advisory_ro DB URL is wired (prod); stub otherwise (dev/tests). Overrides win.
  const retrieve = overrides.retrieve ?? (realRetrieveAvailable() ? realRetrieve : stubRetrieve);
  const buildSliceFn = overrides.buildChartSlice ?? buildChartSlice;
  const invoke = overrides.invoke ?? ((s: string, u: string) => invokeAdvisory(s, u));
  const systemPrompt = overrides.systemPrompt ?? buildSystemPrompt();
  const sanitize = overrides.sanitize ?? vendoredSanitize;
  const fetchLetterText = overrides.fetchLetterText ?? buildLetterFetcher(db, overrides.s3, overrides.bucketName);

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
      let outcome;
      try {
        outcome = await computeAdvisoryOutcome(db, deps, fetchLetterText, caseId, question);
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

  // ── ASYNC ask (Ryan 2026-07-21): submit → poll, so a 20-40s Opus answer never hits the API-Gateway 30s
  // cap and 504s. Insert a `pending` row, self-invoke the Lambda to compute+fill it OFF the request path,
  // and return the queryId immediately; the client polls GET .../queries/:queryId. The synchronous /ask
  // above is UNCHANGED (rollback = frontend flag off; this endpoint just goes unused). Same role gate.
  router.post(
    '/cases/:id/advisory/ask-async',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentUser(req);
      const caseId = String(req.params.id);
      const question = typeof (req.body as { question?: unknown } | undefined)?.question === 'string'
        ? (req.body as { question: string }).question.trim()
        : '';
      if (question.length === 0) throw new HttpError(400, 'bad_request', 'A question is required.');
      const view = user.role === 'physician' ? 'physician_chart' : 'rn_chart';
      // Insert the pending row FIRST (so the client has a stable id to poll), then fire the async compute.
      const row = await db.advisoryQuery.create({
        data: { caseId, userId: user.sub, userRole: user.role, view, question, status: 'pending', modeRan: [] },
      });
      // Fail-open: if the self-invoke doesn't dispatch, the row stays pending and the poll times out to a
      // calm retry — submit itself never 500s.
      await fireAdvisoryAnswer(row.id, caseId);
      res.status(202).json({ data: { queryId: row.id, status: 'pending' } });
    }),
  );

  // Poll ONE advisory query by id (case-scoped). status: pending → then terminal (ok | thin | empty |
  // degraded | error | refused). The worker runs the same self-check/sanitize as /ask BEFORE it writes
  // `answer`, so an unsafe answer is never persisted and therefore never pollable.
  router.get(
    '/cases/:id/advisory/queries/:queryId',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const queryId = String(req.params.queryId);
      const row = await db.advisoryQuery.findFirst({ where: { id: queryId, caseId } });
      if (row === null) throw new HttpError(404, 'not_found', 'Query not found', { caseId, queryId });
      res.json({
        data: {
          id: row.id,
          question: row.question,
          status: row.status,
          answer: row.answer ?? null,
          citations: row.citationsJson ?? null,
          costUsd: row.costUsd ?? null,
          createdAt: row.createdAt,
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
