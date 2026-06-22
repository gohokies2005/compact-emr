import { apiGet } from './client';

// GET /cases/:id/draft-readiness — the essential-docs evaluation + the SSOT caseFraming object.
// NOT the same endpoint as api/chart-readiness.ts (`/chart-readiness` = OCR/file-read blocking only,
// no items[], no caseFraming). This one is the Gate-1 pre-fill / framing-provenance feed.

export type ReadinessKey = 'sc_conditions' | 'denial_letter' | 'current_diagnosis' | 'in_service_event';
export type ChartBuildState = 'no_documents' | 'ocr_in_progress' | 'extracting' | 'extract_failed' | 'chart_ready';

export interface ReadinessItem {
  readonly key: ReadinessKey;
  readonly label: string;
  readonly present: boolean;
  /** Plain, fixed RN-facing alert when missing. Undefined when present. */
  readonly message?: string;
  /** What the auto-detect keyed on (e.g. 'satisfied by granted SC anchor Anxiety (70%)'). */
  readonly basis: string;
}

/** SSOT caseFraming v1 (vendored contract caseFraming.v1.schema.json — read-only on the frontend). */
export interface CaseFraming {
  readonly version: number;
  readonly framing: 'direct' | 'secondary' | 'aggravation' | 'undetermined';
  readonly grantedScAnchors: ReadonlyArray<{ readonly condition: string; readonly ratingPct: number | null; readonly status: 'service_connected' }>;
  readonly upstreamScCondition: string | null;
  readonly framingChoice: 'secondary' | 'aggravation' | 'direct' | null;
  readonly claimType: 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
  readonly source: 'rn_set' | 'derived' | 'text_parse_fallback' | 'default_direct';
  readonly derivedAt: string;
}

/** The route-picker plan slice the readiness evaluation consulted (the SAME brain the drafter pleads). When
 *  present the Gate-1 modal shows this REASONED framing + rationale instead of the bare SSOT label. */
export interface RoutePlanForReadiness {
  readonly framing: string;
  readonly cfr_basis: string;
  readonly mechanism: string;
  readonly rationale: string;
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  readonly missing: ReadonlyArray<{ readonly fact: string; readonly why: string }>;
}

export interface DraftReadinessResult {
  readonly ready: boolean;
  readonly items: readonly ReadinessItem[];
  readonly missing: readonly ReadinessItem[];
  readonly summary: string;
  readonly buildState: ChartBuildState;
  readonly caseFraming?: CaseFraming;
  readonly routePlan?: RoutePlanForReadiness;
  /** #2: brain-listed gaps that mapped to no specific essential — shown to the RN; the brain's silence did NOT
   *  satisfy any essential off these (downgrade-only trust). Absent/empty when the plan is clean / no plan. */
  readonly unclassifiedGaps?: ReadonlyArray<{ readonly fact: string; readonly why: string }>;
  /** #7: false ONLY when the route-picker brain feed ERRORED (the check ran deterministic-only). A clean "no
   *  plan" is NOT degraded → stays true. Absent ⇒ treat as consulted. */
  readonly brainConsulted?: boolean;
  /** #7: RN-facing note shown when the brain feed was unavailable, so the degraded state is visible. */
  readonly degradedNote?: string;
}

export async function getDraftReadiness(caseId: string): Promise<{ data: DraftReadinessResult }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/draft-readiness`);
}
