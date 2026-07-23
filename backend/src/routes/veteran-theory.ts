// GET /cases/:id/veteran-theory — the physician page's pre-sign reconciliation payload. Two LLM overlays,
// each behind its OWN flag, both DISPLAY-ONLY and fail-open to { data: null }:
//   1. Part B "Ankle nowhere" (Ryan 2026-07-11): runVeteranTheoryAi restates the veteran's OWN causal theory
//      from their literal statement. This route is the SINGLE IMPORTER of veteran-theory-ai.ts (the
//      drafter-isolation invariant, enforced by veteran-theory-drafter-isolation.test.ts).
//   2. Letter-vs-veteran (Dr. Kasky 2026-07-22): runLetterTheoryAi reads the ACTUAL drafted letter's §VII
//      opinion and returns what the LETTER argues (letterTheory) + a plain "where they differ" line
//      (difference). The route-picker plan diverges from the drafted letter BY DESIGN, so the panel reads the
//      letter here instead of the plan. runLetterTheoryAi is a SEPARATE module (it reads letter text, not
//      drafter code) so the veteran-theory-ai single-importer invariant is untouched.
//
// A lazy sub-resource (mirrors case-viability.ts): the letter-ready panel renders first, this lazy-loads, and
// on { data: null } the UI falls back to the deterministic Part A line. Both flags off -> { data: null } with
// NO case read and NO model call (zero spend). Unknown case id -> 404. Any failure inside either model call
// fails open to null for that overlay (a display value can NEVER 500 the physician panel).
import { Router, type Request, type Response } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { runVeteranTheoryAi, veteranTheoryAiEnabled } from '../advisory/veteran-theory-ai.js';
import { runLetterTheoryAi, letterTheoryAiEnabled } from '../advisory/letter-theory-ai.js';
import { resolveViewableCurrentTxtWithHash } from '../services/letter-current.js';
import { extractOpinionFull } from '../services/letter-opinion-excerpt.js';

export interface VeteranTheoryDeps {
  readonly s3?: S3Client;
  readonly bucketName?: string;
}

interface CaseRow {
  readonly id: string;
  readonly claimedCondition: string | null;
  readonly veteranStatement: string | null;
  readonly currentVersion: number | null;
}

// Resolve the CURRENT letter the physician sees, extract its §VII opinion, and read what the LETTER argues.
// Fail-open to null at every step (S3 unconfigured, letter missing/unreadable, no §VII, LLM null) so the
// panel falls back to the deterministic plan-based line. runLetterTheoryAi itself never throws; the S3
// resolution can, so it is wrapped.
async function reconcileLetterVsVeteran(
  db: AppDb,
  deps: VeteranTheoryDeps,
  c: CaseRow,
): Promise<{ letterTheory: string; difference: string | null } | null> {
  if (deps.s3 === undefined || deps.bucketName === undefined || deps.bucketName.length === 0) return null;
  const currentVersion = typeof c.currentVersion === 'number' ? c.currentVersion : 0;
  let resolved: Awaited<ReturnType<typeof resolveViewableCurrentTxtWithHash>>;
  try {
    resolved = await resolveViewableCurrentTxtWithHash(db, deps.s3, deps.bucketName, c.id, currentVersion);
  } catch {
    return null; // no current OPENABLE letter / transient S3 error -> fail open
  }
  if (resolved === null) return null;
  const sectionVii = extractOpinionFull(resolved.txt);
  if (sectionVii === null) return null; // non-canonical letter with no readable §VII -> nothing to read
  const res = await runLetterTheoryAi({ caseId: c.id, veteranStatement: c.veteranStatement ?? '', sectionVii });
  return res === null ? null : { letterTheory: res.letterTheory, difference: res.difference };
}

export function createVeteranTheoryRouter(db: AppDb, deps: VeteranTheoryDeps = {}): Router {
  const router = Router();
  router.get(
    '/cases/:id/veteran-theory',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const vetEnabled = veteranTheoryAiEnabled();
      const letterEnabled = letterTheoryAiEnabled();
      // Both flags off -> { data: null } (the UI shows the deterministic Part A line). No case read, no spend.
      if (!vetEnabled && !letterEnabled) {
        res.json({ data: null });
        return;
      }
      const c = (await db.case.findFirst({
        where: { id: caseId },
        select: { id: true, claimedCondition: true, veteranStatement: true, currentVersion: true },
      })) as CaseRow | null;
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // Overlay 1 — the veteran's OWN theory (Part B). Its own flag; runVeteranTheoryAi never throws (fails
      // open internally), but the extra guard means a display value can NEVER 500 the panel.
      let vet: Awaited<ReturnType<typeof runVeteranTheoryAi>> = null;
      if (vetEnabled) {
        try {
          vet = await runVeteranTheoryAi({
            caseId,
            claimedCondition: c.claimedCondition ?? '',
            veteranStatement: c.veteranStatement ?? '',
          });
        } catch {
          vet = null;
        }
      }

      // Overlay 2 — what the LETTER argues, read from its §VII opinion (Dr. Kasky 2026-07-22). Its own flag.
      let letter: { letterTheory: string; difference: string | null } | null = null;
      if (letterEnabled) {
        try {
          letter = await reconcileLetterVsVeteran(db, deps, c);
        } catch {
          letter = null;
        }
      }

      // Nothing produced -> keep the null contract so the panel falls back cleanly (loses nothing).
      if (vet === null && letter === null) {
        res.json({ data: null });
        return;
      }

      // costUsd is server-side telemetry (logged) — do NOT ship it to the browser. A null in any field passes
      // through unchanged: the frontend surfaces the payload when EITHER `theory` or `letterTheory` is present.
      const data = {
        theory: vet?.theory ?? null,
        framing: vet?.framing ?? null,
        upstream: vet?.upstream ?? null,
        letterTheory: letter?.letterTheory ?? null,
        difference: letter?.difference ?? null,
      };
      res.json({ data });
    }),
  );
  return router;
}
