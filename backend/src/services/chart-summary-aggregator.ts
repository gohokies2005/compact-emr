import type { AppDb, CaseRecord, CdsVerdict } from './db-types.js';

/**
 * Phase 7B-revised Build 1: chart summary aggregator for the Doctor Pack cover page.
 *
 * Produces the structured `ChartSummary` object that the PDF assembler (Phase 7A worker)
 * renders as page 1 of the Doctor Pack. The physician sees this before flipping into the
 * page-selected source documents — so the summary needs to be tight, factual, and load-bearing
 * for the clinical decision they're about to make.
 *
 * Per architect plan (commit `80caff7` §"Cover-page lives in DoctorPack.manifestJson.coverPage"),
 * the result is persisted into `DoctorPack.manifestJson.coverPage` rather than its own table —
 * ephemeral 1:1 metadata, regenerated on every Generate.
 */

export const CHART_SUMMARY_VERSION = 'chart-summary-1.0.0';

export interface ChartSummaryVeteranBlock {
  readonly fullName: string;
  readonly dob: string | null;
  readonly branch: string;
  readonly serviceDates: string;
  readonly combatVeteran: string;
  readonly pactArea: string;
  readonly teraConceded: string;
}

export interface ChartSummary {
  readonly veteran: ChartSummaryVeteranBlock;
  readonly caseRow: {
    readonly id: string;
    readonly claimedCondition: string;
    readonly claimType: string;
    readonly framingChoice: string | null;
    readonly upstreamScCondition: string | null;
    readonly status: string;
  };
  readonly serviceConnectedConditions: readonly string[];
  readonly activeProblems: readonly string[];
  readonly activeMedications: readonly { drugName: string; dose: string | null; indication: string | null }[];
  readonly cdsVerdict: CdsVerdict;
  readonly cdsOddsPct: number | null;
  readonly cdsRationale: Record<string, unknown> | null;
  readonly veteranStatement: string | null;
  readonly inServiceEvent: string | null;
  readonly generatedAt: string;
  readonly version: string;
}

interface AggregateInput {
  readonly db: AppDb;
  readonly caseRow: Pick<CaseRecord, 'id' | 'claimedCondition' | 'claimType' | 'framingChoice' | 'upstreamScCondition' | 'status' | 'veteranId' | 'cdsVerdict' | 'cdsOddsPct' | 'cdsRationale' | 'veteranStatement' | 'inServiceEvent'>;
}

function formatServiceDates(start: number | null, end: number | null): string {
  if (start === null || end === null) return 'unknown';
  if (start === end) return String(start);
  return `${start}–${end}`;
}

function yesNoUnknownLabel(value: string): string {
  if (value === 'yes') return 'Yes';
  if (value === 'no') return 'No';
  return 'Unknown';
}

/**
 * Pull all the chart data needed to render the Doctor Pack cover page in a single $transaction.
 * Returns null when the case or veteran can't be found (caller responsibility to handle).
 */
export async function aggregateChartSummary(input: AggregateInput): Promise<ChartSummary | null> {
  const { db, caseRow } = input;

  // Veteran lookup includes SC conditions, active problems, active medications.
  // The Prisma delegate type doesn't include the relations on findFirst — cast through unknown
  // since we know the include shape (this matches the pattern used elsewhere in the codebase).
  const veteranWithChart = (await db.veteran.findFirst({
    where: { id: caseRow.veteranId, inactive: false },
    include: {
      scConditions: { orderBy: { condition: 'asc' } },
      activeProblems: { orderBy: { problem: 'asc' } },
      activeMedications: { orderBy: { drugName: 'asc' } },
    },
  })) as unknown as
    | (null)
    | {
        firstName: string;
        lastName: string;
        dob: Date | null;
        branch: string;
        serviceStartYear: number | null;
        serviceEndYear: number | null;
        combatVeteran: string;
        pactArea: string;
        teraConceded: string;
        scConditions: readonly { condition: string }[];
        activeProblems: readonly { problem: string }[];
        activeMedications: readonly { drugName: string; dose: string | null; indication: string | null }[];
      };

  if (veteranWithChart === null) return null;

  return {
    veteran: {
      fullName: `${veteranWithChart.firstName} ${veteranWithChart.lastName}`.trim(),
      dob: veteranWithChart.dob ? veteranWithChart.dob.toISOString().slice(0, 10) : null,
      branch: veteranWithChart.branch,
      serviceDates: formatServiceDates(veteranWithChart.serviceStartYear, veteranWithChart.serviceEndYear),
      combatVeteran: yesNoUnknownLabel(veteranWithChart.combatVeteran),
      pactArea: yesNoUnknownLabel(veteranWithChart.pactArea),
      teraConceded: yesNoUnknownLabel(veteranWithChart.teraConceded),
    },
    caseRow: {
      id: caseRow.id,
      claimedCondition: caseRow.claimedCondition,
      claimType: caseRow.claimType,
      framingChoice: caseRow.framingChoice,
      upstreamScCondition: caseRow.upstreamScCondition,
      status: caseRow.status,
    },
    serviceConnectedConditions: veteranWithChart.scConditions.map((s) => s.condition),
    activeProblems: veteranWithChart.activeProblems.map((p) => p.problem),
    activeMedications: veteranWithChart.activeMedications.map((m) => ({
      drugName: m.drugName,
      dose: m.dose,
      indication: m.indication,
    })),
    cdsVerdict: caseRow.cdsVerdict,
    cdsOddsPct: caseRow.cdsOddsPct,
    cdsRationale: caseRow.cdsRationale,
    veteranStatement: caseRow.veteranStatement,
    inServiceEvent: caseRow.inServiceEvent,
    generatedAt: new Date().toISOString(),
    version: CHART_SUMMARY_VERSION,
  };
}
