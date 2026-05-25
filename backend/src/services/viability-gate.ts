import type { CaseRecord, CdsVerdict } from './db-types.js';

export type ViabilityVerdict = 'go' | 'clarify' | 'needs_from_vet' | 'not_viable';

export interface ViabilityBlocker {
  readonly code:
    | 'no_diagnosis_on_file'
    | 'cds_not_run'
    | 'cds_reject'
    | 'no_assigned_physician'
    | 'no_upstream_for_secondary'
    | 'chart_records_pending'
    | 'chart_files_unread';
  readonly severity: 'block' | 'warn';
  readonly detail: string;
}

export interface ViabilityInput {
  readonly caseRow: Pick<
    CaseRecord,
    'id' | 'status' | 'claimedCondition' | 'claimType' | 'framingChoice' | 'upstreamScCondition' | 'assignedPhysicianId' | 'cdsVerdict'
  >;
  readonly activeProblems: readonly { problem: string }[];
  readonly chartReadiness?: { ready: boolean; manualSummaryRequired: number };
}

export interface ViabilityResult {
  readonly verdict: ViabilityVerdict;
  readonly cdsVerdict: CdsVerdict;
  readonly blockers: readonly ViabilityBlocker[];
  readonly recommendations: readonly string[];
  readonly checkedAt: string;
  readonly gateVersion: string;
}

const GATE_VERSION = 'viability-gate-1.0.0';

function isSecondary(framingChoice: string | null): boolean {
  if (framingChoice === null) return false;
  return /secondary|aggravat/i.test(framingChoice);
}

/**
 * Pre-draft viability gate. Three terminal verdicts:
 *   - not_viable    -> any hard blocker (CDS reject; no diagnosis)
 *   - needs_from_vet-> chart-records-pending blockers (the veteran has to do something first)
 *   - clarify       -> warnings only (CDS not run yet; secondary with no upstream; no physician)
 *   - go            -> nothing blocking; the case is ready for drafting
 *
 * The gate is deterministic and pure — no LLM, no IO. It does NOT mutate the case.
 */
export function evaluateViabilityGate(input: ViabilityInput): ViabilityResult {
  const blockers: ViabilityBlocker[] = [];
  const recommendations: string[] = [];

  // Chart-readiness gate (Phase 5.2 OCR HARD-STOP). If any uploaded file is unread without
  // a manual summary, the case is `needs_from_vet`-equivalent (RN must intervene). This block
  // is unbypassable and outranks every soft warning below it.
  if (input.chartReadiness !== undefined && !input.chartReadiness.ready) {
    blockers.push({
      code: 'chart_files_unread',
      severity: 'block',
      detail: `${input.chartReadiness.manualSummaryRequired} file(s) cannot be read by any OCR method and need RN manual interpretation.`,
    });
    recommendations.push('Open the files-pending-manual list and have an RN provide a manual summary (>=40 chars) for each blocking file.');
  }

  // Hard blocks (-> not_viable)
  if (input.activeProblems.length === 0) {
    blockers.push({
      code: 'no_diagnosis_on_file',
      severity: 'block',
      detail: 'No active diagnoses recorded; a current diagnosis is required before drafting.',
    });
    recommendations.push('Add the active diagnosis to the veteran chart from the records or request records via clarification queue.');
  }

  if (input.caseRow.cdsVerdict === 'reject') {
    blockers.push({
      code: 'cds_reject',
      severity: 'block',
      detail: 'CDS engine returned a reject verdict. Resolve the underlying issue before drafting.',
    });
    recommendations.push('Review the CDS rationale on the Case Detail panel.');
  }

  // Records-pending (-> needs_from_vet). Status 'records' means we are waiting on additional
  // records — surface it as a distinct verdict so the UI can compose a vet-facing email.
  if (input.caseRow.status === 'records') {
    blockers.push({
      code: 'chart_records_pending',
      severity: 'block',
      detail: 'Case is in the records-gathering stage.',
    });
    recommendations.push('Compose a records-request to the veteran from the clarification queue (audience: veteran).');
  }

  // Soft warnings (-> clarify)
  if (input.caseRow.cdsVerdict === 'not_yet_run') {
    blockers.push({ code: 'cds_not_run', severity: 'warn', detail: 'CDS has not been run yet for this case.' });
    recommendations.push('Run CDS from the Case Detail panel to surface the BVA odds and any hard gates.');
  }

  if (isSecondary(input.caseRow.framingChoice) && !input.caseRow.upstreamScCondition) {
    blockers.push({
      code: 'no_upstream_for_secondary',
      severity: 'warn',
      detail: 'Secondary framing chosen but no upstream service-connected condition recorded.',
    });
    recommendations.push('Set Upstream SC Condition on the case before drafting.');
  }

  if (!input.caseRow.assignedPhysicianId) {
    blockers.push({ code: 'no_assigned_physician', severity: 'warn', detail: 'No physician is assigned to this case.' });
    recommendations.push('Assign a physician (admin/ops_staff action) before sign-off.');
  }

  // Verdict derivation.
  const hardBlockers = blockers.filter((b) => b.severity === 'block');
  const hardCodes = new Set(hardBlockers.map((b) => b.code));
  let verdict: ViabilityVerdict;
  if (hardCodes.has('cds_reject') || hardCodes.has('no_diagnosis_on_file')) {
    verdict = 'not_viable';
  } else if (hardCodes.has('chart_records_pending') || hardCodes.has('chart_files_unread')) {
    verdict = 'needs_from_vet';
  } else if (blockers.some((b) => b.severity === 'warn')) {
    verdict = 'clarify';
  } else {
    verdict = 'go';
  }

  return {
    verdict,
    cdsVerdict: input.caseRow.cdsVerdict,
    blockers,
    recommendations,
    checkedAt: new Date().toISOString(),
    gateVersion: GATE_VERSION,
  };
}

export const VIABILITY_GATE_VERSION = GATE_VERSION;
