/**
 * Applies an extraction result to the DB — the SINGLE writer of source='extracted' chart rows.
 *
 * ALWAYS records the run (result_json audit + status='complete' + counts), so the build-state
 * derivation flips to chart_ready and the dark/shadow run is reviewable. Writes actual chart rows
 * (sc_conditions / active_problems / active_medications) ONLY when CHART_AUTOFILL='on' — shadow
 * mode (the default) extracts + records but never touches the chart, so we can eyeball real cases
 * before a single auto row lands. The merge is non-destructive (manual rows immutable; prior
 * extracted rows not clobbered; synonym-dedup) via planMerge.
 */

import { planMerge, type ExistingChartRow } from './chart-merge.js';
import { EXTRACTED_SOURCE, EXTRACTOR_VERSION } from './chart-build-state.js';
import type { FinalExtractedItem } from './chart-extract-llm.js';
import type { AppDb } from './db-types.js';

export interface ApplyExtractionInput {
  caseId: string;
  veteranId: string;
  runId: string;
  items: FinalExtractedItem[];
  costUsd?: number;
  // Coverage/truncation signals from the extractor (audit 2026-06-13 ROOT FIX). When either is >0 the
  // extraction was INCOMPLETE — the run is stamped 'complete_with_gaps' (still chart_ready, but the RN is
  // flagged) so a gapped chart is never silently mistaken for a clean parse. Previously these were
  // computed by the worker, logged, and DROPPED at this boundary while status was stamped a bald 'complete'.
  truncatedWindows?: number;
  uncoveredPages?: number;
  fullRead?: boolean;
}

export interface ApplyExtractionResult {
  autofill: boolean;
  written: number;
  skippedManual: number;
  skippedPriorExtracted: number;
  skippedDuplicate: number;
}

interface NameSource { name: string; source: string }

export async function applyExtractionMerge(db: AppDb, input: ApplyExtractionInput): Promise<ApplyExtractionResult> {
  const autofill = process.env['CHART_AUTOFILL'] === 'on';
  const now = new Date();

  const scDelegate = (db as unknown as {
    scCondition: {
      findMany: (a: { where: { veteranId: string }; select: { condition: true; source: true } }) => Promise<NameSource[] | { condition: string; source: string }[]>;
      create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
    };
  }).scCondition;
  const medDelegate = (db as unknown as {
    activeMedication: {
      findMany: (a: { where: { veteranId: string }; select: { drugName: true; source: true; medStatus: true; startDate: true; lastSeenDate: true } }) => Promise<{ drugName: string; source: string; medStatus: string | null; startDate: string | null; lastSeenDate: string | null }[]>;
      create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
    };
  }).activeMedication;
  const runDelegate = (db as unknown as {
    chartExtractionRun: { update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> };
  }).chartExtractionRun;

  // Load existing chart rows (with source) so the merge can protect manual + prior-extracted rows.
  const [scRows, problemRows, medRows] = await Promise.all([
    scDelegate.findMany({ where: { veteranId: input.veteranId }, select: { condition: true, source: true } }) as Promise<{ condition: string; source: string }[]>,
    (db as unknown as { activeProblem: { findMany: (a: { where: { veteranId: string }; select: { problem: true; source: true } }) => Promise<{ problem: string; source: string }[]> } })
      .activeProblem.findMany({ where: { veteranId: input.veteranId }, select: { problem: true, source: true } }),
    medDelegate.findMany({ where: { veteranId: input.veteranId }, select: { drugName: true, source: true, medStatus: true, startDate: true, lastSeenDate: true } }),
  ]);
  const existing: ExistingChartRow[] = [
    ...scRows.map((r) => ({ category: 'sc_condition' as const, name: r.condition, source: r.source })),
    ...problemRows.map((r) => ({ category: 'active_problem' as const, name: r.problem, source: r.source })),
    // Carry med temporality so the merge key matches the extracted key (active vs historical/year).
    ...medRows.map((r) => ({ category: 'active_medication' as const, name: r.drugName, source: r.source, medStatus: r.medStatus, startDate: r.startDate, lastSeenDate: r.lastSeenDate })),
  ];

  const plan = planMerge(existing, input.items);

  await db.$transaction(async (tx) => {
    if (autofill) {
      const txAny = tx as unknown as {
        scCondition: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
        activeProblem: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
        activeMedication: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
      };
      for (const it of plan.toInsert) {
        const prov = {
          source: EXTRACTED_SOURCE,
          sourceDocumentId: it.sourceDocumentId,
          sourcePage: it.sourcePage,
          sourceQuote: it.sourceQuote,
          confidence: it.confidence,
          needsReview: it.needsReview,
          extractedAt: now,
          extractionRunId: input.runId,
        };
        if (it.category === 'sc_condition') {
          // Default an UNMAPPED/absent SC status to `pending`, NOT `service_connected` (audit 2026-06-13,
          // 2-agent consensus). `service_connected` is the privileged value — defaulting to it can write a
          // GRANTED SC the records don't support, which then becomes a framing anchor (case-framing builds
          // grantedScAnchors from status==='service_connected'). `pending` can't anchor a theory and surfaces
          // for RN confirmation. Matches the existing "deferred/claimed → pending, never SC" sanitizer intent.
          await txAny.scCondition.create({ data: { veteranId: input.veteranId, condition: it.name, status: it.status ?? 'pending', ...(it.ratingPct != null ? { ratingPct: it.ratingPct } : {}), ...(it.dcCode ? { dcCode: it.dcCode } : {}), ...prov } });
        } else if (it.category === 'active_problem') {
          await txAny.activeProblem.create({ data: { veteranId: input.veteranId, problem: it.name, ...(it.icd10 ? { icd10: it.icd10 } : {}), ...prov } });
        } else {
          await txAny.activeMedication.create({ data: { veteranId: input.veteranId, drugName: it.name, ...(it.dose ? { dose: it.dose } : {}), ...(it.frequency ? { frequency: it.frequency } : {}), ...(it.indication ? { indication: it.indication } : {}), ...(it.medStatus ? { medStatus: it.medStatus } : {}), ...(it.startDate ? { startDate: it.startDate } : {}), ...(it.lastSeenDate ? { lastSeenDate: it.lastSeenDate } : {}), ...prov } });
        }
      }
    }

    const hasGaps = (input.truncatedWindows ?? 0) > 0 || (input.uncoveredPages ?? 0) > 0;
    await runDelegate.update({
      where: { id: input.runId },
      data: {
        status: hasGaps ? 'complete_with_gaps' : 'complete',
        itemsWritten: autofill ? plan.toInsert.length : 0,
        itemsSkipped: plan.skippedManual + plan.skippedPriorExtracted + plan.skippedDuplicate,
        resultJson: {
          autofill,
          // Stamp the extractor version so the reprocess cost-safety gate can re-extract a case
          // whose last run predates a chart-extract code fix (the Hackworth stale-extraction trap).
          extractorVersion: EXTRACTOR_VERSION,
          costUsd: input.costUsd ?? null,
          items: input.items,
          skipped: { manual: plan.skippedManual, priorExtracted: plan.skippedPriorExtracted, duplicate: plan.skippedDuplicate },
          gaps: { truncatedWindows: input.truncatedWindows ?? 0, uncoveredPages: input.uncoveredPages ?? 0, fullRead: input.fullRead ?? null },
        },
        completedAt: now,
      },
    });
  }, { timeout: 30_000, maxWait: 10_000 });

  return {
    autofill,
    written: autofill ? plan.toInsert.length : 0,
    skippedManual: plan.skippedManual,
    skippedPriorExtracted: plan.skippedPriorExtracted,
    skippedDuplicate: plan.skippedDuplicate,
  };
}
