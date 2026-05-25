export type YesNoUnknown = 'yes' | 'no' | 'unknown';
export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
export type CaseStatus = 'intake' | 'records' | 'viability' | 'drafting' | 'physician_review' | 'correction_requested' | 'correction_review' | 'delivered' | 'paid' | 'rejected';
export type CdsVerdict = 'accept' | 'caution' | 'reject' | 'not_yet_run';
export type DraftJobState = 'queued' | 'running' | 'done' | 'failed';
export type CorrectionReason = 'veteran_added_info' | 'physician_caught_error' | 'ops_caught_error' | 'va_examiner_feedback' | 'other';
export type BillingTier = 'free_first' | 'free_our_fault' | 'paid_50';
export type PhysicianActivity = 'letter_review' | 'correction_review';
export type EmailDirection = 'inbound' | 'outbound';
export type PaymentKind = 'review_50' | 'letter_350' | 'refund' | 'correction_fee';
export type Role = 'admin' | 'physician' | 'ops_staff';

export interface VersionedRecord { readonly updatedAt: string; readonly version: number; }
export interface AppUser extends VersionedRecord { readonly id: string; readonly cognitoSub: string; readonly email: string; readonly createdAt: string; readonly roles?: readonly AppUserRole[]; }
export interface CognitoGroup { readonly name: Role; readonly createdAt: string; }
export interface AppUserRole { readonly userId: string; readonly role: Role; }
export interface Veteran extends VersionedRecord { readonly id: string; readonly lastName: string; readonly firstName: string; readonly dob: string; readonly email: string; readonly phone?: string; readonly address?: string; readonly branch: string; readonly serviceStartYear: number; readonly serviceEndYear: number; readonly combatVeteran: YesNoUnknown; readonly pactArea: YesNoUnknown; readonly teraConceded: YesNoUnknown; readonly heightIn?: number; readonly weightLb?: number; readonly createdAt: string; }
export interface ScCondition extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly condition: string; readonly dcCode?: string; readonly ratingPct?: number; readonly grantedDate?: string; readonly createdAt: string; }
export interface ActiveProblem extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly problem: string; readonly notes?: string; readonly createdAt: string; }
export interface ActiveMedication extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly drugName: string; readonly dose?: string; readonly frequency?: string; readonly indication?: string; readonly createdAt: string; }
export interface Case extends VersionedRecord { readonly id: string; readonly veteranId: string; readonly claimedCondition: string; readonly claimType: ClaimType; readonly framingChoice?: string; readonly upstreamScCondition?: string; readonly veteranStatement?: string; readonly inServiceEvent?: string; readonly status: CaseStatus; readonly cdsVerdict: CdsVerdict; readonly cdsOddsPct?: number; readonly cdsRationale?: Record<string, unknown>; readonly assignedPhysicianId?: string; readonly refundEligible: boolean; readonly currentVersion: number; readonly createdAt: string; }
export interface Document extends VersionedRecord { readonly id: string; readonly caseId: string; readonly filename: string; readonly sizeBytes: string; readonly contentType: string; readonly docTag?: string; readonly s3Key: string; readonly uploadedAt: string; readonly uploadedBy: string; }
export interface DraftJob { readonly id: string; readonly caseId: string; readonly version: number; readonly sqsMessageId?: string; readonly state: DraftJobState; readonly enqueuedAt: string; readonly startedAt?: string; readonly completedAt?: string; readonly errorMessage?: string; readonly updatedAt: string; }
export interface Correction extends VersionedRecord { readonly id: string; readonly caseId: string; readonly fromVersion: number; readonly toVersion?: number; readonly correctionReason: CorrectionReason; readonly correctionNote: string; readonly affectsSections: readonly unknown[]; readonly billingTier: BillingTier; readonly requestedBy: string; readonly requestedAt: string; readonly approvedBy?: string; readonly approvedAt?: string; }
export interface Physician extends VersionedRecord { readonly id: string; readonly fullName: string; readonly npi: string; readonly specialty: string; readonly medicalLicense: string; readonly email: string; readonly phone?: string; readonly signatureImageS3Key?: string; readonly active: boolean; readonly createdAt: string; }
export interface PhysicianCompensation extends VersionedRecord { readonly id: string; readonly physicianId: string; readonly caseId: string; readonly activity: PhysicianActivity; readonly amountCents: number; readonly accruedAt: string; readonly paidAt?: string; readonly payrollBatchId?: string; }
export interface Email extends VersionedRecord { readonly id: string; readonly caseId: string; readonly direction: EmailDirection; readonly subject: string; readonly body: string; readonly fromAddress: string; readonly toAddress: string; readonly sentAt: string; readonly gmailMessageId?: string; readonly createdAt: string; }
export interface ActivityLog { readonly id: string; readonly caseId?: string; readonly veteranId?: string; readonly actorUserId?: string; readonly action: string; readonly detailsJson?: Record<string, unknown>; readonly ts: string; }
export interface Payment extends VersionedRecord { readonly id: string; readonly caseId: string; readonly kind: PaymentKind; readonly amountCents: number; readonly stripeChargeId?: string; readonly status: string; readonly settledAt?: string; readonly createdAt: string; }
