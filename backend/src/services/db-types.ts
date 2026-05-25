import type { AuthenticatedUser } from '../auth/roles.js';

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
}

export interface AppDb extends AppDbTransaction {
  appUser: AppUserDelegate;
  $transaction<T>(fn: (tx: AppDbTransaction) => Promise<T>): Promise<T>;
}

export interface RequestActor {
  id?: string;
  user: AuthenticatedUser;
}
