// Server-side SOAP-context assembler (Ryan 2026-06-22, Zimmelman reliability fix).
//
// THE PROBLEM IT SOLVES: the SOAP note is now generated in the OFF-REQUEST async recompute job (110s budget)
// so it is reliable on a 2776-page chart, then SERVED from the persisted cache on the synchronous open ($0).
// For that to work the fingerprint the async job persists under MUST equal the fingerprint the sync read
// computes — otherwise the precomputed note is never found (permanent cache miss → every open re-bills /
// times out, exactly the bug). The fingerprint folds in the EXACT rendered context (renderContext). If the
// async job and the sync read assembled that context from DIFFERENT sources (the FE used to POST keyFacts /
// coverageNote / engineVerdict computed client-side), the two fingerprints would diverge.
//
// THE FIX: ONE deterministic server-side assembler builds the cacheable SoapContext from the DB. Both the
// async precompute and the sync read call it, so the fingerprints are identical BY CONSTRUCTION. The FE no
// longer owns the cacheable grounding inputs — the server does (the correct one-brain move: the note's
// grounding is the server's authoritative chart read, not whatever the FE happened to POST). The route still
// accepts the FE body for back-compat, but for a route-picker-grounded note it uses THIS assembler's output.
//
// Fail-open everywhere: any sub-derivation that throws degrades to a null/empty field, never blocks the note.

import type { AppDb } from './db-types.js';
import { type SoapContext, type SoapOverviewCacheDb, getOrBuildSoapNote } from './soap-overview.js';
import { type AiViabilityCard, getAiViabilityState } from './ai-viability.js';
import { buildDigestForCase } from '../advisory/chartSlice.js';
import { loadExtractionCoverageForCase } from './extraction-coverage.js';
import { loadReconciledChartReadiness } from './chart-readiness.js';

/** The pieces of the route-picker plan the SOAP note grounds on (mirrors SoapContext['routePickerFraming']). */
export type RoutePickerFramingInput = NonNullable<SoapContext['routePickerFraming']>;

interface CaseRowForSoap {
  claimedCondition: string;
  veteranStatement: string | null;
  veteran: {
    weightLb: number | null;
    scConditions: Array<{ condition: string; status: string }>;
    activeProblems: Array<{ problem: string }>;
    activeMedications: Array<{ drugName: string; indication: string | null }>;
  } | null;
}

/** Server-side coverage note, derived identically to the FE string so the fingerprint is stable. Fail-open.
 *
 * FIX C (Ryan 2026-06-22, Zimmelman): this used to call computeExtractionCoverage with an EMPTY
 * file-read-status array (and null run), so EVERY doc counted as "no readiness row → in progress" →
 * extractedPages 0 → coveragePct 0 → the Objective said "0% of pages read" while the chart chip read 100%.
 * It now goes through the SAME loadExtractionCoverageForCase the GET /extraction-coverage route uses
 * (real file_read_status rows judged via isEffectivelyRead + the latest run), so the SOAP Objective % and
 * the chart chip % are computed from one source and always agree. Empty chart (no docs) → totalFiles 0,
 * which we treat as "nothing to report" (null) — exactly as the prior docs.length===0 guard did. */
async function deriveCoverageNote(db: AppDb, caseId: string): Promise<string | null> {
  try {
    const cov = await loadExtractionCoverageForCase(db, caseId);
    if (cov.totalFiles === 0) return null; // no chart inputs yet → nothing to report (was docs.length===0)
    // EXTRACTION DID-NOT-FINISH (card-honesty 2026-06-23): if the chart analysis failed or is still
    // queued/running, the structured chart is incomplete/empty — say so plainly so the SOAP Objective
    // (and the verdict the RN reads off it) is flagged "based on an incomplete chart" instead of being
    // presented as a confident "not supportable" built on an empty chart. Single source: the same
    // coverage layer the card uses, so card + verdict can never disagree.
    // Key on the chartAnalysis STAGE (the SSOT the card reads), not the raw status/gap, so the SOAP note and the
    // chart card can never give contradictory tense (QA 2026-06-24). An IN-FLIGHT (queued/running) analysis is
    // "still running" — NOT "did not finish — re-run" (that cried wolf on every first load). Only a genuinely
    // failed/interrupted-incomplete analysis says re-run.
    const analysisState = cov.chartAnalysis?.state;
    if (analysisState === 'in_progress' || cov.status === 'in_progress') {
      return 'The chart analysis is still running — this read may be based on a partial chart; re-check once it finishes.';
    }
    if (cov.status === 'failed' || analysisState === 'failed' || analysisState === 'incomplete' || cov.gaps.some((g) => g.reason === 'extraction_incomplete')) {
      return 'Chart analysis did not finish — this read is based on an incomplete chart and may be missing records; re-run the extraction before relying on the verdict.';
    }
    const pct = typeof cov.coveragePct === 'number' ? cov.coveragePct : null;
    if (pct === null) return null;
    let hasUnread = false;
    try {
      const r = await loadReconciledChartReadiness(db, caseId);
      hasUnread = r ? !(r.ready === true && (r.blockingFiles?.length ?? 0) === 0) : false;
    } catch { hasUnread = false; }
    return (!hasUnread && pct >= 99) ? 'All records were reviewed.' : `${pct}% of pages read${hasUnread ? '; some pages still unread' : ''}.`;
  } catch { return null; }
}

/**
 * Build the authoritative, DETERMINISTIC SoapContext for a case from the DB. Used by BOTH the async
 * precompute (placeholder-lambda) and the sync read (POST /soap-overview) so they produce the SAME
 * soapNoteFingerprint. `routePickerFraming` is passed in by the caller (it already has the plan in hand from
 * the same row read — avoids a re-read race) and is folded in authoritatively. Fail-open: a DB hiccup yields
 * a minimal context (claimed condition only) — the note still builds and the card never blanks.
 */
export async function assembleSoapContextForCase(
  db: AppDb,
  caseId: string,
  routePickerFraming: RoutePickerFramingInput | null,
): Promise<SoapContext> {
  let row: CaseRowForSoap | null = null;
  try {
    row = (await db.case.findFirst({
      where: { id: caseId },
      select: {
        claimedCondition: true,
        veteranStatement: true,
        veteran: {
          select: {
            weightLb: true,
            scConditions: { select: { condition: true, status: true } },
            activeProblems: { select: { problem: true } },
            activeMedications: { where: { medStatus: 'active' }, select: { drugName: true, indication: true } },
          },
        },
      } as never,
    })) as unknown as CaseRowForSoap | null;
  } catch { row = null; }

  const claimedCondition = row?.claimedCondition ?? '';
  // Only GRANTED conditions are valid anchors to surface (mirrors strategy-preview's filter), deduped.
  const scConditions = [...new Set((row?.veteran?.scConditions ?? [])
    .filter((s) => s.status === 'service_connected')
    .map((s) => (s.condition ?? '').trim())
    .filter(Boolean))];
  const activeProblems = [...new Set((row?.veteran?.activeProblems ?? [])
    .map((p) => (p.problem ?? '').trim()).filter(Boolean))];
  const medications = (row?.veteran?.activeMedications ?? [])
    .map((m) => ({ drugName: m.drugName, indication: m.indication }))
    .filter((m) => m.drugName);
  const keyFacts = row?.veteran?.weightLb != null ? [{ label: 'Weight', value: `${row.veteran.weightLb} lb` }] : [];

  const [chartDigest, coverageNote] = await Promise.all([
    buildDigestForCase(db, caseId).catch(() => null),
    deriveCoverageNote(db, caseId),
  ]);

  return {
    claimedCondition,
    veteranStatement: row?.veteranStatement ?? null,
    // theory/mechanism are intentionally omitted: when a plan grounds the note renderContext drops them, and
    // for the cacheable server path the plan is the framing source. (Left undefined → not in the fingerprint.)
    scConditions,
    activeProblems,
    keyFacts,
    medications,
    coverageNote,
    chartDigest,
    routePickerFraming,
  };
}

/** Project a route-picker plan card into the SoapContext framing block (mirrors the sync route's mapping).
 *  Only grounds when the plan's claim matches the live claimed condition (the staleness/wrong-condition guard). */
export function routePickerFramingFromCard(card: AiViabilityCard | null, liveClaimed: string): RoutePickerFramingInput | null {
  if (!card || !card.lead || card.inputClaimed !== liveClaimed) return null;
  return {
    framing: card.lead.framing,
    cfr_basis: card.lead.cfr_basis,
    mechanism: card.lead.mechanism,
    rationale: card.lead.rationale,
    counterargument: card.lead.counterargument,
    confidence: card.lead.confidence,
    viability: card.viability,
    planHash: card.planHash ?? '',
  };
}

/**
 * OFF-REQUEST SOAP precompute (Ryan 2026-06-22, Zimmelman). Called by the async __recomputeViability Lambda
 * AFTER the route-picker plan has persisted, so ONE async job produces BOTH the plan and the note — reliable
 * (110s budget, not the 25s sync cap) AND consistent (the note grounds on the SAME plan the verdict uses).
 *
 * It reads the freshly-persisted plan (compute:false → $0, no second LLM), grounds the SoapContext on it via
 * the shared assembler (so the fingerprint matches the sync read), and forceRegenerates+persists the note.
 * `timeoutMs` should be the remaining Lambda budget (the picker already ran). Fail-open: returns false on any
 * issue (the sync open then falls back to its own bounded generate — degraded but never blank).
 */
export async function precomputeSoapNoteForCase(db: AppDb, caseId: string, timeoutMs: number): Promise<boolean> {
  try {
    const state = await getAiViabilityState(db, caseId, { compute: false });
    const card = state.status === 'ready' ? state.card : null;
    // Build the framing from the just-persisted plan (when the claim still matches). A note can ALSO be
    // precomputed WITHOUT a plan (framing=null → ungrounded). FIX A (Ryan 2026-06-22, Zimmelman): the old
    // code bailed (`if (!framing) return false`) on a cold/abstaining case, so NO note was ever persisted
    // under the assembler fingerprint — the sync read (which now ALSO assembles via this same assembler)
    // then found no stored note and fell back forever. We now assemble + persist the ungrounded note too,
    // so a cold case still has a served, assembler-fingerprinted note on the next sync open. Grounded
    // (framing present) remains the high-value path; both go through the SAME assembler so write==read.
    const framing = routePickerFramingFromCard(card, card?.inputClaimed ?? '');
    const ctx = await assembleSoapContextForCase(db, caseId, framing);
    if (!ctx.claimedCondition) return false; // nothing to write about (no claimed condition) → genuinely skip
    const built = await getOrBuildSoapNote(db as unknown as SoapOverviewCacheDb, caseId, ctx, { forceRegenerate: true, timeoutMs });
    // Observability (Bays SOAP banner, 2026-06-26): log the PERSISTED outcome, not just "didn't throw".
    // fallback:true = a truncated/error brief was served and NOT persisted (the heal did NOT happen this
    // run — a perpetual-fallback case is otherwise invisible); fallback:false = a real grounded note was
    // persisted ($0 on the next open). `grounded` = the plan matched (framing non-null).
    const fb = (built as { data?: { fallback?: boolean } } | null | undefined)?.data?.fallback;
    console.warn(JSON.stringify({ msg: 'soap precompute outcome', caseId, grounded: framing !== null, fallback: fb === true, persisted: fb === false }));
    return true;
  } catch {
    return false;
  }
}
