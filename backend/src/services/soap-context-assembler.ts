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
import { type SoapContext, type SoapOverviewCacheDb, getOrBuildSoapNote, reconcileStickyAction, withReconciledCaseVerdict, buildAwaitRecordsNote } from './soap-overview.js';
import { deriveDualMechanismVerdict, type DualMechanismVerdict, type MechanismVerdict } from './mechanism-viability.js';
import { deriveDirectScVerdict, directScVerdictEnabled } from './direct-viability.js';
import { type AiViabilityCard, getAiViabilityState } from './ai-viability.js';
import { buildDigestForCase } from '../advisory/chartSlice.js';
import { loadExtractionCoverageForCase } from './extraction-coverage.js';
import { loadReconciledChartReadiness } from './chart-readiness.js';

/** The pieces of the route-picker plan the SOAP note grounds on (mirrors SoapContext['routePickerFraming']). */
export type RoutePickerFramingInput = NonNullable<SoapContext['routePickerFraming']>;

interface CaseRowForSoap {
  claimedCondition: string;
  veteranStatement: string | null;
  // Claim-type context (Ryan 2026-07-04) — drives the records-ledger pertinent-negatives (an appeal expects a
  // prior denial letter) and the scope read. All already on Case; no migration.
  claimType: string | null;
  previouslyDenied: boolean | null;
  priorDenialReason: string | null;
  veteran: {
    weightLb: number | null;
    scConditions: Array<{ condition: string; status: string }>;
    activeProblems: Array<{ problem: string }>;
    activeMedications: Array<{ drugName: string; indication: string | null }>;
  } | null;
}

/** Normalize a condition name for the already-SC compare: lowercase, drop parentheticals (rating/laterality),
 *  strip punctuation, collapse whitespace. */
function normCond(s: string): string {
  return s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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
    // HONESTY (Ryan 2026-07-04): this note describes PAGES READ, not records SUFFICIENCY — say exactly that.
    // "All records were reviewed." falsely implied the needed records are on file even on an intake-only
    // chart (2 intake pages OCR'd = 100%). The records-provenance ledger (what record TYPES are actually
    // present vs missing) is produced by the SOAP model itself, not asserted here.
    return (!hasUnread && pct >= 99) ? 'All uploaded pages were read.' : `${pct}% of pages read${hasUnread ? '; some pages still unread' : ''}.`;
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
  let row: CaseRowForSoap | null;
  try {
    row = (await db.case.findFirst({
      where: { id: caseId },
      select: {
        claimedCondition: true,
        veteranStatement: true,
        claimType: true,
        previouslyDenied: true,
        priorDenialReason: true,
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
  // .sort() on the deduped lists: these feed renderContext (→ the SOAP fingerprint), and a Prisma nested
  // relation read has no guaranteed row order, so an unsorted list could render differently between the async
  // precompute and the sync read → fingerprint drift → permanent cache miss. Sorting makes them order-stable.
  const scConditions = [...new Set((row?.veteran?.scConditions ?? [])
    .filter((s) => s.status === 'service_connected')
    .map((s) => (s.condition ?? '').trim())
    .filter(Boolean))].sort();
  const activeProblems = [...new Set((row?.veteran?.activeProblems ?? [])
    .map((p) => (p.problem ?? '').trim()).filter(Boolean))].sort();
  const medications = (row?.veteran?.activeMedications ?? [])
    .map((m) => ({ drugName: m.drugName, indication: m.indication }))
    .filter((m) => m.drugName);
  const keyFacts = row?.veteran?.weightLb != null ? [{ label: 'Weight', value: `${row.veteran.weightLb} lb` }] : [];

  // ALREADY-SERVICE-CONNECTED pre-flight signal (Ryan 2026-07-04, Margo class): if the claimed condition is
  // already on the granted-SC list there is nothing to CONNECT — a nexus letter does not apply (this is usually
  // a rating-increase request, out of scope) and the drafter would grind out a wasted run. Deterministic HINT
  // only (normalized equality or clear containment); the model confirms against the SC list it is also given.
  // EQUALITY-ONLY (Ryan philosophy 2026-07-04): a deterministic substring/containment match false-positives on
  // generic hypernyms (claimed "arthritis" vs SC "rheumatoid arthritis" → wrong "already-SC") — the exact
  // deterministic-garbage class Ryan distrusts. So the HINT fires only on an unambiguous normalized-EQUAL match;
  // fuzzier already-SC cases (e.g. "OSA" vs "obstructive sleep apnea") are left to the model, which is given the
  // full granted-SC list and instructed to reject when the claim already appears on it in any wording.
  const nClaim = normCond(claimedCondition);
  const alreadyServiceConnected = nClaim.length >= 4 && scConditions.some((sc) => normCond(sc) === nClaim);

  const [chartDigest, coverageNote, uploadedDocs] = await Promise.all([
    // preserveSeverity: the SOAP note grounds its Objective on diagnostic severity numbers (AHI/RDI/…). The
    // ONLY caller that opts in — the digest severity pre-pass guarantees those verbatim readings survive the
    // cap even on a 1608-page bundle (Foster root-cause 2026-07-01). All other digest callers stay unchanged.
    buildDigestForCase(db, caseId, { preserveSeverity: true }).catch(() => null),
    deriveCoverageNote(db, caseId),
    // Uploaded-document inventory for the records-reviewed ledger (Ryan 2026-07-04). Titler labels are HINTS
    // (docType is a free-form Haiku string, not an enum); the model reads the digest CONTENT to confirm what
    // record types are actually present. Sorted for a stable fingerprint. Fail-open to [].
    (async () => {
      try {
        const docs = (await db.document.findMany({ where: { caseId }, orderBy: { id: 'asc' }, select: { id: true, autoTitle: true, docType: true, docTag: true } })) as unknown as Array<{ id: string; autoTitle: string | null; docType: string | null; docTag: string | null }>;
        return docs
          // Exclude the extraction OUTPUT file — a screening-summary is our own artifact, NOT a veteran-uploaded
          // record, so it must never appear in the records-reviewed ledger (screening-summary wedge guard).
          .filter((d) => d.docTag !== 'screening_summary')
          .map((d) => ({ id: d.id, title: (d.autoTitle ?? '').trim() || null, docType: (d.docType ?? '').trim() || null }))
          .filter((d) => d.title || d.docType)
          // TOTAL-ORDER sort (fingerprint determinism): the space separator reduces concat-collisions and the
          // row-id tiebreaker guarantees a STABLE total order even when two keys tie, so the doc-inventory
          // renders identically across the async-precompute vs the sync-read assembly → no fingerprint drift /
          // cache-miss / re-bill (the Zimmelman class this module exists to prevent).
          .sort((a, b) => `${a.title ?? ''} ${a.docType ?? ''}`.localeCompare(`${b.title ?? ''} ${b.docType ?? ''}`) || a.id.localeCompare(b.id))
          .map(({ title, docType }) => ({ title, docType }));
      } catch { return []; }
    })(),
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
    // Triage-brain inputs (Ryan 2026-07-04) — claim type + doc inventory + already-SC signal drive the
    // records-reviewed ledger, the pertinent-negatives, and the already-SC/out-of-scope pre-flight.
    claimType: row?.claimType ?? null,
    previouslyDenied: row?.previouslyDenied ?? null,
    priorDenialReason: row?.priorDenialReason ?? null,
    uploadedDocs,
    alreadyServiceConnected,
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
/**
 * Is the route-picker LEAD a DIRECT (3.303/3.304) theory rather than a SECONDARY (3.310) one? Load-bearing
 * for verdict ROUTING: the picker encodes a DIRECT claim's in-service BASIS in `lead.upstream` as an EVENT
 * token (e.g. "in_service_events_border_patrol_duty_El_Paso_…"), NOT an SC condition — so "upstream present"
 * alone would misroute a direct claim to the mechanism (secondary) checker. Signals, any of which = direct:
 * a 3.303/3.304 cfr_basis, a "direct" framing string, or an in-service-event/exposure-shaped upstream token.
 */
export function leadIsDirectTheory(lead: { upstream?: string; framing?: string; cfr_basis?: string } | null | undefined): boolean {
  if (!lead) return false;
  const u = (lead.upstream ?? '').toLowerCase();
  const f = (lead.framing ?? '').toLowerCase();
  const b = (lead.cfr_basis ?? '').toLowerCase();
  return /3\.30[34]/.test(b) || /\bdirect\b/.test(f) || /^in[_\s-]?service|in[_\s-]?service[_\s-]?event|\bexposure\b/.test(u);
}

/** Humanize a route-picker event token ("in_service_events_border_patrol_duty_El_Paso_Oct2022_Nov2023") into
 *  readable prose for the direct checker's in-service-event list. Strips the machine prefix + underscores. */
function humanizeEventToken(token: string): string {
  return (token ?? '')
    .replace(/^in[_\s-]?service[_\s-]?events?[_\s-]?/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || token;
}

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
    // STAGE-1 SHORT-CIRCUIT (Ryan 2026-07-23, Step 2): NO veteran-uploaded medical records yet → persist a canned
    // "await records" note with ZERO model spend (skips the mechanism/direct verdict calls AND buildSoapNote).
    // ctx.uploadedDocs already excludes our screening-summary artifact + empty docs, so this fires ONLY when there
    // is genuinely nothing to read — it never hides a real chart (which would wrongly turn away a live case). The
    // canned note self-heals to a real read the moment records arrive (the digest changes → fingerprint diverges).
    if ((ctx.uploadedDocs?.length ?? 0) === 0) {
      await getOrBuildSoapNote(db as unknown as SoapOverviewCacheDb, caseId, ctx, {
        forceRegenerate: true, timeoutMs, generate: () => Promise.resolve(buildAwaitRecordsNote()),
      });
      console.warn(JSON.stringify({ msg: 'soap precompute outcome', caseId, stage1AwaitRecords: true, persisted: true }));
      return true;
    }
    // STICKY VERDICT (Dr. Kasky 2026-06-28, chip-wobble keystone): this precompute force-REGENERATES the note,
    // which used to clobber the persisted `action` (hence the chip color) on every recompute — even when the
    // case had not actually changed. reconcileStickyAction compares the fresh note against the stored one and
    // only lets the chip-bearing action change when this run is GROUNDED on a route-picker plan (an authoritative
    // band decided it) — an UNGROUNDED recompute keeps the prior decision so the chip does not flicker. Prose is
    // still regenerated freely. `framing !== null` is exactly "is this run grounded".
    const grounded = framing !== null;
    // DUAL MECHANISM VERDICT (Ryan 2026-07-22, extends the 2026-07-21 single verdict) — an ADDITIVE,
    // recommendation-only read that assesses BOTH the veteran's OWN stated theory AND the route-picker LEAD
    // pairing, each with its own grounded verdict, so an RN never sees a "not supportable" for a pairing the
    // veteran never raised (Lynaugh: veteran claims burn-pit -> OSA but the LEAD is "Impaired Hearing -> OSA").
    // The LEAD pairing reads off the SAME persisted route-picker plan (card.lead.upstream / .claimed); the
    // veteran pairing is extracted, grounded, from ctx.veteranStatement (its literal words). Computed HERE (the
    // 110s async budget) — up to two grounded Opus calls only when the pairings DIFFER. DARK by default
    // (SOAP_MECHANISM_VERDICT_ENABLED). Fail-open: any failure degrades to the lead verdict alone (or a null
    // note); it NEVER blocks the drafter (which reads the route-picker band, not this note) and never blocks a
    // draft. When there is no distinct veteran theory the render is BYTE-IDENTICAL to the single-verdict path.
    // ROUTING (Ryan 2026-07-23): a DIRECT lead (3.303/3.304, or an in-service-event upstream token) goes to the
    // direct-SC checker below; only a genuine SECONDARY lead (an SC-condition upstream) runs the mechanism check.
    // This fixes the misroute where the picker's event-token upstream sent a direct PTSD claim to the mechanism
    // path (wrong "MECHANISM CHECK" label + a raw token as the "upstream").
    const leadDirect = !!(card && card.lead) && leadIsDirectTheory(card.lead);
    let dualVerdict: DualMechanismVerdict | null = null;
    try {
      if (card && card.lead && card.lead.upstream && !leadDirect) {
        dualVerdict = await deriveDualMechanismVerdict(
          card.lead.claimed || card.inputClaimed,
          card.lead.upstream,
          ctx.veteranStatement ?? null,
        );
      }
    } catch { dualVerdict = null; }
    // DIRECT-SC VERDICT (Ryan 2026-07-23) — the DIRECT-axis twin: when the lead theory has NO upstream SC
    // condition (a 3.303 direct claim, e.g. PTSD → in-service stressors), the mechanism check does not apply,
    // so run the LLM direct-viability checker instead. Gated (SOAP_DIRECT_SC_VERDICT_ENABLED) → DARK by default:
    // OFF skips the DB reads + model call entirely (byte-identical note). Facts reuse the SAME structured
    // builders the direct-SC axis uses (buildInServiceEvents/buildDxConstellation), lazy-imported so the vendor
    // graph stays off the static path. Fail-open: any failure → null → the note renders exactly as today.
    let directVerdict: MechanismVerdict | null = null;
    try {
      if (directScVerdictEnabled() && card && card.lead && (leadDirect || !card.lead.upstream)) {
        const claimed = (card.lead.claimed || card.inputClaimed || ctx.claimedCondition || '').trim();
        const { buildInServiceEvents, buildDxConstellation } = await import('./case-viability-stamp.js');
        const [structuredEvents, dxConstellation] = await Promise.all([
          buildInServiceEvents(db, caseId),
          buildDxConstellation(db, caseId),
        ]);
        const events = structuredEvents.map((e) => ({ event_canonical: e.event_canonical, evidence_span: e.evidence_span }));
        // The picker carries a DIRECT claim's in-service BASIS in lead.upstream (an event token). Feed it as an
        // element-2 basis so a document-heavy case (statement/stressors in PDFs, not the structured columns —
        // e.g. Haines) has a real basis to judge and does NOT abstain. Humanize the token + carry the rationale.
        if (leadDirect && card.lead.upstream) {
          events.push({
            event_canonical: humanizeEventToken(card.lead.upstream),
            evidence_span: (card.lead.rationale || card.lead.mechanism || 'route-picker direct in-service basis').slice(0, 400),
          });
        }
        const cl = claimed.toLowerCase();
        // Coarse element-1 hint ONLY (the model uses the full dxConstellation list as authority). Guard BOTH
        // sides on length so a short token can't substring-false-positive; yields true or null, never false.
        const currentDxPresent = cl.length > 2 && dxConstellation.some((d) => { const dl = d.toLowerCase(); return dl.length > 2 && (dl.includes(cl) || cl.includes(dl)); }) ? true : null;
        directVerdict = await deriveDirectScVerdict(claimed, {
          currentDxPresent,
          dxConstellation,
          inServiceEvents: events,
          continuityEvidence: null,
          upstreamScIfAny: null,
          veteranStatement: ctx.veteranStatement ?? null,
          // The chart digest is the authoritative record for element 1 (dx) + element 2 (stressors) when they
          // live in uploaded documents rather than the structured columns (Haines). Bounded in the builder.
          recordContext: typeof ctx.chartDigest === 'string' ? ctx.chartDigest : null,
        });
      }
    } catch { directVerdict = null; }
    const built = await getOrBuildSoapNote(db as unknown as SoapOverviewCacheDb, caseId, ctx, {
      forceRegenerate: true,
      timeoutMs,
      // The verdict is folded AFTER sticky-action reconciliation, so it touches only the Assessment + Plan
      // prose and never the chip-bearing action reconcileStickyAction owns. withDualMechanismVerdict renders
      // both pairings when the veteran theory differs from the lead, and delegates to the single-verdict
      // Assessment+Plan folds (byte-identical to today) when it does not. Recommendation-only prose prefixes;
      // a good draft's decision fields are untouched.
      reconcile: (fresh, stored) => {
        // STEP 1 (Ryan 2026-07-23): ONE reconciled verdict. withReconciledCaseVerdict folds the mechanism +
        // direct verdict prose AND reconciles the note's `action` against the route-picker band (framing.viability)
        // so the three verdict voices can no longer contradict (band vs the model's free action vs the caution
        // prose). The band caps the action (an amber band can't render a "draft"), a hard not_viable skeptic
        // vetoes a draft, and ⚠ caution prose is dropped on a DRAFT. Ungrounded run (framing null) → today's
        // behavior. reconcileStickyAction still runs first so the sticky (chip-wobble) action feeds the reconcile.
        const band = framing ? framing.viability : null;
        return withReconciledCaseVerdict(reconcileStickyAction(fresh, stored, grounded), band, dualVerdict, directVerdict);
      },
    });
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
