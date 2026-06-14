/**
 * Draft readiness — the "no silent deaths" pre-draft gate (Ryan, 2026-06-03).
 *
 * A chart-incomplete halt must NEVER be a silent death or a cryptic code. This check runs the
 * essential-docs rule SYNCHRONOUSLY in the EMR — both in the pre-draft popup and server-side on
 * POST /draft — so a missing essential is caught BEFORE any draft spend, reported as a plain,
 * fixed, RN-actionable sentence, and impossible to lose in an async job result.
 *
 * Design decisions (Ryan):
 *   - AUTO-DETECT all four essentials from the chart/records (deterministic where possible).
 *   - BLOCK on missing, but the RN can OVERRIDE with a logged reason (the override is the safety
 *     valve for any fuzzy auto-detect false-positive — honors RN self-service).
 *   - Messages are FIXED strings, never AI-generated, in Ryan's exact format:
 *     "Essential documents missing: Please upload ___ and redraft." Simple, never wrong.
 *
 * Source of truth = the VA document (memory feedback_va_document_is_source_of_truth). This is the
 * EMR-side mirror of the FRN drafter's chartCompleteness gate, run early so the RN never hits the
 * gate blind. The drafter gate stays as a backstop.
 */

import { normalizeName } from './chart-extractor.js';
import { deriveChartBuildState, type ChartBuildState } from './chart-build-state.js';
import { deriveCaseFramingForCase } from './case-framing-stamp.js';
import type { CaseFraming } from './case-framing.js';
import type { AppDb } from './db-types.js';

export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';

export interface DraftReadinessInput {
  claimType: ClaimType;
  /** The drafter framing: 'secondary' means the claim needs an established SC primary to attach to. */
  framingChoice: string | null;
  /**
   * SSOT caseFraming (v1) — when present and recognized, the framing/anchor reads below use it
   * instead of the legacy exact-string framingChoice check and the raw grantedScCount (build plan
   * §2.5: consumers read the SSOT object, never re-run the framing regex / status re-filter).
   * Absent or unknown version → byte-identical legacy behavior (the baseline test locks it).
   */
  caseFraming?: CaseFraming | null;
  claimedCondition: string;
  claimedConditions: string[];
  inServiceEvent: string | null;
  /** Count of ScCondition rows with status='service_connected' (granted). */
  grantedScCount: number;
  /** RN-affirmed "this veteran has NO service-connected conditions" — disambiguates empty-chart
   *  (not entered yet) from confirmed-none. */
  noScConditionsConfirmed: boolean;
  /** ActiveProblem names for the veteran. */
  problemNames: string[];
  /** Uploaded documents (filename + classification tag). */
  documents: { filename: string; docTag: string | null }[];
}

export type ReadinessKey = 'sc_conditions' | 'denial_letter' | 'current_diagnosis' | 'in_service_event';

export interface ReadinessItem {
  key: ReadinessKey;
  label: string;
  present: boolean;
  /** Plain, fixed RN-facing alert when missing. Undefined when present. */
  message?: string;
  /** What the auto-detect keyed on, for transparency (not shown as the alert). */
  basis: string;
}

export interface DraftReadinessResult {
  ready: boolean;
  items: ReadinessItem[];
  missing: ReadinessItem[];
  /** One-line headline for the popup when something is missing. */
  summary: string;
  /** Where the chart-build pipeline is. Only 'chart_ready' evaluates real missing-docs; the other
   *  states mean "still building" (or a surfaced failure), never a false "documents missing". */
  buildState: ChartBuildState;
  /**
   * The SSOT framing object the evaluation used (when derivable) — the Gate-1 pre-fill feed
   * (work order Task 3: sc_conditions ← grantedScAnchors) and the provenance display
   * (Task 5: source = rn_set / derived / text_parse_fallback / default_direct).
   */
  caseFraming?: CaseFraming;
}

const APPEAL_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(['supplemental', 'hlr', 'appeal_bva']);

// Filename/docTag heuristics. docTag classification isn't populating yet (all 'Other'), so the
// filename is the workhorse; docTag is checked too for when classification lands.
const DENIAL_DOC = /(denial|denied|decision|s00?c|statement of the case)/i;
const _RATING_DOC = /(rating\s*decision|code\s*sheet|rating\s*sheet)/i; // parked until docTag classification lands
const SERVICE_DOC = /(dd[\s-]?214|service\s*treatment|^str\b|separation|enlist|entrance\s*exam|service\s*record)/i;

function hasDoc(documents: { filename: string; docTag: string | null }[], re: RegExp): boolean {
  return documents.some((d) => re.test(d.filename) || (d.docTag != null && re.test(d.docTag)));
}

/** Does any problem name match the claimed condition (synonym-folded)? = a current dx on file. */
function conditionInProblems(claimed: string[], problemNames: string[]): boolean {
  const wanted = new Set(claimed.map(normalizeName));
  return problemNames.some((p) => wanted.has(normalizeName(p)));
}

/**
 * Pure: evaluate the four essential-docs rules. Deterministic — same input, same result.
 * Every missing item carries a fixed plain-language alert in Ryan's format.
 */
export function evaluateDraftReadiness(input: DraftReadinessInput): DraftReadinessResult {
  const items: ReadinessItem[] = [];
  const claimedAll = [input.claimedCondition, ...input.claimedConditions].filter(Boolean);

  // SSOT consumption (version-gated, fail-open): a recognized v1 caseFraming supplies the framing
  // theory + the granted-anchor list; 'undetermined' is treated like absence for THEORY decisions
  // (schema rule) but its anchor list is still readable. Absent/unknown version → legacy reads.
  const cf = input.caseFraming?.version === 1 ? input.caseFraming : undefined;
  const ssotTheory = cf !== undefined && cf.framing !== 'undetermined' ? cf.framing : null;
  const grantedCount = cf !== undefined ? cf.grantedScAnchors.length : input.grantedScCount;

  // 1. Service-connected PRIMARY — required ONLY for a SECONDARY-type claim (it needs an established
  //    service-connected condition to attach to). A direct/initial claim does NOT need a prior SC,
  //    so we don't add the item at all for those (no false block). Three-way for secondary:
  //    grants on file → present; confirmed-none → not viable as secondary; neither → upload it.
  //    With the SSOT present, 'aggravation' (3.310(b)-pathway label) also requires the anchor —
  //    a deliberate widening vs the legacy exact-'secondary' check (work order Task 2; the
  //    dormant DRAFT_READINESS_GATE 409 stays off, and the RN can override the item regardless).
  const isSecondary = ssotTheory !== null
    ? ssotTheory === 'secondary' || ssotTheory === 'aggravation'
    : input.framingChoice === 'secondary';
  if (isSecondary) {
    if (grantedCount >= 1) {
      items.push({ key: 'sc_conditions', label: 'Service-connected primary', present: true, basis: `${grantedCount} granted SC condition(s) on file` });
    } else if (input.noScConditionsConfirmed) {
      items.push({
        key: 'sc_conditions', label: 'Service-connected primary', present: false,
        basis: 'RN confirmed: veteran has no service-connected conditions',
        message: 'This is a secondary claim, but the veteran has no service-connected condition to connect it to. A secondary claim needs an established service-connected primary, add it, or refile this as a direct claim.',
      });
    } else {
      items.push({
        key: 'sc_conditions', label: 'Service-connected primary', present: false,
        basis: 'no granted SC condition on file',
        message: 'Essential documents missing: Please upload the VA rating decision (the letter that lists each service-connected condition) and redraft.',
      });
    }
  }

  // 2. Denial letter — only required when the claim is an appeal (supplemental / HLR / BVA).
  if (APPEAL_TYPES.has(input.claimType)) {
    const present = hasDoc(input.documents, DENIAL_DOC);
    items.push({
      key: 'denial_letter',
      label: 'VA denial letter (appeal)',
      present,
      basis: present ? 'denial/decision document on file' : 'no denial/decision document found',
      ...(present ? {} : {
        message: 'Essential documents missing: This is an appeal. Please upload the VA denial letter being appealed and redraft.',
      }),
    });
  }

  // 3. Current diagnosis — the claimed condition appears in the problem list (the dx source).
  {
    const present = conditionInProblems(claimedAll, input.problemNames);
    items.push({
      key: 'current_diagnosis',
      label: 'Current diagnosis',
      present,
      basis: present ? `"${input.claimedCondition}" found in problem list` : `"${input.claimedCondition}" not in problem list`,
      ...(present ? {} : {
        message: `Essential documents missing: A current diagnosis for ${input.claimedCondition} is not on file. Please upload a medical record showing the current diagnosis and redraft.`,
      }),
    });
  }

  // 4. In-service event — a recorded event OR a service record (DD-214 / STR) on file. Under the
  //    SSOT, a secondary/aggravation claim anchored on a GRANTED SC primary is satisfied by the
  //    anchor itself: per 38 CFR 3.310 the claim attaches to the service-connected primary, not to
  //    a fresh in-service event (mirrors the drafter Gate-2 anchor rule that fixed the Hatfield
  //    false-halt — work order Task 3).
  {
    const hasEventText = (input.inServiceEvent ?? '').trim().length > 0;
    const hasServiceDoc = hasDoc(input.documents, SERVICE_DOC);
    const anchor = isSecondary && ssotTheory !== null && cf !== undefined ? cf.grantedScAnchors[0] : undefined;
    const anchorSatisfies = anchor !== undefined;
    const present = hasEventText || hasServiceDoc || anchorSatisfies;
    items.push({
      key: 'in_service_event',
      label: 'In-service event / service record',
      present,
      basis: hasEventText ? 'in-service event recorded on case'
        : hasServiceDoc ? 'DD-214 / service record on file'
        : anchorSatisfies ? `satisfied by granted SC anchor ${anchor.condition}${anchor.ratingPct !== null ? ` (${anchor.ratingPct}%)` : ''}`
        : 'no in-service event or service record',
      ...(present ? {} : {
        message: 'Essential documents missing: The in-service event is not documented. Please upload the DD-214 or service treatment record showing the in-service event and redraft.',
      }),
    });
  }

  const missing = items.filter((i) => !i.present);
  const ready = missing.length === 0;
  const summary = ready
    ? 'All essential documents are on file.'
    : `Essential documents missing: ${missing.map((m) => m.label).join(', ')}. Please upload and redraft.`;

  // evaluateDraftReadiness is the chart_ready evaluator; getDraftReadiness only calls it once the
  // build state is chart_ready.
  return { ready, items, missing, summary, buildState: 'chart_ready', ...(cf !== undefined ? { caseFraming: cf } : {}) };
}

/** Plain RN-facing result for a case whose chart isn't finished building yet (or failed). The door
 *  shows these instead of a false "documents missing". */
function buildingResult(state: ChartBuildState): DraftReadinessResult {
  const summaryByState: Record<ChartBuildState, string> = {
    no_documents: 'No records have been uploaded yet. Upload the veteran\'s records to begin.',
    ocr_in_progress: 'The records are still being read. This usually takes a few minutes, check back shortly.',
    extracting: 'The chart is still being built from the records. This usually takes a few minutes, check back shortly.',
    extract_failed: 'We could not finish building the chart from the records automatically. Please retry the records, or enter the conditions manually.',
    chart_ready: 'All essential documents are on file.',
  };
  return { ready: false, items: [], missing: [], summary: summaryByState[state], buildState: state };
}

interface CaseForReadiness {
  veteranId: string;
  claimType: ClaimType;
  framingChoice: string | null;
  claimedCondition: string;
  claimedConditions: string[];
  inServiceEvent: string | null;
}

/**
 * Gather the readiness inputs for a case from the DB, then evaluate. Returns null if the case does
 * not exist (the caller maps that to 404). Mirrors drafter-bundle's untyped-delegate cast for the
 * delegates not on the typed AppDb surface (document, scCondition).
 */
export async function getDraftReadiness(db: AppDb, caseId: string): Promise<DraftReadinessResult | null> {
  const c = (await db.case.findFirst({ where: { id: caseId } })) as CaseForReadiness | null;
  if (c === null) return null;

  const scDelegate = (db as unknown as {
    scCondition: { findMany: (args: { where: { veteranId: string; status: string } }) => Promise<unknown[]> };
  }).scCondition;
  const docDelegate = (db as unknown as {
    document: { findMany: (args: { where: { caseId: string }; select: { id: true; s3Key: true; filename: true; docTag: true } }) => Promise<{ id: string; s3Key: string; filename: string; docTag: string | null }[]> };
  }).document;
  const vetDelegate = (db as unknown as {
    veteran: { findFirst: (args: { where: { id: string }; select: { noScConditionsConfirmed: true } }) => Promise<{ noScConditionsConfirmed: boolean } | null> };
  }).veteran;
  const runDelegate = (db as unknown as {
    chartExtractionRun: { findFirst: (args: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; select: { triggerHash: true; status: true } }) => Promise<{ triggerHash: string; status: string } | null> };
  }).chartExtractionRun;

  const [grantedSc, problems, documents, vet, readStatuses, latestRun] = await Promise.all([
    scDelegate.findMany({ where: { veteranId: c.veteranId, status: 'service_connected' } }),
    db.activeProblem.findMany({ where: { veteranId: c.veteranId } }),
    docDelegate.findMany({ where: { caseId }, select: { id: true, s3Key: true, filename: true, docTag: true } }),
    vetDelegate.findFirst({ where: { id: c.veteranId }, select: { noScConditionsConfirmed: true } }),
    db.fileReadStatus.findMany({ where: { caseId } }) as unknown as Promise<{ filePath: string; terminalStatus: string }[]>,
    runDelegate.findFirst({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { triggerHash: true, status: true } }),
  ]);

  // The door: only evaluate real missing-docs once the chart is actually built. Before that, say
  // "still building" — never a false "documents missing" while OCR/extraction are still running.
  // deriveChartBuildState now takes the case's recent runs (sticky-completion fix, Ewell
  // CLM-A867B8C128, 2026-06-14); this caller queries a single latest run → wrap to preserve behavior.
  const { state } = deriveChartBuildState(documents, readStatuses, latestRun ? [latestRun] : []);
  if (state !== 'chart_ready') return buildingResult(state);

  // Live-derive the SSOT framing through the ONE shared derivation (architect QA: consumers call
  // the producer function, never a second regex). Null (raced delete) → legacy path, fail-open.
  const caseFraming = await deriveCaseFramingForCase(db, caseId);

  return evaluateDraftReadiness({
    claimType: c.claimType,
    framingChoice: c.framingChoice,
    caseFraming,
    claimedCondition: c.claimedCondition,
    claimedConditions: c.claimedConditions ?? [],
    inServiceEvent: c.inServiceEvent,
    grantedScCount: grantedSc.length,
    noScConditionsConfirmed: vet?.noScConditionsConfirmed ?? false,
    problemNames: problems.map((p) => (p as { problem: string }).problem),
    documents,
  });
}
