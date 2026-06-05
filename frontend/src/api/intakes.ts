import { apiGet, apiPost } from './client';

export interface IntakeFile {
  readonly name?: string;
  readonly s3Key?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewUrl?: string;
}
export interface IntakeListItem {
  readonly id: string;
  readonly jotformFormId: string;
  readonly jotformSubmissionId: string;
  readonly status: string; // pending | ready | assigned | dismissed | failed
  readonly submittedName: string | null;
  readonly submittedEmail: string | null;
  readonly submittedPhone: string | null;
  readonly submittedState: string | null;
  readonly submittedCondition: string | null;
  readonly fileManifestJson: readonly IntakeFile[] | null;
  readonly retryCount: number;
  readonly errorMessage: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}
export interface IntakeDetail extends IntakeListItem {
  readonly files: readonly IntakeFile[];
}

export async function listIntakes(params: { status?: string; q?: string }): Promise<{ data: readonly IntakeListItem[] }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q && params.q.trim().length > 0) qs.set('q', params.q.trim());
  return apiGet(`/api/v1/intakes${qs.toString() ? `?${qs.toString()}` : ''}`);
}

export async function getIntake(id: string): Promise<{ data: IntakeDetail }> {
  return apiGet(`/api/v1/intakes/${encodeURIComponent(id)}`);
}

export interface NewVeteranInput {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dob: string;
  readonly email: string;
  readonly phone?: string;
  readonly state?: string;
}
export interface NewCaseInput {
  readonly id: string;
  readonly claimedCondition: string;
  readonly claimType: string;
}
export interface AssignIntakeInput {
  readonly veteranId?: string;
  readonly newVeteran?: NewVeteranInput;
  readonly caseId?: string;
  readonly newCase?: NewCaseInput;
  readonly fileS3Keys?: readonly string[];
}
export interface AssignResult {
  readonly veteranId: string;
  readonly caseId: string;
  readonly assigned: boolean;
  readonly attached: readonly { name: string; s3Key: string }[];
  readonly failed: readonly { name?: string; reason: string }[];
}
export async function assignIntake(id: string, input: AssignIntakeInput): Promise<{ data: AssignResult }> {
  return apiPost(`/api/v1/intakes/${encodeURIComponent(id)}/assign`, input);
}

export async function dismissIntake(id: string, reason: string): Promise<{ data: unknown }> {
  return apiPost(`/api/v1/intakes/${encodeURIComponent(id)}/dismiss`, { reason });
}
export async function retryIntake(id: string): Promise<{ data: unknown }> {
  return apiPost(`/api/v1/intakes/${encodeURIComponent(id)}/retry`, {});
}

// Form-type awareness (spec §6b). Known Jotform form IDs → how the assign should default.
const MAIN_INTAKE_FORM = '260898029223159'; // Stage 1: new veteran + initial claim
const ADDITIONAL_DOCS_FORM = '260804641700146'; // existing veteran + existing claim + re-run prompt
export type IntakeKind = 'stage1' | 'additional_docs' | 'stage2';
export function intakeKind(formId: string): IntakeKind {
  if (formId === MAIN_INTAKE_FORM) return 'stage1';
  if (formId === ADDITIONAL_DOCS_FORM) return 'additional_docs';
  return 'stage2'; // the 28 condition forms (and anything else): match veteran + new claim
}
