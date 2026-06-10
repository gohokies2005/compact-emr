// GET /cases/:id/strategy-preview — the pre-draft strategy card's data. Computes the viability tier LIVE
// from the chart (never the stale Case.cdsVerdict column) via the deterministic strategy-preview service.
// Read-only; both the RN/ops and physician views.

import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { computeStrategyPreview } from '../services/strategy-preview.js';
import { deriveCaseFramingForCase } from '../services/case-framing-stamp.js';

interface CaseForPreview {
  claimType: string | null;
  claimedCondition: string;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  inServiceEvent: string | null;
  veteranStatement: string | null;
  veteran: {
    scConditions: Array<{ condition: string; status: string }>;
    activeProblems: Array<{ problem: string }>;
  } | null;
}

export function createStrategyPreviewRouter(db: AppDb): Router {
  const router = Router();
  router.get(
    '/cases/:id/strategy-preview',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const c = (await db.case.findFirst({
        where: { id: caseId },
        select: {
          claimType: true,
          claimedCondition: true,
          framingChoice: true,
          upstreamScCondition: true,
          inServiceEvent: true,
          veteranStatement: true,
          veteran: {
            select: {
              scConditions: { select: { condition: true, status: true } },
              activeProblems: { select: { problem: true } },
            },
          },
        },
      })) as CaseForPreview | null;
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      // SSOT consumption (version-gated, fail-open): when the v1 caseFraming derives, source the
      // framing/upstream/anchor-list inputs from it — the granted-anchor list replaces the local
      // status re-filter and the framing theory replaces the raw column (build plan §2.5). The
      // strategy-preview service itself is untouched; its effective-anchor recovery now simply
      // operates on SSOT-sourced inputs. Absent → exact legacy inputs.
      const cf = await deriveCaseFramingForCase(db, caseId);
      const useSsot = cf !== null && cf.version === 1;

      const preview = computeStrategyPreview({
        claimedCondition: c.claimedCondition,
        claimType: c.claimType ?? '',
        framingChoice: useSsot && cf.framing !== 'undetermined' ? cf.framing : c.framingChoice,
        upstreamScCondition: useSsot ? cf.upstreamScCondition : c.upstreamScCondition,
        // Only GRANTED conditions are valid anchors — a pending/denied claim is not yet service-connected,
        // so a secondary theory hung on it isn't viable (architect QA FIX-1: don't show "Strong" on an
        // ungranted anchor). With the SSOT present the strict-filtered, deduped grantedScAnchors ARE that
        // list; the legacy local status filter remains only as the fail-open path.
        serviceConnectedConditions: useSsot
          ? cf.grantedScAnchors.map((a) => a.condition)
          : (c.veteran?.scConditions ?? [])
            .filter((s) => s.status === 'service_connected')
            .map((s) => s.condition),
        activeProblems: (c.veteran?.activeProblems ?? []).map((p) => p.problem),
        // Prefer the veteran's OWN stated theory for display ("why I think this is connected", even if
        // wildly wrong — Ryan 2026-06-07); fall back to the extracted in-service event.
        proposedMechanism: c.veteranStatement ?? c.inServiceEvent ?? null,
      });
      res.json({ data: preview });
    }),
  );
  return router;
}
