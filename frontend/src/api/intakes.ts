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
  readonly submittedDob: string | null; // ISO YYYY-MM-DD (worker-normalized)
  readonly submittedClaimType: string | null; // initial|supplemental|hlr|appeal
  readonly submittedFormTitle: string | null; // real Jotform form title
  readonly fileManifestJson: readonly IntakeFile[] | null;
  readonly retryCount: number;
  readonly errorMessage: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly veteranMatch: { readonly id: string; readonly name: string } | null; // existing profile for this email
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
export type IntakeKind = 'stage1' | 'additional_docs' | 'stage2';
// Known form IDs (verified live against the Jotform account 2026-06-04). A new-veteran intake (main +
// returning) defaults to create-new veteran + new claim; the additional-docs form to existing+existing;
// the condition forms to match-veteran + new claim.
const KNOWN_FORMS: Record<string, IntakeKind> = {
  '260898029223159': 'stage1',        // Main Stage-1 intake (new veteran + initial claim)
  '261495407772061': 'stage1',        // Returning-client intake (new veteran/claim in a fresh EMR)
  '260804641700146': 'additional_docs', // Additional Records upload (existing veteran + existing claim)
  '261483559233058': 'stage2',        // Stage-2 condition form (carries Stage-1 demographics)
};
// Prefer the real form TITLE (robust to unknown/cloned form IDs), then the known-ID map, then default.
// This is why a Stage-1 submission no longer mislabels as "Stage 2".
export function intakeKind(formId: string, formTitle?: string | null): IntakeKind {
  const t = (formTitle ?? '').toLowerCase();
  if (/additional|more record|supporting doc|upload (more|additional)/.test(t)) return 'additional_docs';
  if (/stage\s*1|new (client|patient|veteran)|initial intake|get started|returning/.test(t)) return 'stage1';
  if (/stage\s*2/.test(t)) return 'stage2';
  if (KNOWN_FORMS[formId]) return KNOWN_FORMS[formId]!;
  return 'stage2'; // unknown condition forms: match veteran + new claim
}
