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
import type { AppDb } from './db-types.js';

export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';

export interface DraftReadinessInput {
  claimType: ClaimType;
  claimedCondition: string;
  claimedConditions: string[];
  inServiceEvent: string | null;
  /** Count of ScCondition rows with status='service_connected' (granted). */
  grantedScCount: number;
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
}

const APPEAL_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(['supplemental', 'hlr', 'appeal_bva']);

// Filename/docTag heuristics. docTag classification isn't populating yet (all 'Other'), so the
// filename is the workhorse; docTag is checked too for when classification lands.
const DENIAL_DOC = /(denial|denied|decision|s00?c|statement of the case)/i;
const RATING_DOC = /(rating\s*decision|code\s*sheet|rating\s*sheet)/i;
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

  // 1. Service-connected conditions — the grants must be ON FILE (not just a rating-type doc that
  //    was never itemized). Mirrors the drafter's granted_sc_empty_but_rating_doc_present gate.
  {
    const present = input.grantedScCount >= 1;
    items.push({
      key: 'sc_conditions',
      label: 'Service-connected conditions',
      present,
      basis: `${input.grantedScCount} granted SC condition(s) on file`,
      ...(present ? {} : {
        message: 'Essential documents missing: Please upload the VA rating decision (the letter that lists each service-connected condition) and redraft.',
      }),
    });
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

  // 4. In-service event — a recorded event OR a service record (DD-214 / STR) on file.
  {
    const hasEventText = (input.inServiceEvent ?? '').trim().length > 0;
    const hasServiceDoc = hasDoc(input.documents, SERVICE_DOC);
    const present = hasEventText || hasServiceDoc;
    items.push({
      key: 'in_service_event',
      label: 'In-service event / service record',
      present,
      basis: hasEventText ? 'in-service event recorded on case' : hasServiceDoc ? 'DD-214 / service record on file' : 'no in-service event or service record',
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

  return { ready, items, missing, summary };
}

interface CaseForReadiness {
  veteranId: string;
  claimType: ClaimType;
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
    document: { findMany: (args: { where: { caseId: string }; select: { filename: true; docTag: true } }) => Promise<{ filename: string; docTag: string | null }[]> };
  }).document;

  const [grantedSc, problems, documents] = await Promise.all([
    scDelegate.findMany({ where: { veteranId: c.veteranId, status: 'service_connected' } }),
    db.activeProblem.findMany({ where: { veteranId: c.veteranId } }),
    docDelegate.findMany({ where: { caseId }, select: { filename: true, docTag: true } }),
  ]);

  return evaluateDraftReadiness({
    claimType: c.claimType,
    claimedCondition: c.claimedCondition,
    claimedConditions: c.claimedConditions ?? [],
    inServiceEvent: c.inServiceEvent,
    grantedScCount: grantedSc.length,
    problemNames: problems.map((p) => (p as { problem: string }).problem),
    documents,
  });
}
