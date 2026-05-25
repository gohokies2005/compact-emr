import type { AuthenticatedUser } from '../auth/roles.js';

export type Role = 'admin' | 'ops_staff' | 'physician';

export type YesNoUnknown = 'yes' | 'no' | 'unknown';
export type ClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
export type CaseStatus =
  | 'intake'
  | 'records'
  | 'viability'
  | 'drafting'
  | 'physician_review'
  | 'correction_requested'
  | 'correction_review'
  | 'delivered'
  | 'paid'
  | 'rejected';
export type CdsVerdict = 'accept' | 'caution' | 'reject' | 'not_yet_run';

export interface VeteranRecord {
  id: string;
  lastName: string;
  firstName: string;
  dob: Date;
  email: string;
  phone: string | null;
  address: string | null;
  branch: string;
  serviceStartYear: number;
  serviceEndYear: number;
  combatVeteran: YesNoUnknown;
  pactArea: YesNoUnknown;
  teraConceded: YesNoUnknown;
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
  roles: Array<{ role: string }>;
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
  branch: string;
  serviceStartYear: number;
  serviceEndYear: number;
  combatVeteran: YesNoUnknown;
  pactArea: YesNoUnknown;
  teraConceded: YesNoUnknown;
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
  branch?: string;
  serviceStartYear?: number;
  serviceEndYear?: number;
  combatVeteran?: YesNoUnknown;
  pactArea?: YesNoUnknown;
  teraConceded?: YesNoUnknown;
  heightIn?: number | null;
  weightLb?: number | null;
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
}

export interface ActivityLogDelegate {
  create(args: { data: ActivityCreateInput }): Promise<unknown>;
}

export interface AppDbTransaction {
  veteran: VeteranDelegate;
  activityLog: ActivityLogDelegate;
  case: CaseDelegate;
  draftJob: DraftJobDelegate;
  correction: CorrectionDelegate;
  chartNote: ChartNoteDelegate;
  activeProblem: ActiveProblemDelegate;
  activeMedication: ActiveMedicationDelegate;
}

export interface AppDb extends AppDbTransaction {
  appUser: AppUserDelegate;
  physician: PhysicianDelegate;
  $transaction<T>(fn: (tx: AppDbTransaction) => Promise<T>): Promise<T>;
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
  claimType: ClaimType;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  veteranStatement: string | null;
  inServiceEvent: string | null;
  status: CaseStatus;
  cdsVerdict: CdsVerdict;
  cdsOddsPct: number | null;
  cdsRationale: Record<string, unknown> | null;
  assignedPhysicianId: string | null;
  refundEligible: boolean;
  currentVersion: number;
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

export interface DraftJobDelegate {
  findMany(args: unknown): Promise<readonly unknown[]>;
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

// ====================== Phase 5: ActiveProblem / ActiveMedication ======================

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
