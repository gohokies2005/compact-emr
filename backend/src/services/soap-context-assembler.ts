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
import { computeExtractionCoverage } from './extraction-coverage.js';
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

/** Server-side coverage note, derived identically to the FE string so the fingerprint is stable. Fail-open. */
async function deriveCoverageNote(db: AppDb, caseId: string): Promise<string | null> {
  try {
    const docs = (await db.document.findMany({
      where: { caseId },
      select: { id: true, s3Key: true, contentType: true, pageCount: true },
    } as never)) as unknown as Array<{ id: string; s3Key: string; contentType: string; pageCount: number | null }>;
    if (!docs || docs.length === 0) return null;
    const pages = (await db.documentPage.findMany({
      where: { document: { caseId } },
      select: { documentId: true, pageNumber: true, extractionCoverage: true, handwritingPresent: true },
    } as never).catch(() => [])) as unknown as Array<{ documentId: string; pageNumber: number; extractionCoverage: string | null; handwritingPresent: boolean | null }>;
    const cov = computeExtractionCoverage(
      docs.map((d) => ({ id: d.id, s3Key: d.s3Key, contentType: d.contentType, pageCount: d.pageCount })),
      [],
      null,
      (pages ?? []).map((p) => ({ documentId: p.documentId, pageNumber: p.pageNumber, extractionCoverage: p.extractionCoverage ?? null, handwritingPresent: p.handwritingPresent ?? null })),
    );
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
    // Build the framing from the just-persisted plan (when the claim still matches). A note can still be
    // precomputed WITHOUT a plan (ungrounded) — but the high-value case is the grounded note; if there is no
    // ready plan we skip (the plan compute likely failed/abstained; the sync path handles the ungrounded note).
    const framing = routePickerFramingFromCard(card, card?.inputClaimed ?? '');
    if (!framing) return false;
    const ctx = await assembleSoapContextForCase(db, caseId, framing);
    if (!ctx.claimedCondition) return false;
    await getOrBuildSoapNote(db as unknown as SoapOverviewCacheDb, caseId, ctx, { forceRegenerate: true, timeoutMs });
    return true;
  } catch {
    return false;
  }
}
