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

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeName } from './chart-extractor.js';
import { deriveChartBuildState, type ChartBuildState } from './chart-build-state.js';
import { deriveCaseFramingForCase } from './case-framing-stamp.js';
import { deriveAiViability } from './ai-viability.js';
import { buildDigestForCase } from '../advisory/chartSlice.js';
import type { CaseFraming } from './case-framing.js';
import type { AppDb } from './db-types.js';

// ── SAME-BRAIN canonicalizer (2026-06-21): the dx check must synonym-match the claimed condition against
// what's actually on file using the SAME vendored conditionCanon the route-picker brain uses — NOT the
// weak normalizeName, which leaves "Lumbar Back/Sciatica" unmatched against an on-file "lumbago"/"sciatica".
// Same runtime-load pattern as case-framing-stamp.loadMechanismFilter (createRequire over absolute entries,
// covering the Lambda anchor-vendor copy + the backend/repo-root cwds). FAIL-OPEN: any load error → undefined
// → the dx check degrades to normalizeName (today's behavior). Cached (undefined = not tried; null = absent).
const VENDOR_DIR = process.env['ANCHOR_VENDOR_DIR'] ?? 'anchor-vendor';
interface ConditionCanonModule { canonicalizeCondition(text: string): string | null }
let _canon: ((s: string) => string | null) | null | undefined;
function loadCanonicalizer(): ((s: string) => string | null) | undefined {
  if (_canon !== undefined) return _canon ?? undefined;
  try {
    const candidates = [
      path.join(process.cwd(), VENDOR_DIR, 'conditionCanon.cjs'),
      path.join(process.cwd(), 'src', 'vendor', 'conditionCanon.cjs'),
      path.join(process.cwd(), 'backend', 'src', 'vendor', 'conditionCanon.cjs'),
    ];
    const entry = candidates.find((c) => existsSync(c));
    if (entry === undefined) { _canon = null; return undefined; }
    const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
    const m = req(entry) as ConditionCanonModule;
    _canon = (s: string): string | null => { try { return m.canonicalizeCondition(s); } catch { return null; } };
    return _canon;
  } catch { _canon = null; return undefined; }
}

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
  /** Granted SC condition names on file — the dx check also matches the claim against these (a granted SC
   *  condition implies a documented diagnosis, per the screen-is-not-a-dx rule: SC determination is dx-proof). */
  scConditionNames?: string[];
  /** The veteran's lay/buddy statement (§1154(b)). A documented in-service event can be established by
   *  competent lay testimony, not only a DD-214/STR — so a lay statement satisfies the in-service-event check. */
  layStatement?: string | null;
  /** The extracted-document digest (the SAME source Ask Aegis + the SOAP read). The dx / prior-denial checks
   *  match the claim / a denial against the chart's actual extracted text, not just the structured columns. */
  chartDigest?: string | null;
  /**
   * The route-picker plan (the SAME brain the drafter + SOAP + Ask Aegis use), read $0 from the persisted
   * plan. When present it supplies (a) the REASONED framing the modal shows instead of "default (direct)",
   * and (b) the brain's authoritative list of genuine missing facts: an essential the brain did NOT list as
   * missing is treated as PRESENT (the brain read the full chart and found it). Absent → legacy behavior.
   */
  routePlan?: RoutePlanForReadiness | null;
}

/** The slice of the route-picker plan the readiness evaluator consumes. */
export interface RoutePlanForReadiness {
  readonly framing: string;
  readonly cfr_basis: string;
  readonly mechanism: string;
  readonly rationale: string;
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  /** The brain's own list of genuine missing facts ({fact, why}); the absence signal for the essentials. */
  readonly missing: ReadonlyArray<{ readonly fact: string; readonly why: string }>;
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
  /**
   * The route-picker plan the evaluation consulted (the SAME brain the drafter pleads), when available. The
   * modal shows this REASONED framing + rationale instead of the bare SSOT label / "default (direct)". Absent
   * when the flag is off / no persisted plan / wrong-condition plan (the modal falls back to caseFraming).
   */
  routePlan?: RoutePlanForReadiness;
}

const APPEAL_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(['supplemental', 'hlr', 'appeal_bva']);

// ── SAME-BRAIN absence classifier. The route-picker plan's missing[] is the brain's authoritative list of
// genuine gaps (it read the full chart). We map each essential to keyword cues so "an in-service stressor is
// not documented" counts against in_service_event, "no current diagnosis of X" against current_diagnosis, and
// "the prior denial letter is not in the file" against prior_denial. If the brain did NOT flag an essential
// missing, that essential is PRESENT per the brain — the core same-brain win over filename/column heuristics.
// Stem-based (no trailing \b on word stems — "diagnos" must match "diagnosis"/"diagnosed"/"diagnostic").
const DX_MISSING_CUES = /\b(diagnos|\bdx\b|confirmed condition|medical record (?:of|showing)|current (?:condition|disease))/i;
const EVENT_MISSING_CUES = /\b(in[-\s]?service|stressor|injur|exposure|incident|nexus to service|service connection to|dd[-\s]?214|service record|\bstr\b|separation|event)/i;
const DENIAL_MISSING_CUES = /\b(denial|denied|deny|decision letter|rating decision|prior claim|statement of the case|\bsoc\b)/i;
function brainFlagsMissing(plan: RoutePlanForReadiness | null | undefined, cues: RegExp): boolean | null {
  if (!plan) return null; // no plan → no brain opinion (caller keeps the deterministic result)
  return plan.missing.some((m) => cues.test(`${m.fact} ${m.why}`));
}

// Filename/docTag heuristics. docTag classification isn't populating yet (all 'Other'), so the
// filename is the workhorse; docTag is checked too for when classification lands.
const DENIAL_DOC = /(denial|denied|decision|s00?c|statement of the case)/i;
const _RATING_DOC = /(rating\s*decision|code\s*sheet|rating\s*sheet)/i; // parked until docTag classification lands
const SERVICE_DOC = /(dd[\s-]?214|service\s*treatment|^str\b|separation|enlist|entrance\s*exam|service\s*record)/i;

function hasDoc(documents: { filename: string; docTag: string | null }[], re: RegExp): boolean {
  return documents.some((d) => re.test(d.filename) || (d.docTag != null && re.test(d.docTag)));
}

/**
 * Does the claimed condition appear as a documented diagnosis on file? Matches the claim against the problem
 * list AND the granted-SC list (a granted SC condition is dx-proof) AND — when the vendored canonicalizer is
 * available — the extracted-document digest, all CANONICALIZED so "Lumbar Back/Sciatica" matches an on-file
 * "lumbago"/"sciatica" (the normalizeName-only check missed these). Fail-open: canonicalizer absent → falls
 * back to normalizeName synonym folding against the structured lists only (today's behavior).
 */
function conditionDocumented(
  claimed: string[],
  problemNames: string[],
  scConditionNames: string[],
  chartDigest: string | null | undefined,
): boolean {
  // Structured-list match (normalizeName synonym fold) — the baseline, always available.
  const wanted = new Set(claimed.map(normalizeName));
  const onFile = [...problemNames, ...scConditionNames];
  if (onFile.some((p) => wanted.has(normalizeName(p)))) return true;

  // Canonical match: fold the claim + each on-file entry through the vendored conditionCanon so distinct
  // surface strings that name the SAME rated entity match. Then scan the extracted digest for the canonical
  // label (a dx documented in the records but not yet in the structured problem list).
  const canon = loadCanonicalizer();
  if (canon === undefined) return false;
  const claimedCanon = new Set(claimed.map((c) => canon(c)).filter((x): x is string => x !== null && x.length > 0));
  if (claimedCanon.size === 0) return false;
  if (onFile.some((p) => { const c = canon(p); return c !== null && claimedCanon.has(c); })) return true;
  // Digest scan: canonicalizeCondition matches its label patterns anywhere in the text and returns the first
  // hit, so for a per-line digest we test line-by-line — a dx documented in the records (e.g. an assessment
  // line) but not yet in the structured problem list still satisfies the check. Bounded scan (digest is capped
  // upstream); a no-match line costs one regex sweep. The route-picker plan's missing[] is the stronger same-
  // brain signal layered on top of this in the caller.
  if (chartDigest && chartDigest.length > 0) {
    for (const line of chartDigest.split('\n')) {
      const c = canon(line);
      if (c !== null && claimedCanon.has(c)) return true;
    }
  }
  return false;
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

  // SAME-BRAIN gate (2026-06-21): the route-picker plan (the SAME brain the drafter pleads) read the FULL
  // extracted chart. Its missing[] is the authoritative absence list. For each essential we take the FACT as
  // present when EITHER the deterministic evidence is on file OR a plan exists and the brain did NOT list that
  // essential as missing. A genuine absence still flags: deterministic evidence absent AND (no plan OR the
  // brain flagged it). Fail-open: no plan → pure deterministic behavior (byte-identical to before).
  const plan = input.routePlan ?? null;
  const brainSaysDenialMissing = brainFlagsMissing(plan, DENIAL_MISSING_CUES);
  const brainSaysDxMissing = brainFlagsMissing(plan, DX_MISSING_CUES);
  const brainSaysEventMissing = brainFlagsMissing(plan, EVENT_MISSING_CUES);

  // 2. Denial letter — only required when the claim is an appeal (supplemental / HLR / BVA). Same-brain: the
  //    brain extracts a prior denial from the chart text even when the upload's filename doesn't say "denial".
  if (APPEAL_TYPES.has(input.claimType)) {
    const onFile = hasDoc(input.documents, DENIAL_DOC);
    const inDigest = (input.chartDigest ?? '').length > 0 && DENIAL_DOC.test(input.chartDigest!);
    const brainHasIt = plan !== null && brainSaysDenialMissing === false;
    const present = onFile || inDigest || brainHasIt;
    items.push({
      key: 'denial_letter',
      label: 'VA denial letter (appeal)',
      present,
      basis: onFile ? 'denial/decision document on file'
        : inDigest ? 'a prior denial/decision is in the extracted records'
        : brainHasIt ? 'the case plan accounts for the prior denial'
        : 'no denial/decision document found',
      ...(present ? {} : {
        message: 'Essential documents missing: This is an appeal. Please upload the VA denial letter being appealed and redraft.',
      }),
    });
  }

  // 3. Current diagnosis — the claimed condition is documented as a dx (problem list OR granted SC OR the
  //    extracted records, canonicalized) OR the brain (which read the full chart) did not flag it missing.
  {
    const documented = conditionDocumented(claimedAll, input.problemNames, input.scConditionNames ?? [], input.chartDigest);
    const brainHasIt = plan !== null && brainSaysDxMissing === false;
    const present = documented || brainHasIt;
    items.push({
      key: 'current_diagnosis',
      label: 'Current diagnosis',
      present,
      basis: documented ? `"${input.claimedCondition}" is documented in the records`
        : brainHasIt ? `the case plan confirms a current diagnosis of ${input.claimedCondition}`
        : `"${input.claimedCondition}" not found as a documented diagnosis`,
      ...(present ? {} : {
        message: `Essential documents missing: A current diagnosis for ${input.claimedCondition} is not on file. Please upload a medical record showing the current diagnosis and redraft.`,
      }),
    });
  }

  // 4. In-service event — a recorded event OR a lay/buddy statement (§1154(b): competent lay testimony can
  //    establish an in-service event) OR a service record (DD-214 / STR) OR — for a secondary/aggravation
  //    claim — a GRANTED SC anchor (per 38 CFR 3.310 the claim attaches to the SC primary, not a fresh event;
  //    the Hatfield anchor rule) OR the brain did not flag it missing.
  {
    const hasEventText = (input.inServiceEvent ?? '').trim().length > 0;
    const hasLayStatement = (input.layStatement ?? '').trim().length > 0;
    const hasServiceDoc = hasDoc(input.documents, SERVICE_DOC);
    const anchor = isSecondary && ssotTheory !== null && cf !== undefined ? cf.grantedScAnchors[0] : undefined;
    const anchorSatisfies = anchor !== undefined;
    const brainHasIt = plan !== null && brainSaysEventMissing === false;
    const present = hasEventText || hasLayStatement || hasServiceDoc || anchorSatisfies || brainHasIt;
    items.push({
      key: 'in_service_event',
      label: 'In-service event / service record',
      present,
      basis: hasEventText ? 'in-service event recorded on case'
        : hasLayStatement ? 'in-service event supported by a lay/buddy statement (§1154(b))'
        : hasServiceDoc ? 'DD-214 / service record on file'
        : anchorSatisfies ? `satisfied by granted SC anchor ${anchor.condition}${anchor.ratingPct !== null ? ` (${anchor.ratingPct}%)` : ''}`
        : brainHasIt ? 'the case plan accounts for the in-service connection'
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
  return {
    ready, items, missing, summary, buildState: 'chart_ready',
    ...(cf !== undefined ? { caseFraming: cf } : {}),
    ...(plan !== null ? { routePlan: plan } : {}),
  };
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
  veteranStatement: string | null;
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
    scCondition: { findMany: (args: { where: { veteranId: string; status: string }; select: { condition: true } }) => Promise<{ condition: string }[]> };
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
    scDelegate.findMany({ where: { veteranId: c.veteranId, status: 'service_connected' }, select: { condition: true } }),
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

  // SAME-BRAIN feed (2026-06-21): the Gate-1 readiness reads the ONE brain — the persisted route-picker plan
  // (the SAME one the drafter pleads + the SOAP renders) and the extracted-chart digest (the SAME one Ask
  // Aegis cites) — instead of filename regexes + the weak normalizeName. compute:false → $0 (NO ~22s LLM call
  // on this synchronous GET; deriveAiViability applies its own staleness/wrong-condition guards). Both
  // fail-open to null so a vendor/plan hiccup degrades to the deterministic-only behavior.
  const [caseFraming, plan, chartDigest] = await Promise.all([
    // Live-derive the SSOT framing through the ONE shared derivation (architect QA: consumers call the
    // producer function, never a second regex). Null (raced delete) → legacy path, fail-open.
    deriveCaseFramingForCase(db, caseId).catch(() => null),
    deriveAiViability(db, caseId, { compute: false }).catch(() => null),
    buildDigestForCase(db, caseId).catch(() => null),
  ]);

  // Only ground on the plan when it is for THIS claimed condition (deriveAiViability already guards this, but
  // re-check defensively — a wrong-condition plan must NEVER satisfy the dx check for a different condition).
  const routePlan: RoutePlanForReadiness | null =
    plan && plan.lead && plan.inputClaimed === c.claimedCondition
      ? {
          framing: plan.lead.framing,
          cfr_basis: plan.lead.cfr_basis,
          mechanism: plan.lead.mechanism,
          rationale: plan.lead.rationale,
          viability: plan.viability,
          missing: plan.missing.map((m) => ({ fact: m.fact, why: m.why })),
        }
      : null;

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
    scConditionNames: grantedSc.map((s) => s.condition),
    layStatement: c.veteranStatement,
    chartDigest,
    routePlan,
    documents,
  });
}
