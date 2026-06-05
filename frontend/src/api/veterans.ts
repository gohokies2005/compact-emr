import axios from 'axios';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';
import type { ActiveMedication, ActiveProblem, Case, Document, ScCondition, ScConditionStatus, Veteran, YesNoUnknown } from '../types/prisma';

export interface Envelope<T> { readonly data: T; }
export interface Paginated<T> { readonly data: readonly T[]; readonly nextCursor?: string; }
// The list endpoint returns `activeCases` (the veteran's case count); `updatedAt` rides on the base
// Veteran. (Was `caseCount`/`lastActivity` — names that never matched the API, so the Veterans page
// rendered 0 / "—" for every row. 2026-06-03.)
export interface VeteranListItem extends Veteran { readonly activeCases?: number; }
export interface VeteranDetail extends Veteran {
  readonly scConditions: readonly ScCondition[];
  readonly activeProblems: readonly ActiveProblem[];
  readonly activeMedications: readonly ActiveMedication[];
  readonly cases: readonly Case[];
}

export interface CreateVeteranInput {
  readonly id: string; readonly firstName: string; readonly lastName: string; readonly dob: string; readonly email: string;
  readonly phone?: string; readonly address?: string; readonly branch?: string; readonly serviceStartYear?: number; readonly serviceEndYear?: number;
  readonly combatVeteran?: YesNoUnknown; readonly pactArea?: YesNoUnknown; readonly teraConceded?: YesNoUnknown; readonly heightIn?: number; readonly weightLb?: number;
}
export type UpdateVeteranInput = Partial<Omit<CreateVeteranInput, 'id'>> & { readonly version: number };

export async function listVeterans(q: string): Promise<Paginated<VeteranListItem>> {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  return apiGet<Paginated<VeteranListItem>>(`/api/v1/veterans${params.toString() ? `?${params.toString()}` : ''}`);
}
export async function createVeteran(input: CreateVeteranInput): Promise<Envelope<Veteran>> { return apiPost('/api/v1/veterans', input); }
export async function getVeteran(id: string): Promise<Envelope<VeteranDetail>> { return apiGet(`/api/v1/veterans/${encodeURIComponent(id)}`); }
export async function updateVeteran(id: string, input: UpdateVeteranInput): Promise<Envelope<Veteran>> { return apiPatch(`/api/v1/veterans/${encodeURIComponent(id)}`, input); }

export async function addScCondition(veteranId: string, body: { condition: string; dcCode?: string; ratingPct?: number; status?: ScConditionStatus; grantedDate?: string }): Promise<Envelope<ScCondition>> { return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/conditions`, body); }
export async function updateScCondition(id: string, body: Partial<{ condition: string; dcCode: string; ratingPct: number; status: ScConditionStatus; grantedDate: string }> & { version: number }): Promise<Envelope<ScCondition>> { return apiPatch(`/api/v1/conditions/${encodeURIComponent(id)}`, body); }
export async function deleteScCondition(id: string): Promise<void> { return apiDelete(`/api/v1/conditions/${encodeURIComponent(id)}`); }

export async function addProblem(veteranId: string, body: { problem: string; notes?: string }): Promise<Envelope<ActiveProblem>> { return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/problems`, body); }
export async function updateProblem(id: string, body: Partial<{ problem: string; notes: string }> & { version: number }): Promise<Envelope<ActiveProblem>> { return apiPatch(`/api/v1/problems/${encodeURIComponent(id)}`, body); }
export async function deleteProblem(id: string): Promise<void> { return apiDelete(`/api/v1/problems/${encodeURIComponent(id)}`); }

export async function addMedication(veteranId: string, body: { drugName: string; dose?: string; frequency?: string; indication?: string }): Promise<Envelope<ActiveMedication>> { return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/medications`, body); }
export async function updateMedication(id: string, body: Partial<{ drugName: string; dose: string; frequency: string; indication: string }> & { version: number }): Promise<Envelope<ActiveMedication>> { return apiPatch(`/api/v1/medications/${encodeURIComponent(id)}`, body); }
export async function deleteMedication(id: string): Promise<void> { return apiDelete(`/api/v1/medications/${encodeURIComponent(id)}`); }

export interface PresignDocumentInput { readonly caseId: string; readonly filename: string; readonly sizeBytes: number; readonly contentType: string; }
export interface PresignDocumentResponse { readonly uploadUrl: string; readonly s3Key: string; readonly expiresInSeconds: number; readonly requiredHeaders: Record<string, string>; }
export async function listDocuments(veteranId: string): Promise<Envelope<readonly Document[]>> { return apiGet(`/api/v1/veterans/${encodeURIComponent(veteranId)}/documents`); }
export async function presignDocument(veteranId: string, body: PresignDocumentInput): Promise<Envelope<PresignDocumentResponse>> { return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/documents/presign`, body); }
export async function recordDocument(veteranId: string, body: PresignDocumentInput & { readonly s3Key: string; readonly docTag?: string }): Promise<Envelope<Document>> { return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/documents`, body); }
export async function downloadDocument(id: string): Promise<Envelope<{ downloadUrl: string }>> { return apiGet(`/api/v1/documents/${encodeURIComponent(id)}/download`); }
// Inline (in-page viewer) presign — disposition=inline so the browser renders it, not downloads.
export async function viewDocument(id: string): Promise<Envelope<{ downloadUrl: string }>> { return apiGet(`/api/v1/documents/${encodeURIComponent(id)}/download?disposition=inline`); }
// Re-run OCR on a file (re-fires Textract → Claude fallback) — clears a "needs review" stuck file.
export async function reocrDocument(id: string): Promise<Envelope<{ ok: boolean }>> { return apiPost(`/api/v1/documents/${encodeURIComponent(id)}/reocr`, {}); }
// Delete a misuploaded file (admin/ops_staff). Removes the S3 object + the document, its OCR pages,
// and its read-status/key-doc rows so it fully disappears from the veteran-wide drafter bundle.
export async function deleteDocument(id: string): Promise<void> { return apiDelete(`/api/v1/documents/${encodeURIComponent(id)}`); }
export async function uploadToPresignedUrl(url: string, file: File, headers: Record<string, string>): Promise<void> { await axios.put(url, file, { headers }); }
