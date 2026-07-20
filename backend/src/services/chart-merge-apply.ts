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
import { fireRecomputeViability } from './recompute-viability-trigger.js';
import { EXTRACTED_SOURCE, EXTRACTOR_VERSION } from './chart-build-state.js';
import type { FinalExtractedItem } from './chart-extract-llm.js';
import type { AppDb, KeyDocType } from './db-types.js';
import { authorityTierForDocument, scStatusAuthoritativeFor, isProvenNonAuthoritativeTier, isScProvenanceEnforced, type ScAuthorityTier } from './sc-authority.js';

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
  /** prior-extracted pending SC rows promoted to service_connected by a later authoritative grant. */
  promoted: number;
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
      findMany: (a: { where: { veteranId: string }; select: { id: true; condition: true; source: true; status: true } }) => Promise<{ id: string; condition: string; source: string; status: string | null }[]>;
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
    scDelegate.findMany({ where: { veteranId: input.veteranId }, select: { id: true, condition: true, source: true, status: true } }),
    (db as unknown as { activeProblem: { findMany: (a: { where: { veteranId: string }; select: { problem: true; source: true } }) => Promise<{ problem: string; source: string }[]> } })
      .activeProblem.findMany({ where: { veteranId: input.veteranId }, select: { problem: true, source: true } }),
    medDelegate.findMany({ where: { veteranId: input.veteranId }, select: { drugName: true, source: true, medStatus: true, startDate: true, lastSeenDate: true } }),
  ]);
  const existing: ExistingChartRow[] = [
    // Carry id + status so the upgrade-on-merge promotion can target the row for an UPDATE + gate on pending.
    ...scRows.map((r) => ({ category: 'sc_condition' as const, name: r.condition, source: r.source, id: r.id, status: r.status })),
    ...problemRows.map((r) => ({ category: 'active_problem' as const, name: r.problem, source: r.source })),
    // Carry med temporality so the merge key matches the extracted key (active vs historical/year).
    ...medRows.map((r) => ({ category: 'active_medication' as const, name: r.drugName, source: r.source, medStatus: r.medStatus, startDate: r.startDate, lastSeenDate: r.lastSeenDate })),
  ];

  // SC-PROVENANCE (Woodley fix): classify the AUTHORITY of each SC row's source document over service-
  // connection (a VA rating decision is authoritative; a veteran goal-doc / lay statement / clinical note
  // is not). Computed deterministically from the Document (filename + docTag) — NEVER the model's judgment.
  // Build a documentId → tier map over ALL incoming SC items (both inserts AND promotion candidates); fail-
  // open to 'unknown' (non-authoritative) on any lookup miss. The DOWNGRADE (a non-authoritative
  // service_connected → pending) only bites when SC_PROVENANCE_ENFORCED is on; the tier is ALWAYS stamped so
  // the flip is data-ready. Computed BEFORE planMerge so the upgrade-on-merge gate can read the authority.
  const enforceProvenance = isScProvenanceEnforced();
  const scDocIds = Array.from(new Set(input.items.filter((i) => i.category === 'sc_condition' && i.sourceDocumentId).map((i) => i.sourceDocumentId as string)));
  const tierByDocId = new Map<string, ScAuthorityTier>();
  if (scDocIds.length > 0) {
    try {
      const docDelegate = (db as unknown as { document: { findMany: (a: { where: { id: { in: string[] } }; select: { id: true; filename: true; docTag: true } }) => Promise<{ id: string; filename: string | null; docTag: string | null }[]> } }).document;
      const docs = await docDelegate.findMany({ where: { id: { in: scDocIds } }, select: { id: true, filename: true, docTag: true } });
      for (const d of docs) tierByDocId.set(d.id, authorityTierForDocument({ docType: (d.docTag as KeyDocType | null) ?? undefined, filename: d.filename }));
    } catch { /* fail-open: leave the map empty → 'unknown' (non-authoritative) for every SC row */ }
  }
  const scTierFor = (docId: string | null | undefined): ScAuthorityTier => (docId && tierByDocId.get(docId)) || 'unknown';

  // Stamp the source-authority tier onto each incoming SC item so planMerge's upgrade-on-merge gate can see
  // whether a service_connected proposal comes from an authoritative rating decision (single source of the
  // tier — the insert path below reads the same stamp). Non-SC items are untouched.
  for (const it of input.items) {
    if (it.category === 'sc_condition') {
      const tier = scTierFor(it.sourceDocumentId);
      it.sourceAuthorityTier = tier;
      it.scStatusAuthoritative = scStatusAuthoritativeFor(tier);
    }
  }

  const plan = planMerge(existing, input.items);

  await db.$transaction(async (tx) => {
    if (autofill) {
      const txAny = tx as unknown as {
        scCondition: {
          create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
          update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
        };
        activeProblem: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
        activeMedication: { create: (a: { data: Record<string, unknown> }) => Promise<unknown> };
      };

      // UPGRADE-ON-MERGE (continuation-grant fix, 2026-07-19): PROMOTE a prior-extracted `pending` SC row to
      // `service_connected` when a later authoritative rating-decision grant lands (the bronchitis incident:
      // extracted pending, later granted → the grant row used to be skipped, leaving the stale pending). This
      // is an UPDATE, gated in planMerge (never manual, only pending → service_connected, authoritative tier,
      // monotonic up). Carry the grant's rating %/dcCode + refresh SC-provenance so the row reflects the VA
      // decision. version increments (optimistic-concurrency, mirrors the RN edit path).
      for (const promo of plan.toPromote) {
        if (!promo.target.id) continue; // no PK to target (defensive) — leave the row as-is
        const it = promo.incoming;
        const tier = scTierFor(it.sourceDocumentId);
        await txAny.scCondition.update({
          where: { id: promo.target.id },
          data: {
            status: 'service_connected',
            ...(it.ratingPct != null ? { ratingPct: it.ratingPct } : {}),
            ...(it.dcCode ? { dcCode: it.dcCode } : {}),
            source: EXTRACTED_SOURCE,
            sourceDocumentId: it.sourceDocumentId,
            sourcePage: it.sourcePage,
            sourceQuote: it.sourceQuote,
            confidence: it.confidence,
            needsReview: it.needsReview,
            extractedAt: now,
            extractionRunId: input.runId,
            sourceAuthorityTier: tier,
            scStatusAuthoritative: scStatusAuthoritativeFor(tier),
            version: { increment: 1 },
          },
        });
        console.warn(JSON.stringify({ event: 'sc_status_promoted_on_merge', veteranId: input.veteranId, condition: promo.target.name, from: 'pending', to: 'service_connected', tier, sourceDocumentId: it.sourceDocumentId }));
      }

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
          // SC-PROVENANCE (Woodley): stamp the source-document authority tier. When enforcing, a
          // service_connected from a NON-authoritative source (veteran goal-doc / lay statement / clinical
          // note) is WRITTEN as `pending` — the grant is unsettable from a non-VA-decision source. The
          // condition name is kept (real + useful); only the unverifiable grant is demoted.
          const tier = scTierFor(it.sourceDocumentId);
          const authoritative = scStatusAuthoritativeFor(tier);
          let scStatus = it.status ?? 'pending';
          // CONSERVATIVE downgrade (Ryan 2026-06-26): demote ONLY a PROVEN-non-authoritative source
          // (veteran_or_lay goal-doc/lay/intake). An unconfirmed source (unknown/clinical) is KEPT as the
          // grant + flagged for verification, NOT stripped (the dry-run proved blanket demotion vaporizes
          // real image-sourced grants). The tier+authoritative bit is still stamped for the verify flag.
          if (enforceProvenance && scStatus === 'service_connected' && isProvenNonAuthoritativeTier(tier)) {
            scStatus = 'pending';
            console.warn(JSON.stringify({ event: 'sc_status_downgraded_on_extract', veteranId: input.veteranId, condition: it.name, from: 'service_connected', to: 'pending', tier, sourceDocumentId: it.sourceDocumentId }));
          }
          await txAny.scCondition.create({ data: { veteranId: input.veteranId, condition: it.name, status: scStatus, ...(scStatus === 'service_connected' && it.ratingPct != null ? { ratingPct: it.ratingPct } : {}), ...(it.dcCode ? { dcCode: it.dcCode } : {}), ...prov, sourceAuthorityTier: tier, scStatusAuthoritative: authoritative } });
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
        itemsWritten: autofill ? plan.toInsert.length + plan.toPromote.length : 0,
        itemsSkipped: plan.skippedManual + plan.skippedPriorExtracted + plan.skippedDuplicate,
        resultJson: {
          autofill,
          // Stamp the extractor version so the reprocess cost-safety gate can re-extract a case
          // whose last run predates a chart-extract code fix (the Hackworth stale-extraction trap).
          extractorVersion: EXTRACTOR_VERSION,
          costUsd: input.costUsd ?? null,
          items: input.items,
          promoted: autofill ? plan.toPromote.length : 0,
          skipped: { manual: plan.skippedManual, priorExtracted: plan.skippedPriorExtracted, duplicate: plan.skippedDuplicate },
          gaps: { truncatedWindows: input.truncatedWindows ?? 0, uncoveredPages: input.uncoveredPages ?? 0, fullRead: input.fullRead ?? null },
        },
        completedAt: now,
      },
    });
  }, { timeout: 30_000, maxWait: 10_000 });

  // TIER-B RECORDS-LANDED TRIGGER (2026-07-14): fire the SAME off-request recompute the viability-card
  // open fires (fireRecomputeViability → placeholder-lambda self-invoke: narrowAndPersistClaim →
  // deriveAiViability → precomputeSoapNoteForCase), so claim reconciliation + SOAP grounding happen the
  // moment the extraction commits — not only when someone next opens the card. This runs in the API
  // process (internal-worker merge callback), so the AWS_LAMBDA_FUNCTION_NAME self-invoke targets the
  // right function, same as the card path.
  // LOOP-SAFE by construction: nothing in the recompute job enqueues chart extraction
  // (placeholder-lambda.ts runs narrow/plan/SOAP only — no maybeEnqueueChartExtract anywhere in that
  // path), so an extract completion can never re-trigger an extract. Duplicate-compute-safe:
  // deriveAiViability's own in-flight guard (a fresh 'computing' stamp for the same input hash)
  // short-circuits, so this single dispatch per merge can't storm a compute already running.
  // AWAITED dispatch (the InvokeCommand is itself InvocationType:'Event' — it returns as soon as the
  // async invoke is accepted, ~ms) so a Lambda response can't freeze a floating promise; log-only
  // catch — a dispatch failure must never fail the merge that already committed (fireRecomputeViability
  // is additionally fail-open internally).
  try {
    const dispatched = await fireRecomputeViability(input.caseId);
    console.log(JSON.stringify({ event: 'chart_merge_recompute_dispatched', caseId: input.caseId, runId: input.runId, dispatched }));
  } catch (err) {
    console.warn(JSON.stringify({ event: 'chart_merge_recompute_dispatch_failed', caseId: input.caseId, runId: input.runId, error: err instanceof Error ? err.message : String(err) }));
  }

  return {
    autofill,
    written: autofill ? plan.toInsert.length + plan.toPromote.length : 0,
    promoted: autofill ? plan.toPromote.length : 0,
    skippedManual: plan.skippedManual,
    skippedPriorExtracted: plan.skippedPriorExtracted,
    skippedDuplicate: plan.skippedDuplicate,
  };
}
