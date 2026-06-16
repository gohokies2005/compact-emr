// POST /cases/:id/recommendation-email — drafts the short customer outreach email shown in the
// Overview "Recommended plan" section (2026-06-16). The FRONTEND ran the one-brain recommendedPlan
// selector and passes the recommendation KIND + its specifics (missingFact / bridge); this route does
// NOT re-decide the plan (one brain). It pulls the veteran first name + claimed condition from the
// case row (never trusts the client for those), then calls the Sonnet drafter. Read-only on the DB;
// RN/ops/physician. NEVER auto-sends — returns a draft for the staffer to copy + edit.

import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { draftOutreachEmail, type OutreachKind, type OutreachBridge } from '../services/outreach-email.js';

interface CaseForEmail {
  claimedCondition: string;
  veteran: { firstName: string | null } | null;
}

// Bound the engine-supplied free text the client hands us (these are short condition/record labels,
// never prose) so a malformed/oversized body can't inflate the prompt or smuggle a long payload.
const cap = (s: string): string => s.slice(0, 600);

function parseBridge(v: unknown): OutreachBridge | null {
  if (v === null || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (typeof b['intermediate_dx'] !== 'string' || typeof b['claimed'] !== 'string') return null;
  return {
    intermediate_dx: cap(b['intermediate_dx']),
    claimed: cap(b['claimed']),
    intermediate_presumptive_basis: typeof b['intermediate_presumptive_basis'] === 'string' ? cap(b['intermediate_presumptive_basis']) : '',
  };
}

export function createRecommendationEmailRouter(db: AppDb): Router {
  const router = Router();
  router.post(
    '/cases/:id/recommendation-email',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = body['kind'];
      if (kind !== 'contact_records' && kind !== 'contact_alternative') {
        throw new HttpError(400, 'bad_request', 'kind must be contact_records or contact_alternative', { kind });
      }
      const c = (await db.case.findFirst({
        where: { id: caseId },
        select: { claimedCondition: true, veteran: { select: { firstName: true } } },
      })) as CaseForEmail | null;
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const result = await draftOutreachEmail({
        kind: kind as OutreachKind,
        firstName: c.veteran?.firstName ?? null,
        claimedCondition: c.claimedCondition,
        missingFact: typeof body['missingFact'] === 'string' ? cap(body['missingFact']) : null,
        bridge: parseBridge(body['bridge']),
      });
      res.json({ data: result });
    }),
  );
  return router;
}
