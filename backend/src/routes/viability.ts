import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { evaluateViabilityGate } from '../services/viability-gate.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import type { AppDb } from '../services/db-types.js';

export function createViabilityRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/cases/:id/viability
   *
   * Run the pre-draft viability gate against a case. Pure / deterministic / no LLM. Returns
   * one of four verdicts (go / clarify / needs_from_vet / not_viable) plus blockers and
   * recommendations. The endpoint does NOT mutate the case — it is a read-only signal that
   * the UI uses to gate the "draft now" action.
   */
  router.post(
    '/cases/:id/viability',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);

      const c = await db.case.findFirst({
        where: { id: caseId },
        select: {
          id: true,
          veteranId: true,
          status: true,
          claimedCondition: true,
          claimType: true,
          framingChoice: true,
          upstreamScCondition: true,
          assignedPhysicianId: true,
          cdsVerdict: true,
        },
      });
      if (c === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });

      const cw = c as typeof c & { veteranId: string };
      const [activeProblems, fileRows] = await Promise.all([
        db.activeProblem.findMany({ where: { veteranId: cw.veteranId }, select: { problem: true } }),
        db.fileReadStatus.findMany({ where: { caseId } }),
      ]);

      const chartReadiness = evaluateChartReadiness(fileRows);

      const result = evaluateViabilityGate({
        caseRow: {
          id: c.id,
          status: c.status,
          claimedCondition: c.claimedCondition,
          claimType: c.claimType,
          framingChoice: c.framingChoice,
          upstreamScCondition: c.upstreamScCondition,
          assignedPhysicianId: c.assignedPhysicianId,
          cdsVerdict: c.cdsVerdict,
        },
        activeProblems: activeProblems as readonly { problem: string }[],
        chartReadiness: { ready: chartReadiness.ready, manualSummaryRequired: chartReadiness.manualSummaryRequired },
        cdsEnabled: process.env['CDS_ENABLED'] === 'on',
      });

      res.json({ data: result });
    }),
  );

  return router;
}
