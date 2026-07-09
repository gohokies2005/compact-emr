import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import type { AppDb, CaseStatus } from '../services/db-types.js';
import { pacificDayStartUtc, DASHBOARD_TIMEZONE } from '../services/pacific-day.js';
import { isStage1 } from '../services/intake-kind.js';

/**
 * D1 — dashboard metrics backend (2026-06-13).
 *
 * ONE read-only endpoint, `GET /api/v1/reports/dashboard`, returning every dashboard tile's count
 * PLUS a declarative `filter` contract per tile so the frontend (D2) can deep-link a tile to the
 * filtered list that reproduces its count. It replaces the old client-side HomePage tile math
 * (frontend/src/routes/HomePage.tsx), which fired ~7 separate listCases calls, fetched 100 cases
 * just to count "today" in the BROWSER's timezone (wrong for a Pacific shop), and split "pre-draft"
 * differently from the canonical statusDisplayGroup. This endpoint is the single source of truth.
 *
 * Read-only: it issues only count() / findMany(select) reads, no writes, no migrations.
 *
 * Role gate: ['admin', 'ops_staff'] — matches the staff cases list (createCasesRouter's POST/PATCH/
 * assignment routes). Physicians have their own /p/queue and do not see the ops dashboard, so they
 * are intentionally excluded (confirmed against HomePage, which redirects role==='physician' away).
 *
 * Efficiency: the tile counts are independent COUNT(*) probes issued in ONE Promise.all batch. The
 * hand-written AppDb facade (services/db-types.ts) exposes count()/findMany() but NOT groupBy, so a
 * single groupBy(['status']) is not reachable without casting out of the typed facade — and each
 * count is already a cheap indexed scan (cases has @@index([status, updatedAt]); intakes
 * @@index([status, createdAt]); draft_jobs @@index([state]); payments @@index([kind])/@@index([status])).
 * The batch is one round of parallel reads, not an N+1 over rows.
 */

// ── Display-group status sets (mirror frontend/src/lib/caseStatus.ts STATUS_DISPLAY_GROUP) ──
// These are the canonical buckets the RN thinks in. Kept in sync with caseStatus.ts; the enum
// values are unchanged. A group tile's count is COUNT(status IN set) so it == the list the frontend
// renders when it filters to the same set.

// "Pre-draft" per statusDisplayGroup = intake + viability ONLY. (NOTE: 'records' is its OWN bucket,
// 'Awaiting records', alongside needs_records — so it is NOT counted here. The old HomePage lumped
// records+viability+drafting under "pre-draft"; we follow the canonical statusDisplayGroup instead,
// which is the contract the cases-list grouping uses. Divergence called out in the D1 report.)
const PRE_DRAFT_STATUSES: readonly CaseStatus[] = ['intake', 'viability'];

// "RN review" per statusDisplayGroup = the cases whose ball is in the RN's court: a completed-draft
// awaiting triage (rn_review), a Gate-2 park needing an RN decision (needs_rn_decision), and the two
// correction-round states (correction_requested, correction_review). This is the case-status RN
// queue. It is DISTINCT from tile 5 (the narrow status='rn_review' only) and from the HomePage "RN
// queue" widget (which counts unreadable-file + key-doc review work, a different kind of queue).
const RN_REVIEW_GROUP_STATUSES: readonly CaseStatus[] = [
  'rn_review',
  'needs_rn_decision',
  'correction_requested',
  'correction_review',
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const STUCK_DRAFT_MS = 45 * 60 * 1000; // a DraftJob started >45m ago and not progressing
const STALE_HEARTBEAT_MS = 10 * 60 * 1000; // mirrors the stuck-job watcher's staleness window

/** A declarative filter contract the frontend passes to its existing list endpoints to reproduce a
 *  tile's count. `kind` selects the list; the remaining fields are the list's query params. Group
 *  tiles emit `statuses[]` (multi-status, the frontend issues one call per status or unions them);
 *  single-status tiles emit `status`. Non-clickable tiles emit no filter. */
type TileFilter =
  | { kind: 'cases'; status: CaseStatus }
  | { kind: 'cases'; statuses: readonly CaseStatus[] }
  | { kind: 'cases'; status: CaseStatus; unpaidLetter500OlderThanDays: number }
  | { kind: 'intakes'; createdSince: string }
  | { kind: 'intakes'; status: string; olderThanDays: number }
  | { kind: 'draft-jobs'; stuck: true; startedBeforeMinutes: number; staleHeartbeat: boolean }
  | { kind: 'veterans' };

interface Tile {
  key: string;
  label: string;
  count?: number;
  /** #2 only: a duration metric (not a list). null when uncomputable (with a `reason`). */
  value?: number | null;
  unit?: string;
  reason?: string;
  clickable: boolean;
  filter?: TileFilter;
}

interface DashboardResponse {
  generatedAt: string;
  /** The timezone the "today" boundary (tile 1) is measured in — so the UI can label it honestly. */
  timezone: string;
  /** The exact Pacific-midnight instant tile 1 counted from (also the intakes filter's createdSince). */
  pacificMidnightUtc: string;
  tiles: Tile[];
}

export function createDashboardRouter(db: AppDb): Router {
  const router = Router();

  router.get(
    '/reports/dashboard',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (_req: Request, res: Response) => {
      const now = new Date();
      const pacificMidnight = pacificDayStartUtc(now);
      const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);
      const threeDaysAgo = new Date(now.getTime() - THREE_DAYS_MS);
      const stuckBefore = new Date(now.getTime() - STUCK_DRAFT_MS);
      const staleHeartbeatBefore = new Date(now.getTime() - STALE_HEARTBEAT_MS);

      // ── Tile 8 (delinquent payments) where: a 'delivered' case (physician-approved, pre-payment)
      // whose letter_500 is NOT yet paid, sitting >3 days. "Unpaid" = no letter_500 Payment row at
      // status 'paid' (a row at 'invoiced' is sent-but-unpaid; NO row is invoice-not-yet-sent — both
      // are unpaid). >3 days uses Case.updatedAt as the delivered-since proxy (there is no dedicated
      // delivered_at column; updatedAt is when the case last moved, which for a stalled delivered
      // case is when it landed delivered). Approximation noted in the D1 report.
      const delinquentPaymentsWhere = {
        status: 'delivered',
        archivedAt: null, // exclude archived (given-up) cases — still payable if the customer
        // returns (unarchiving re-counts them), but they should not nag on the dashboard. Matches
        // the archivedAt:null filter every other case tile uses. (Ryan 2026-07-09.)
        updatedAt: { lt: threeDaysAgo },
        payments: { none: { kind: 'letter_500', status: 'paid' } },
      };

      // ── Tile 9 (stuck drafts): a DraftJob in 'running' that started >45m ago AND whose heartbeat is
      // stale (>10m). DraftJob HAS lastHeartbeatAt (the stuck-job watcher keys on it), so we use the
      // precise "started old AND heartbeat stale" definition rather than age-only. queued jobs are
      // excluded (they have not started); 'halted' is a Gate-2 park (intentional, not stuck).
      const stuckDraftsWhere = {
        state: 'running',
        startedAt: { lt: stuckBefore },
        OR: [
          { lastHeartbeatAt: { lt: staleHeartbeatBefore } },
          { lastHeartbeatAt: null }, // started, never heartbeat → also stuck
        ],
      };

      const [
        newIntakesToday,
        rnReviewGroup,
        preDraft,
        rnReview,
        physicianReview,
        delinquentIntakes,
        delinquentPayments,
        stuckDrafts,
        totalVeterans,
        stage1Turnaround,
      ] = await Promise.all([
        // 1. NEW intakes today (since Pacific midnight) — STAGE-1 ONLY. A returning veteran files both a
        // stage-1 AND a stage-2 form, so a raw row count double-counted them (Ryan 2026-06-16). We
        // classify with the same intakeKind the pool UI uses and count only stage-1 (new veteran/claim).
        countNewStage1IntakesToday(db, pacificMidnight),
        // 3. RN queue (RN-review display group)
        db.case.count({ where: { status: { in: RN_REVIEW_GROUP_STATUSES }, archivedAt: null } }),
        // 4. pre-draft group
        db.case.count({ where: { status: { in: PRE_DRAFT_STATUSES }, archivedAt: null } }),
        // 5. rn_review (single status)
        db.case.count({ where: { status: 'rn_review', archivedAt: null } }),
        // 6. physician_review (single status)
        db.case.count({ where: { status: 'physician_review', archivedAt: null } }),
        // 7. delinquent intakes (see computeStage1TurnaroundOrNull comment for the Stage-1/2 caveat)
        db.intake.count({ where: { status: 'pending', createdAt: { lt: sevenDaysAgo } } }),
        // 8. delinquent payments
        db.case.count({ where: delinquentPaymentsWhere }),
        // 9. stuck drafts
        db.draftJob.count({ where: stuckDraftsWhere }),
        // 10. total veterans (exclude soft-deleted inactive — matches the veterans list default)
        db.veteran.count({ where: { inactive: false } }),
        // 2. 7-day Stage-1 turnaround (returns { value, reason } — see helper)
        computeStage1TurnaroundOrNull(db, sevenDaysAgo),
      ]);

      const tiles: Tile[] = [
        {
          key: 'new_intakes_today',
          label: 'New intakes today',
          count: newIntakesToday,
          clickable: true,
          filter: { kind: 'intakes', createdSince: pacificMidnight.toISOString() },
        },
        {
          key: 'stage1_turnaround_7d',
          // Measures intake-received → RN-picked-up-the-case, NOT letter delivery turnaround. The old
          // "Stage-1 turnaround" label read as a sub-24h LETTER TAT, which is wrong (letter TAT is ~14
          // days) — Ryan 2026-06-16. Label it for what it actually is: how fast we pick up new intakes.
          label: 'Avg intake-to-pickup (7d)',
          value: stage1Turnaround.value,
          unit: 'hours',
          ...(stage1Turnaround.reason !== undefined ? { reason: stage1Turnaround.reason } : {}),
          clickable: false, // the only non-clickable tile — a duration, not a list
        },
        {
          key: 'rn_queue',
          label: 'RN queue',
          count: rnReviewGroup,
          clickable: true,
          filter: { kind: 'cases', statuses: RN_REVIEW_GROUP_STATUSES },
        },
        {
          key: 'pre_draft',
          label: 'Pre-draft',
          count: preDraft,
          clickable: true,
          filter: { kind: 'cases', statuses: PRE_DRAFT_STATUSES },
        },
        {
          key: 'rn_review',
          label: 'RN review',
          count: rnReview,
          clickable: true,
          filter: { kind: 'cases', status: 'rn_review' },
        },
        {
          key: 'physician_review',
          label: 'Physician review',
          count: physicianReview,
          clickable: true,
          filter: { kind: 'cases', status: 'physician_review' },
        },
        {
          key: 'delinquent_intakes',
          label: 'Delinquent intakes',
          count: delinquentIntakes,
          clickable: true,
          filter: { kind: 'intakes', status: 'pending', olderThanDays: 7 },
        },
        {
          key: 'delinquent_payments',
          label: 'Delinquent payments',
          count: delinquentPayments,
          clickable: true,
          filter: { kind: 'cases', status: 'delivered', unpaidLetter500OlderThanDays: 3 },
        },
        {
          key: 'stuck_drafts',
          label: 'Stuck drafts',
          count: stuckDrafts,
          clickable: true,
          filter: { kind: 'draft-jobs', stuck: true, startedBeforeMinutes: 45, staleHeartbeat: true },
        },
        {
          key: 'total_veterans',
          label: 'Total veterans',
          count: totalVeterans,
          clickable: true,
          filter: { kind: 'veterans' },
        },
      ];

      const body: DashboardResponse = {
        generatedAt: now.toISOString(),
        timezone: DASHBOARD_TIMEZONE,
        pacificMidnightUtc: pacificMidnight.toISOString(),
        tiles,
      };
      res.json(body);
    }),
  );

  return router;
}

/**
 * Tile 1 — NEW intakes today (stage-1 only). Fetches today's intake rows (cheap: bounded to one
 * Pacific day, two small columns) and counts only the STAGE-1 submissions via the shared intakeKind
 * classifier, so a returning veteran's stage-2/records follow-up doesn't inflate the "new intakes"
 * number. Fail-soft: a DB hiccup returns 0 rather than 502-ing the whole dashboard.
 */
async function countNewStage1IntakesToday(db: AppDb, pacificMidnight: Date): Promise<number> {
  try {
    const rows = (await db.intake.findMany({
      where: { createdAt: { gte: pacificMidnight } },
      select: { jotformFormId: true, submittedFormTitle: true },
    })) as unknown as Array<{ jotformFormId: string | null; submittedFormTitle: string | null }>;
    return rows.filter((r) => isStage1(r.jotformFormId, r.submittedFormTitle)).length;
  } catch {
    return 0;
  }
}

/**
 * Tile 2 — 7-day average Stage-1 turnaround.
 *
 * "Stage-1" in this product is the Jotform intake (the first-time/returning intake form's Q&A). The
 * cleanest turnaround the schema CAN express is intake -> assigned: webhookReceivedAt (the intake
 * landed) to assignedAt (an RN created the veteran/case from it). Both columns exist on Intake, so
 * this is a real, defensible duration — NOT a fabricated number.
 *
 * IMPORTANT CAVEAT (reported, not silently encoded): the literal D1 prompt phrased Stage-1 around a
 * "Stage-1 PAID -> Stage-2 SUBMITTED" funnel. This schema does not model that: Intake carries no
 * payment linkage and no "Stage-2 submitted" marker (review_50 Payments attach to a Case, not an
 * Intake). So we cannot compute a paid->stage-2 duration. We report the well-defined intake->assigned
 * turnaround instead, and return null + a reason if there are no completed samples in the window
 * rather than a misleading 0.
 *
 * Window: intakes ASSIGNED in the last 7 days (assignedAt >= cutoff). Averaged in hours.
 */
async function computeStage1TurnaroundOrNull(
  db: AppDb,
  cutoff: Date,
): Promise<{ value: number | null; reason?: string }> {
  const assigned = (await db.intake.findMany({
    where: { status: 'assigned', assignedAt: { gte: cutoff } },
    select: { webhookReceivedAt: true, assignedAt: true },
  })) as unknown as Array<{ webhookReceivedAt: Date | null; assignedAt: Date | null }>;

  let sumMs = 0;
  let n = 0;
  for (const row of assigned) {
    if (row.webhookReceivedAt === null || row.assignedAt === null) continue;
    const start = row.webhookReceivedAt.getTime();
    const end = row.assignedAt.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue; // skip dirty rows
    sumMs += end - start;
    n += 1;
  }
  if (n === 0) {
    return { value: null, reason: 'no intakes assigned in the last 7 days to average' };
  }
  const avgHours = sumMs / n / (60 * 60 * 1000);
  return { value: Math.round(avgHours * 10) / 10 }; // 1 decimal place
}
