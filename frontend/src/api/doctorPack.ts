import { apiGet, apiPost } from './client';

// Chunk D (2026-06-11): Doctor Pack API client — the backend routes existed since Phase 7B but
// had NO frontend consumer (the "worked on 10 times, never surfaced" item).

export type DoctorPackState = 'queued' | 'generating' | 'ready' | 'failed';

export interface DoctorPack {
  readonly id: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly state: DoctorPackState;
  readonly pdfS3Key: string | null;
  readonly pageCount: number | null;
  readonly keyDocCount: number | null;
  readonly errorMessage: string | null;
  readonly generatedAt: string | null;
  readonly generatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KeyDocPageRange {
  readonly from: number;
  readonly to: number;
}

export interface KeyDoc {
  readonly id: string;
  readonly caseId: string;
  readonly filePath: string;
  readonly classification: 'high_signal' | 'bulk' | 'normal';
  readonly docType: string;
  readonly importance: number;
  readonly pageRanges: readonly KeyDocPageRange[];
  readonly needsRnReview: boolean;
  readonly selectorRationale: string | null;
  // Chunk D enrichment: the source Document's total pages + original filename (joined on s3Key)
  // so the panel can render `Misc_3.pdf · 3 of 25 pages`. Null when the join found no Document.
  readonly docPageCount: number | null;
  readonly filename: string | null;
}

export async function getLatestDoctorPack(caseId: string): Promise<{ data: DoctorPack | null }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/doctor-pack/latest`);
}

export async function listKeyDocs(caseId: string): Promise<{ data: readonly KeyDoc[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/key-docs`);
}

export async function generateDoctorPack(caseId: string): Promise<{ data: DoctorPack }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/doctor-pack/generate`, {});
}

export interface DoctorPackPdfUrlResult {
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export async function getDoctorPackPdfUrl(caseId: string, packId: string): Promise<{ data: DoctorPackPdfUrlResult }> {
  return apiGet(
    `/api/v1/cases/${encodeURIComponent(caseId)}/doctor-pack/${encodeURIComponent(packId)}/pdf-url`,
  );
}
