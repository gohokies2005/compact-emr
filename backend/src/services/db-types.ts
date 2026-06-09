import type { AuthenticatedUser } from '../auth/roles.js';

export type Role = 'admin' | 'ops_staff' | 'physician';

export type YesNoUnknown = 'yes' | 'no' | 'unknown';
export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
export type CaseStatus =
  | 'intake'
  | 'records'
  | 'viability'
  | 'drafting'
  | 'rn_review'
  | 'physician_review'
  | 'correction_requested'
  | 'correction_review'
  | 'delivered'
  | 'paid'
  | 'rejected'
  | 'needs_rn_decision' // Gate-2 halt — RN must decide
  | 'needs_records'; // Gate-2 halt — RN chose to gather more records
export type CdsVerdict = 'accept' | 'caution' | 'reject' | 'not_yet_run';

export interface VeteranRecord {
  id: string;
  lastName: string;
  firstName: string;
  dob: Date;
  email: string;
  phone: string | null;
  address: string | null;
  branch: string | null;
  serviceStartYear: number | null;
  serviceEndYear: number | null;
  combatVeteran: YesNoUnknown | null;
  pactArea: YesNoUnknown | null;
  teraConceded: YesNoUnknown | null;
  heightIn: number | null;
  weightLb: number | null;
  inactive: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CaseSummaryRecord {
  id: string;
  claimedCondition: string;
  claimType: ClaimType;
  status: CaseStatus;
  currentVersion: number;
  updatedAt: Date;
}

export interface RelatedCount {
  _count: {
    cases: number;
  };
}

export interface VeteranDetailRecord extends VeteranRecord {
  scConditions: unknown[];
  activeProblems: unknown[];
  activeMedications: unknown[];
  cases: CaseSummaryRecord[];
}

export interface AppUserRecord {
  id: string;
  cognitoSub: string;
  email: string;
  name: string | null;
  active: boolean;
  roles: Array<{ role: string }>;
  version: number;
}

export interface ActivityCreateInput {
  actorUserId?: string;
  action: string;
  veteranId?: string;
  caseId?: string;
  detailsJson?: Record<string, unknown>;
}

export interface VeteranCreateInput {
  id: string;
  lastName: string;
  firstName: string;
  dob: Date;
  email: string;
  phone?: string;
  address?: string;
  branch?: string;
  serviceStartYear?: number;
  serviceEndYear?: number;
  combatVeteran?: YesNoUnknown;
  pactArea?: YesNoUnknown;
  teraConceded?: YesNoUnknown;
  heightIn?: number;
  weightLb?: number;
}

export interface VeteranUpdateInput {
  lastName?: string;
  firstName?: string;
  dob?: Date;
  email?: string;
  phone?: string | null;
  address?: string | null;
  branch?: string | null;
  serviceStartYear?: number;
  serviceEndYear?: number;
  combatVeteran?: YesNoUnknown;
  pactArea?: YesNoUnknown;
  teraConceded?: YesNoUnknown;
  heightIn?: number | null;
  weightLb?: number | null;
  noScConditionsConfirmed?: boolean;
  inactive?: boolean;
  version?: { increment: number };
}

export interface VeteranDelegate {
  findMany(args: unknown): Promise<Array<VeteranRecord & RelatedCount>>;
  count(args: unknown): Promise<number>;
  findUnique(args: unknown): Promise<VeteranRecord | VeteranDetailRecord | null>;
  findFirst(args: unknown): Promise<VeteranRecord | VeteranDetailRecord | null>;
  create(args: { data: VeteranCreateInput }): Promise<VeteranRecord>;
  update(args: { where: { id: string }; data: VeteranUpdateInput }): Promise<VeteranRecord>;
}

export interface AppUserDelegate {
  findUnique(args: unknown): Promise<AppUserRecord | null>;
  findMany(args: unknown): Promise<readonly AppUserRecord[]>;
  upsert(args: unknown): Promise<AppUserRecord>;
  update(args: unknown): Promise<AppUserRecord>;
}

export interface AppUserRoleDelegate {
  upsert(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<unknown>;
}

export interface ActivityLogDelegate {
  create(args: { data: ActivityCreateInput }): Promise<unknown>;
}

export interface CaseMessageRecord {
  id: string;
  caseId: string;
  senderSub: string;
  senderRole: string;
  body: string;
  readAt: Date | null;
  readBySub: string | null;
  createdAt: Date;
}

export interface CaseMessageDelegate {
  findMany(args: unknown): Promise<readonly CaseMessageRecord[]>;
  findFirst(args: unknown): Promise<CaseMessageRecord | null>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<CaseMessageRecord>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

// ── Staff messaging (NEW; distinct from the flat 2-party CaseMessage) ────────────────────────────
// Internal admin/ops_staff/physician messaging: multi-recipient, threaded (threadId), immutable, with
// a separate per-recipient read/archive state row. The flat CaseMessage model is left untouched.
export interface StaffMessageRecord {
  id: string;
  threadId: string;
  caseId: string | null;
  authorSub: string;
  subject: string | null;
  body: string;
  createdAt: Date;
}

export interface StaffMessageDelegate {
  findMany(args: unknown): Promise<readonly StaffMessageRecord[]>;
  findFirst(args: unknown): Promise<StaffMessageRecord | null>;
  findUnique(args: unknown): Promise<StaffMessageRecord | null>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<StaffMessageRecord>;
}

export interface StaffMessageRecipientRecord {
  id: string;
  threadId: string;
  recipientSub: string;
  kind: string; // 'to' | 'cc'
  addedBySub: string;
  addedAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
}

export interface StaffMessageRecipientDelegate {
  findMany(args: unknown): Promise<readonly StaffMessageRecipientRecord[]>;
  findFirst(args: unknown): Promise<StaffMessageRecipientRecord | null>;
  findUnique(args: unknown): Promise<StaffMessageRecipientRecord | null>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<StaffMessageRecipientRecord>;
  createMany(args: unknown): Promise<{ count: number }>;
  update(args: unknown): Promise<StaffMessageRecipientRecord>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

export interface StaffMessageAttachmentRecord {
  id: string;
  messageId: string | null; // null = pending (registered, not yet bound to a message)
  filename: string;
  contentType: string;
  // Prisma returns BigInt for size_bytes; typed loosely here (mirrors how Document's BigInt is handled
  // — Number(x) wherever it crosses an API boundary).
  sizeBytes: unknown;
  s3Key: string;
  uploadedBySub: string;
  createdAt: Date;
}

export interface StaffMessageAttachmentDelegate {
  findMany(args: unknown): Promise<readonly StaffMessageAttachmentRecord[]>;
  findFirst(args: unknown): Promise<StaffMessageAttachmentRecord | null>;
  findUnique(args: unknown): Promise<StaffMessageAttachmentRecord | null>;
  create(args: unknown): Promise<StaffMessageAttachmentRecord>;
  update(args: unknown): Promise<StaffMessageAttachmentRecord>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

// ── Delivery workflow: Email + Payment (additive) ───────────────────────────────────────────────
// The Prisma models already exist (emails / payments tables). These hand-written delegates expose
// the minimal surface the delivery route needs (find existing rows for idempotency + create).
export interface EmailRecord {
  id: string;
  // Feature B: nullable — chart-level email (no claim) or unmatched (no veteran either).
  caseId: string | null;
  veteranId?: string | null;
  direction: 'inbound' | 'outbound';
  subject: string;
  body: string;
  fromAddress: string;
  toAddress: string;
  mailbox?: string | null;
  messageId?: string | null;
  snippet?: string | null;
  rawS3Key?: string | null;
  attachmentsJson?: unknown;
  receivedAt?: Date | null;
  // NULL until a real transmit happens (a composed/queued stub email has no sentAt).
  sentAt: Date | null;
  // 'sent' (transmitted) | 'queued' (composed, not yet transmitted).
  status: string;
  gmailMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface EmailDelegate {
  findFirst(args: unknown): Promise<EmailRecord | null>;
  findUnique(args: unknown): Promise<EmailRecord | null>;
  findMany(args: unknown): Promise<readonly EmailRecord[]>;
  create(args: unknown): Promise<EmailRecord>;
  update(args: unknown): Promise<EmailRecord>;
  count(args: unknown): Promise<number>;
}

export interface MonitoredMailboxRecord {
  id: string;
  address: string;
  label: string | null;
  active: boolean;
  addedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface MonitoredMailboxDelegate {
  findMany(args?: unknown): Promise<readonly MonitoredMailboxRecord[]>;
  findUnique(args: unknown): Promise<MonitoredMailboxRecord | null>;
  findFirst(args: unknown): Promise<MonitoredMailboxRecord | null>;
  create(args: unknown): Promise<MonitoredMailboxRecord>;
  update(args: unknown): Promise<MonitoredMailboxRecord>;
  delete(args: unknown): Promise<MonitoredMailboxRecord>;
}

export interface DeliveryTokenRecord {
  id: string;
  caseId: string;
  token: string;
  passwordHash: string;
  letterVersion: number;
  pdfS3Key: string;
  expiresAt: Date;
  downloadCount: number;
  lastAccessedAt: Date | null;
  createdAt: Date;
}
export interface DeliveryTokenDelegate {
  findUnique(args: unknown): Promise<DeliveryTokenRecord | null>;
  findFirst(args: unknown): Promise<DeliveryTokenRecord | null>;
  create(args: unknown): Promise<DeliveryTokenRecord>;
  update(args: unknown): Promise<DeliveryTokenRecord>;
}

export interface PaymentRecord {
  id: string;
  caseId: string;
  kind: 'review_50' | 'letter_350' | 'letter_500' | 'refund' | 'correction_fee';
  amountCents: number;
  stripeChargeId: string | null;
  status: string;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface PaymentDelegate {
  findFirst(args: unknown): Promise<PaymentRecord | null>;
  findMany(args: unknown): Promise<readonly PaymentRecord[]>;
  create(args: unknown): Promise<PaymentRecord>;
}

export interface AppDbTransaction {
  veteran: VeteranDelegate;
  activityLog: ActivityLogDelegate;
  case: CaseDelegate;
  draftJob: DraftJobDelegate;
  correction: CorrectionDelegate;
  chartNote: ChartNoteDelegate;
  scCondition: ScConditionDelegate;
  activeProblem: ActiveProblemDelegate;
  activeMedication: ActiveMedicationDelegate;
  signOff: SignOffDelegate;
  clarification: ClarificationDelegate;
  fileReadStatus: FileReadStatusDelegate;
  keyDoc: KeyDocDelegate;
  doctorPack: DoctorPackDelegate;
  document: DocumentDelegate;
  documentPage: DocumentPageDelegate;
  letterRevision: LetterRevisionDelegate;
  caseMessage: CaseMessageDelegate;
  staffMessage: StaffMessageDelegate;
  staffMessageRecipient: StaffMessageRecipientDelegate;
  staffMessageAttachment: StaffMessageAttachmentDelegate;
  email: EmailDelegate;
  monitoredMailbox: MonitoredMailboxDelegate;
  deliveryToken: DeliveryTokenDelegate;
  payment: PaymentDelegate;
  intake: IntakeDelegate;
  draftDecision: DraftDecisionDelegate;
  advisoryQuery: AdvisoryQueryDelegate;
}

export interface AppDb extends AppDbTransaction {
  appUser: AppUserDelegate;
  appUserRole: AppUserRoleDelegate;
  physician: PhysicianDelegate;
  $transaction<T>(fn: (tx: AppDbTransaction) => Promise<T>, options?: { timeout?: number; maxWait?: number; isolationLevel?: unknown }): Promise<T>;
}

export interface RequestActor {
  id?: string;
  user: AuthenticatedUser;
}

// ====================== Phase 4A: Case types ======================

export interface CaseRecord {
  id: string;
  veteranId: string;
  claimedCondition: string;
  // Multi-condition clustered claim: the full set of claimed conditions (all in one body system).
  // `claimedCondition` (singular) remains the PRIMARY (RN's first pick) for display/back-compat.
  claimedConditions: readonly string[];
  claimType: ClaimType;
  // Prior-denial signals (additive, delivery workflow) — drive the cover-memo predicate.
  previouslyDenied: boolean;
  priorDenialReason: string | null;
  priorDecisionDate: Date | null;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  veteranStatement: string | null;
  inServiceEvent: string | null;
  status: CaseStatus;
  cdsVerdict: CdsVerdict;
  cdsOddsPct: number | null;
  cdsRationale: Record<string, unknown> | null;
  assignedPhysicianId: string | null;
  assignedRnId: string | null;
  refundEligible: boolean;
  currentVersion: number;
  // Feature A quick-note (scratchpad). quickNoteBy stores the editor's EMAIL (human-readable, not a uuid).
  // Optional on this facade type to match the existing loose convention (operatorState/grade/etc. are
  // likewise omitted) — the DB column always exists (nullable); the route reads via the loose delegate.
  quickNote?: string | null;
  quickNoteBy?: string | null;
  quickNoteAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CaseDelegate {
  findMany(args: unknown): Promise<readonly CaseRecord[]>;
  count(args: unknown): Promise<number>;
  findUnique(args: unknown): Promise<CaseRecord | null>;
  findFirst(args: unknown): Promise<CaseRecord | null>;
  create(args: unknown): Promise<CaseRecord>;
  update(args: unknown): Promise<CaseRecord>;
}

// DraftJobRecord covers both the original Phase 4 shape and the drafter-integration fields
// added in 20260529000000_drafter_integration_fields. All new fields are nullable — they only
// populate as the drafter pipeline advances.
export interface DraftJobRecord {
  id: string;
  caseId: string;
  version: number;
  sqsMessageId: string | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'halted';
  enqueuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  manifestSnapshot: unknown;
  currentPhase: string | null;
  nextRetryInS: number | null;
  failureClass: string | null;
  gradeSidecarJson: unknown;
  haltPayloadJson: unknown;
  artifactPdfS3Key: string | null;
  artifactTxtS3Key: string | null;
  artifactDocxS3Key: string | null;
  strategyOverride: string | null;
  parentVersion: number | null;
  workerId: string | null;
  lastHeartbeatAt: Date | null;
  bundleS3Key: string | null;
  // Per-claim drafting cost in US dollars. Prisma returns Decimal as a Prisma.Decimal object at
  // runtime; we type it loosely here (the hand-written delegates use `unknown` args) and convert
  // to a number with Number(x) wherever it crosses an API boundary.
  costUsd: unknown;
  updatedAt: Date;
}

export interface DraftJobDelegate {
  findMany(args: unknown): Promise<readonly DraftJobRecord[]>;
  findFirst(args: unknown): Promise<DraftJobRecord | null>;
  findUnique(args: unknown): Promise<DraftJobRecord | null>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<DraftJobRecord>;
  update(args: unknown): Promise<DraftJobRecord>;
}

// LetterRevision — the UNIFIED letter-version timeline (the single source of truth, alongside
// Case.currentVersion). Every version lands here: editor saves write directly; the drafter
// mirrors its completions in (source:'drafter_run'). Reads resolve the current letter via
// Case.currentVersion → the LetterRevision row at that version. See LETTER_EDITOR_BACKEND_PLAN.md.
export interface LetterRevisionRecord {
  id: string;
  caseId: string;
  version: number;
  parentVersion: number;
  source: 'drafter_run' | 'editor_save' | 'surgical_ai' | 'approved_final';
  artifactTxtS3Key: string;
  artifactPdfS3Key: string | null;
  artifactDocxS3Key: string | null;
  editedBy: string;
  editorRole: string;
  sanityJson: unknown;
  createdAt: Date;
}

export interface LetterRevisionDelegate {
  findMany(args: unknown): Promise<readonly LetterRevisionRecord[]>;
  findFirst(args: unknown): Promise<LetterRevisionRecord | null>;
  create(args: unknown): Promise<LetterRevisionRecord>;
}

export interface CorrectionDelegate {
  findMany(args: unknown): Promise<readonly unknown[]>;
}

// ====================== Phase 4B-5: Chart notes ======================

export interface ChartNoteRecord {
  id: string;
  veteranId: string;
  body: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ChartNoteDelegate {
  findMany(args: unknown): Promise<readonly ChartNoteRecord[]>;
  findFirst(args: unknown): Promise<ChartNoteRecord | null>;
  create(args: unknown): Promise<ChartNoteRecord>;
  update(args: unknown): Promise<ChartNoteRecord>;
  delete(args: unknown): Promise<ChartNoteRecord>;
}


// ====================== Phase 5: Physician types ======================

export interface PhysicianRecord {
  id: string;
  cognitoSub: string | null;
  fullName: string;
  npi: string;
  specialty: string;
  medicalLicense: string;
  email: string;
  phone: string | null;
  signatureImageS3Key: string | null;
  // Prisma Json? — render-authoritative per-signer credential facts (D2). Untrusted at this
  // boundary; narrow with credential-block.parseCredentialBlock before use.
  credentialBlockJson: unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface PhysicianDelegate {
  findUnique(args: unknown): Promise<PhysicianRecord | null>;
  findFirst(args: unknown): Promise<PhysicianRecord | null>;
  findMany(args: unknown): Promise<readonly PhysicianRecord[]>;
  create(args: unknown): Promise<PhysicianRecord>;
  update(args: unknown): Promise<PhysicianRecord>;
}

// ====================== Phase 5: ScCondition / ActiveProblem / ActiveMedication ======================

export type ScConditionStatus = 'service_connected' | 'pending' | 'denied';

export interface ScConditionRecord {
  id: string;
  veteranId: string;
  condition: string;
  dcCode: string | null;
  ratingPct: number | null;
  status: ScConditionStatus;
  grantedDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ScConditionDelegate {
  findUnique(args: unknown): Promise<ScConditionRecord | null>;
  findFirst(args: unknown): Promise<ScConditionRecord | null>;
  findMany(args: unknown): Promise<readonly ScConditionRecord[]>;
  create(args: unknown): Promise<ScConditionRecord>;
  update(args: unknown): Promise<ScConditionRecord>;
  delete(args: unknown): Promise<ScConditionRecord>;
}

export interface ActiveProblemRecord {
  id: string;
  veteranId: string;
  problem: string;
  icd10: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ActiveProblemDelegate {
  findUnique(args: unknown): Promise<ActiveProblemRecord | null>;
  findFirst(args: unknown): Promise<ActiveProblemRecord | null>;
  findMany(args: unknown): Promise<readonly ActiveProblemRecord[]>;
  create(args: unknown): Promise<ActiveProblemRecord>;
  update(args: unknown): Promise<ActiveProblemRecord>;
  delete(args: unknown): Promise<ActiveProblemRecord>;
}

export interface ActiveMedicationRecord {
  id: string;
  veteranId: string;
  drugName: string;
  dose: string | null;
  frequency: string | null;
  indication: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ActiveMedicationDelegate {
  findUnique(args: unknown): Promise<ActiveMedicationRecord | null>;
  findFirst(args: unknown): Promise<ActiveMedicationRecord | null>;
  findMany(args: unknown): Promise<readonly ActiveMedicationRecord[]>;
  create(args: unknown): Promise<ActiveMedicationRecord>;
  update(args: unknown): Promise<ActiveMedicationRecord>;
  delete(args: unknown): Promise<ActiveMedicationRecord>;
}

// ====================== Phase 5: SignOff ======================

export interface SignOffRecord {
  id: string;
  caseId: string;
  physicianId: string;
  signedAt: Date;
  answersJson: Record<string, unknown>;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  // Byte-binding (#9 Fix 3): the version signed + the sha256 of that version's TXT bytes.
  // Nullable — sign-offs created before the columns existed carry null (the delivery gate
  // skips the byte check when null, preserving back-compat).
  signedVersion: number | null;
  signedContentSha256: string | null;
}

export interface SignOffDelegate {
  findUnique(args: unknown): Promise<SignOffRecord | null>;
  findFirst(args: unknown): Promise<SignOffRecord | null>;
  findMany(args: unknown): Promise<readonly SignOffRecord[]>;
  create(args: unknown): Promise<SignOffRecord>;
}

// ====================== Phase 5: Clarification queue ======================

export type ClarificationAudience = 'physician' | 'ops_staff' | 'veteran';
export type ClarificationStatus = 'open' | 'resolved' | 'dismissed';

export interface ClarificationRecord {
  id: string;
  caseId: string;
  raisedBy: string;
  audience: ClarificationAudience;
  question: string;
  status: ClarificationStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ClarificationDelegate {
  findUnique(args: unknown): Promise<ClarificationRecord | null>;
  findFirst(args: unknown): Promise<ClarificationRecord | null>;
  findMany(args: unknown): Promise<readonly ClarificationRecord[]>;
  create(args: unknown): Promise<ClarificationRecord>;
  update(args: unknown): Promise<ClarificationRecord>;
}

// ====================== Phase 5.2: FileReadStatus ======================

export type FileTerminalStatus = 'read' | 'manual_summary_required' | 'manual_summary_provided';

/**
 * Read-attempt method. Compact-EMR INGEST_OCR_SPEC (2026-05-25, FRN-window-authored) HARD
 * REQUIREMENT #1: raw OCR/text extraction MUST go through Textract or Bedrock Data Automation,
 * never an LLM. `claude_vision` is retained as a transition value (the legacy FRN pipeline used
 * it) but is DEPRECATED — workers SHOULD post extractions via 'textract' or
 * 'bedrock_data_automation' going forward.
 */
export type FileReadMethod =
  | 'native_pdf_text'
  | 'tesseract_ocr'
  | 'textract'
  | 'bedrock_data_automation'
  | 'claude_vision';

export interface FileReadAttempt {
  readonly method: FileReadMethod;
  readonly wordCount: number;
  readonly corruptedTokenRatio: number;
  readonly attemptedAt: string;
  readonly note: string | null;
}

export interface FileReadStatusRecord {
  id: string;
  caseId: string;
  filePath: string;
  fileSha256: string;
  terminalStatus: FileTerminalStatus;
  attemptsJson: readonly FileReadAttempt[];
  manualSummary: string | null;
  manualSummaryAt: Date | null;
  manualSummaryBy: string | null;
  lastCheckedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface FileReadStatusDelegate {
  findUnique(args: unknown): Promise<FileReadStatusRecord | null>;
  findFirst(args: unknown): Promise<FileReadStatusRecord | null>;
  findMany(args: unknown): Promise<readonly FileReadStatusRecord[]>;
  create(args: unknown): Promise<FileReadStatusRecord>;
  update(args: unknown): Promise<FileReadStatusRecord>;
  upsert(args: unknown): Promise<FileReadStatusRecord>;
}

// ====================== Phase 7B: KeyDoc + DoctorPack ======================

export type KeyDocClassification = 'high_signal' | 'bulk' | 'normal';

export type KeyDocType =
  | 'dd_214'
  | 'rating_decision'
  | 'denial_letter'
  | 'supplemental_decision'
  | 'rated_disabilities_view'
  | 'benefit_summary'
  | 'dbq'
  | 'c_and_p_exam'
  | 'tera_memo'
  | 'individual_exposure_summary'
  | 'nexus_letter_prior'
  | 'medical_opinion'
  | 'audiogram'
  | 'sleep_study'
  | 'pulmonary_function_test'
  | 'service_treatment_record_summary'
  | 'separation_exam'
  | 'entrance_exam'
  | 'personnel_record'
  | 'statement_in_support'
  | 'lay_statement'
  | 'buddy_statement'
  | 'blue_button'
  | 'progress_notes'
  | 'unspecified';

export interface KeyDocPageRange {
  readonly from: number;
  readonly to: number;
}

export interface KeyDocRecord {
  id: string;
  caseId: string;
  filePath: string;
  fileSha256: string;
  classification: KeyDocClassification;
  docType: KeyDocType;
  importance: number;
  pageRanges: readonly KeyDocPageRange[];
  notes: string | null;
  physicianIncludeAllPages: boolean;
  needsRnReview: boolean;
  selectorVersion: string | null;
  selectorRationale: string | null;
  selectorAcknowledgedAt: Date | null;
  selectorAcknowledgedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

// Minimal view of the chart's uploaded documents — used to reconcile the readiness gate against files the
// chart actually has (chart-readiness route). Only s3Key is needed here.
export interface DocumentRecord {
  s3Key: string;
}
export interface DocumentDelegate {
  findMany(args: unknown): Promise<readonly DocumentRecord[]>;
}

export interface KeyDocDelegate {
  findUnique(args: unknown): Promise<KeyDocRecord | null>;
  findFirst(args: unknown): Promise<KeyDocRecord | null>;
  findMany(args: unknown): Promise<readonly KeyDocRecord[]>;
  create(args: unknown): Promise<KeyDocRecord>;
  update(args: unknown): Promise<KeyDocRecord>;
  upsert(args: unknown): Promise<KeyDocRecord>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}

export type DoctorPackState = 'queued' | 'generating' | 'ready' | 'failed';

export interface DoctorPackManifestEntry {
  readonly filePath: string;
  readonly docType: KeyDocType;
  readonly classification: KeyDocClassification;
  readonly pageRanges: readonly KeyDocPageRange[];
  readonly pageCount: number;
}

export interface DoctorPackRecord {
  id: string;
  caseId: string;
  caseVersion: number;
  state: DoctorPackState;
  pdfS3Key: string | null;
  pageCount: number | null;
  keyDocCount: number | null;
  // manifestJson optionally carries a coverPage block (chart-summary snapshot the assembler
  // renders as PDF page 1) — Phase 7B-revised Build 1.
  manifestJson: { entries: readonly DoctorPackManifestEntry[]; engineVersion: string; coverPage?: unknown } | null;
  errorMessage: string | null;
  generatedAt: Date | null;
  generatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface DoctorPackDelegate {
  findUnique(args: unknown): Promise<DoctorPackRecord | null>;
  findFirst(args: unknown): Promise<DoctorPackRecord | null>;
  findMany(args: unknown): Promise<readonly DoctorPackRecord[]>;
  create(args: unknown): Promise<DoctorPackRecord>;
  update(args: unknown): Promise<DoctorPackRecord>;
}

// Jotform intake pool (staging). See docs/JOTFORM_INTAKE_INGESTION_SPEC.md.
export interface IntakeRecord {
  id: string;
  jotformFormId: string;
  jotformSubmissionId: string;
  status: string; // pending | ready | assigned | dismissed | failed
  submittedName: string | null;
  submittedEmail: string | null;
  submittedPhone: string | null;
  submittedState: string | null;
  submittedCondition: string | null;
  rawAnswersJson: unknown | null;
  fileManifestJson: unknown | null;
  submittedAt: Date | null;
  webhookReceivedAt: Date;
  assignedVeteranId: string | null;
  assignedCaseId: string | null;
  assignedAt: Date | null;
  assignedBy: string | null;
  dismissedReason: string | null;
  retryCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntakeDelegate {
  findUnique(args: unknown): Promise<IntakeRecord | null>;
  findFirst(args: unknown): Promise<IntakeRecord | null>;
  findMany(args: unknown): Promise<readonly IntakeRecord[]>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<IntakeRecord>;
  update(args: unknown): Promise<IntakeRecord>;
}

// Gate-1/Gate-2 decision log (project_compact_emr_gate2_emr_half).
export interface DraftDecisionRecord {
  id: string;
  caseId: string;
  draftAttempt: number;
  gate: number;
  item: string;
  decision: string;
  reason: string | null;
  rnUser: string;
  createdAt: Date;
}

export interface DraftDecisionDelegate {
  findMany(args: unknown): Promise<readonly DraftDecisionRecord[]>;
  create(args: unknown): Promise<DraftDecisionRecord>;
  createMany(args: unknown): Promise<{ count: number }>;
  count(args: unknown): Promise<number>;
}

// Advisory "Ask AI" oversight + cost log (advisory_queries).
export interface AdvisoryQueryRecord {
  id: string;
  caseId: string | null;
  veteranId: string | null;
  userId: string;
  userRole: string;
  view: string;
  question: string;
  status: string;
  modeRan: string[];
  citationsJson: unknown;
  coverageGap: unknown;
  costUsd: unknown;
  answerChars: number | null;
  answer: string | null;
  createdAt: Date;
}
export interface AdvisoryQueryDelegate {
  create(args: unknown): Promise<AdvisoryQueryRecord>;
  findMany(args?: unknown): Promise<readonly AdvisoryQueryRecord[]>;
  count(args?: unknown): Promise<number>;
}

// ====================== Phase 7B-revised Build 1: DocumentPage ======================

export interface DocumentPageRecord {
  id: string;
  documentId: string;
  pageNumber: number;
  text: string;
  confidence: number | null;
  extractedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentPageDelegate {
  findMany(args: unknown): Promise<readonly DocumentPageRecord[]>;
  findFirst(args: unknown): Promise<DocumentPageRecord | null>;
  create(args: unknown): Promise<DocumentPageRecord>;
  upsert(args: unknown): Promise<DocumentPageRecord>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}
