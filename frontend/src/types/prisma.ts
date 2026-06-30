export type YesNoUnknown = 'yes' | 'no' | 'unknown';
export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
export type CaseStatus = 'intake' | 'records' | 'viability' | 'drafting' | 'rn_review' | 'physician_review' | 'correction_requested' | 'correction_review' | 'delivered' | 'paid' | 'rejected' | 'needs_rn_decision' | 'needs_records';
export type CdsVerdict = 'accept' | 'caution' | 'reject' | 'not_yet_run';
export type DraftJobState = 'queued' | 'running' | 'done' | 'failed' | 'halted';
export type CorrectionReason = 'veteran_added_info' | 'physician_caught_error' | 'ops_caught_error' | 'va_examiner_feedback' | 'other';
export type BillingTier = 'free_first' | 'free_our_fault' | 'paid_50';
export type PhysicianActivity = 'letter_review' | 'correction_review';
export type EmailDirection = 'inbound' | 'outbound';
export type PaymentKind = 'review_50' | 'letter_350' | 'letter_500' | 'refund' | 'correction_fee';
export type Role = 'admin' | 'physician' | 'ops_staff';

export interface VersionedRecord { readonly updatedAt: string; readonly version: number; }
export interface AppUser extends VersionedRecord { readonly id: string; readonly cognitoSub: string; readonly email: string; readonly createdAt: string; readonly roles?: readonly AppUserRole[]; }
export interface CognitoGroup { readonly name: Role; readonly createdAt: string; }
export interface AppUserRole { readonly userId: string; readonly role: Role; }
export interface Veteran extends VersionedRecord { readonly id: string; readonly lastName: string; readonly firstName: string; readonly dob: string; readonly email: string; readonly phone?: string; readonly address?: string; readonly branch: string; readonly serviceStartYear: number; readonly serviceEndYear: number; readonly combatVeteran: YesNoUnknown; readonly pactArea: YesNoUnknown; readonly teraConceded: YesNoUnknown; readonly heightIn?: number; readonly weightLb?: number; readonly createdAt: string; }
export type ScConditionStatus = 'service_connected' | 'pending' | 'denied';
export interface ScCondition extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly condition: string; readonly dcCode?: string; readonly ratingPct?: number; readonly status: ScConditionStatus; readonly grantedDate?: string; readonly createdAt: string; }
export interface ActiveProblem extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly problem: string; readonly notes?: string; readonly createdAt: string; }
export interface ActiveMedication extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly drugName: string; readonly dose?: string; readonly frequency?: string; readonly indication?: string; readonly medStatus?: string; readonly startDate?: string | null; readonly lastSeenDate?: string | null; readonly createdAt: string; }
// 'blocked' added for the condition-not-in-library feature (task #155). 'hold' added on
// ShipRecommendation as a third option distinct from ship/revise.
export type OperatorState = 'ready' | 'ready_with_notes' | 'needs_one_thing' | 'paused' | 'blocked';
export type ShipRecommendation = 'ship' | 'revise' | 'hold';
export type Grade = 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C';
export type FailureClass = 'transient' | 'degrade' | 'needs_human' | 'system';

// Phase 8 drafter manifest + grade sidecar shapes. The 15 named phases mirror the spine's
// pipeline_manifest.json. Exported so consumer components share a single source of truth
// (Chunk 1 panels defined narrow inline; Chunk 2 promotes them).
export type DraftJobPhase =
  | 'preflight'
  | 'index_consult'
  | 'framing_gate'
  | 'cover_memo'
  | 'source_lock'
  | 'drafter'
  | 'adversary_panel'
  | 'specialist_gate'
  | 'refine_loop'
  | 'surgical_edit'
  | 'citation_scoring'
  | 'pmid_verify'
  | 'linter'
  | 'qa_report'
  | 'grader'
  | 'render';

export interface TargetedRevisionHint {
  readonly section?: string | null;
  readonly issue?: string | null;
  readonly suggested_fix?: string | null;
}

// Phase 6.4 template/anchor-binding gate findings. The drafter writes the same array to
// v<N>_template_gate.json + the qa_report and includes it in the gradeSidecar posted to
// /complete, which persists the whole object as gradeSidecarJson. Record-only + overridable:
// the physician confirms/fixes at sign-off (e.g. "missing institutional anchor").
export interface TemplateGateFinding {
  readonly id?: string | null;
  readonly message?: string | null;
  readonly severity?: string | null;
  readonly physician_decision?: boolean;
  readonly audit_only?: boolean;
}

export interface DraftGradeSidecarJson {
  readonly targeted_revision_hints?: readonly TargetedRevisionHint[];
  readonly template_gate_findings?: readonly TemplateGateFinding[];
  readonly detail_phase?: string | null;
  // True when the displayed grade is a synthesized FLOOR (grader crash / early halt produced no
  // real probative grade) — UI renders "grade unavailable", never a silent C. Producer = the
  // drafter worker (cross-window); dormant in the EMR until the worker emits it. 2026-06-03.
  readonly synthesized_floor?: boolean | null;
  readonly synthesized_floor_reason?: string | null;
}

export interface DraftManifestPhase {
  readonly operator_message?: string | null;
  readonly summary?: string | null;
  readonly status?: string | null;
}

export interface DraftManifestSnapshot {
  readonly phases?: Record<string, DraftManifestPhase>;
}

export interface Case extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly claimedCondition: string; readonly claimType: ClaimType; readonly framingChoice?: string; readonly upstreamScCondition?: string; readonly veteranStatement?: string; readonly inServiceEvent?: string; readonly status: CaseStatus; readonly cdsVerdict: CdsVerdict; readonly cdsOddsPct?: number; readonly cdsRationale?: Record<string, unknown>; readonly assignedPhysicianId?: string; readonly refundEligible: boolean; readonly currentVersion: number; readonly createdAt: string;
  // Phase 8 drafter integration: terminal-state snapshot from v<N>_qa_grade.json + final manifest.
  // Triage rule: case routes to physician_review only when (runComplete === true && shipRecommendation === 'ship').
  readonly probativeScore?: number | null;
  readonly grade?: Grade | null;
  readonly shipRecommendation?: ShipRecommendation | null;
  readonly operatorState?: OperatorState | null;
  readonly runComplete?: boolean | null;
  // G8: RN-friendly message accompanying operatorState (populated by /complete + by stuck-job watcher on sweep).
  readonly operatorMessage?: string | null;
}
export interface Document extends VersionedRecord { readonly id: string; readonly caseId: string; readonly filename: string; readonly sizeBytes: string; readonly contentType: string; readonly docTag?: string; readonly pageCount?: number | null; readonly autoTitle?: string | null; readonly docType?: string; readonly duplicateOfId?: string | null; readonly s3Key: string; readonly uploadedAt: string; readonly uploadedBy: string; }
export interface Gate2SwitchProposal { readonly dx: string; readonly scAnchor?: string; readonly whyMoreViable?: string; readonly plainEnglish?: string }
export interface Gate2HaltPayload {
  readonly haltGate?: string;
  readonly reasonCode?: string;
  readonly plainEnglish?: string;
  /** Tri-state gate verdicts: 'found' | 'not_found' | 'uncertain' (drafter dxVerificationGate). */
  readonly claimedDxFound?: string | null;
  readonly inServiceEventFound?: string | null;
  /** PHI-scrubbed short quote + source doc backing each verdict (drafter-worker postDxGateHalt). */
  readonly claimedDxEvidence?: string | null;
  readonly inServiceEventEvidence?: string | null;
  readonly switchProposal?: Gate2SwitchProposal | null;
  readonly operatorMessage?: string;
  // ── Body-quality park (FRN draftBodyQualityGate) ────────────────────────────────────────────
  // A FULL draft was produced but the deterministic body-quality gate found a letter-killing
  // MATERIAL defect → the letter is parked for a targeted RE-DRAFT (not a dx/event hold). Detect via
  // isBodyQualityHalt() below: reasonCode === 'body_quality_critical' (dedicated, future) OR
  // haltGate === 'body_quality' (the current legacy emission that borrows the 'verify_error' code).
  // The FRN side currently sends `materialIds` (string ids); the forthcoming dedicated payload may
  // send richer `material` rows. Accept BOTH shapes.
  readonly materialIds?: readonly string[] | null;
  readonly material?: readonly Gate2BodyQualityFinding[] | null;
  // ── DX-resolution chooser (#218a) ───────────────────────────────────────────────────────────
  // Emitted by the FRN drafter on a dx-verification HALT (worker forwards verbatim; /halt stores it
  // in haltPayloadJson). ABSENT/null until the drafter image redeploys — when absent the dx-halt UI
  // renders exactly as today (the always-present #213 change-dx box). When present with mode
  // 'needs_clarification', the panel surfaces a candidate chooser. See Gate2DxResolution.
  readonly dxResolution?: Gate2DxResolution | null;
}
/** One body-quality defect row (forthcoming richer FRN park payload: {id, section, detail}). */
export interface Gate2BodyQualityFinding { readonly id: string; readonly section?: string | null; readonly detail?: string | null }

/**
 * DX-resolution guidance from the drafter's pre-draft dx-verification (#218a contract, fixed).
 * - 'auto_adopted'   → the drafter adopted a clear dx and PROCEEDED to draft (no halt). N/A on the
 *                      halt path; the relabel note for this is #218b (drafter proceed-path report, owed).
 * - 'needs_clarification' → multiple plausible dx; surface `candidates` as a chooser + (if allowed) free-type.
 * - 'no_dx'          → no diagnosis could be resolved; today's halt behavior (real reason + re-run).
 */
export interface Gate2DxResolution {
  readonly mode: 'auto_adopted' | 'needs_clarification' | 'no_dx';
  readonly adoptedDx?: string | null;
  readonly candidates: readonly string[];
  readonly allowFreeType: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly note: string;
}

/**
 * True when a halt payload is a BODY-QUALITY park (letter held for re-draft), not a dx/event
 * verification hold. Forward/backward compatible: matches the dedicated 'body_quality_critical'
 * reasonCode AND the current legacy emission (haltGate 'body_quality' carrying a borrowed
 * 'verify_error' code, sent until the FRN drafter image redeploys).
 */
export function isBodyQualityHalt(payload: Gate2HaltPayload | null | undefined): boolean {
  if (payload === null || payload === undefined) return false;
  return payload.reasonCode === 'body_quality_critical' || payload.haltGate === 'body_quality';
}

export interface DraftJob { readonly id: string; readonly caseId: string; readonly version: number; readonly sqsMessageId?: string; readonly state: DraftJobState; readonly enqueuedAt: string; readonly startedAt?: string; readonly completedAt?: string; readonly errorMessage?: string; readonly updatedAt: string;
  // Phase 8 drafter integration: progress + terminal fields populated by drafter wrapper
  // via /internal/drafter/jobs/:id/{progress,complete}. Chunk 2 promoted the manifest +
  // grade sidecar shapes to shared exported interfaces so panels don't redefine inline.
  readonly manifestSnapshot?: DraftManifestSnapshot | null;
  readonly currentPhase?: DraftJobPhase | string | null;
  readonly nextRetryInS?: number | null;
  readonly failureClass?: FailureClass | null;
  readonly gradeSidecarJson?: DraftGradeSidecarJson | null;
  readonly haltPayloadJson?: Gate2HaltPayload | null; // Gate-2 halt reason + switchProposal for the RN UI
  readonly artifactPdfS3Key?: string | null;
  readonly artifactTxtS3Key?: string | null;
  readonly artifactDocxS3Key?: string | null;
  readonly strategyOverride?: string | null;
  readonly parentVersion?: number | null;
  readonly workerId?: string | null;
  readonly lastHeartbeatAt?: string | null;
  readonly bundleS3Key?: string | null;
  // Per-claim drafting cost in US dollars for this run (serialized as a number by the API; 0 when
  // no metered LLM spend, null/absent for pre-2026-06-02 jobs). Summed per case for the cost report.
  readonly costUsd?: number | null;
}
export interface Correction extends VersionedRecord { readonly id: string; readonly caseId: string; readonly fromVersion: number; readonly toVersion?: number; readonly correctionReason: CorrectionReason; readonly correctionNote: string; readonly affectsSections: readonly unknown[]; readonly billingTier: BillingTier; readonly requestedBy: string; readonly requestedAt: string; readonly approvedBy?: string; readonly approvedAt?: string; }
export interface Physician extends VersionedRecord { readonly id: string; readonly fullName: string; readonly npi: string; readonly specialty: string; readonly medicalLicense: string; readonly email: string; readonly phone?: string; readonly signatureImageS3Key?: string; readonly active: boolean; readonly createdAt: string; }
export interface PhysicianCompensation extends VersionedRecord { readonly id: string; readonly physicianId: string; readonly caseId: string; readonly activity: PhysicianActivity; readonly amountCents: number; readonly accruedAt: string; readonly paidAt?: string; readonly payrollBatchId?: string; }
export interface Email extends VersionedRecord { readonly id: string; readonly caseId: string; readonly direction: EmailDirection; readonly subject: string; readonly body: string; readonly fromAddress: string; readonly toAddress: string; readonly sentAt: string; readonly gmailMessageId?: string; readonly createdAt: string; }
export interface ActivityLog { readonly id: string; readonly caseId?: string; readonly veteranId?: string; readonly actorUserId?: string; readonly action: string; readonly detailsJson?: Record<string, unknown>; readonly ts: string; }
export interface Payment extends VersionedRecord { readonly id: string; readonly caseId: string; readonly kind: PaymentKind; readonly amountCents: number; readonly stripeChargeId?: string; readonly status: string; readonly settledAt?: string; readonly createdAt: string; }
