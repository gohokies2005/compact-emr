import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Mirrors the backend delivery route (routes/delivery.ts). The delivery preview is composed
// server-side from the finalized letter TXT (§VII+§VIII excerpt), the fixed delivery email, the
// cover-memo text (when an appeal), and the Stripe/email-transport config flags. Both external
// sends are STUBBED — send composes + persists and reports what's configured.

export type CoverMemoPathway =
  | 'supplemental'
  | 'tdiu'
  | 'hlr_request'
  | 'board_appeal'
  | 'continuance';

export interface DeliveryExcerpt {
  readonly opinion: string | null;
  readonly references: readonly string[];
  readonly block: string | null;
}

export interface DeliveryEmailPreview {
  readonly subject: string;
  readonly fromAddress: string;
  readonly body: string;
}

export interface DeliveryMemoPreview {
  readonly applies: boolean;
  readonly pathway: CoverMemoPathway | null;
  readonly reason: string;
  readonly text: string | null;
  // Cover-memo staff controls (Dr. Kasky 2026-06-26): suppressed = staff chose to send only the letter;
  // textOverridden = a staff-edited memo body is in effect. Older payloads omit these → treated as false.
  readonly suppressed?: boolean;
  readonly textOverridden?: boolean;
}

export interface CoverMemoStateResult {
  readonly applies: boolean;
  readonly pathway: CoverMemoPathway | null;
  readonly reason: string;
  readonly text: string | null;
  readonly suppressed: boolean;
}

export interface DeliverySavedEmail {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  // null until a real transmit happens (a composed/queued stub email has no sentAt).
  readonly sentAt: string | null;
  // 'queued' = composed, not yet transmitted; 'sent' = actually transmitted.
  readonly status: string;
}

export interface DeliverySavedPayment {
  readonly id: string;
  readonly kind: string;
  readonly amountCents: number;
  readonly status: string;
}

export interface DeliveryPreview {
  readonly version: number;
  readonly excerpt: DeliveryExcerpt;
  readonly email: DeliveryEmailPreview;
  readonly memo: DeliveryMemoPreview;
  readonly stripe: { readonly configured: boolean; readonly link: string | null };
  readonly emailTransport: { readonly configured: boolean };
  readonly savedEmail: DeliverySavedEmail | null;
  // #198 (delivery scare, 2026-06-30): true when savedEmail.body was composed against an EARLIER
  // letter version (its frozen excerpt no longer matches the current letter). The panel refreshes
  // the editor to email.body (the current letter) instead of prefilling the stale saved body.
  // Optional for back-compat with older payloads (treated as false when absent).
  readonly savedEmailStale?: boolean;
  readonly savedPayment: DeliverySavedPayment | null;
  readonly status: string;
}

export interface DeliverySendResult {
  readonly emailId: string;
  readonly paymentId: string;
  readonly status: string;
  readonly emailTransportConfigured: boolean;
  readonly stripeConfigured: boolean;
  // true when SES actually transmitted (or the row was already sent — never re-transmitted).
  readonly emailSent: boolean;
  // 'queued' = composed, not transmitted; 'sent' = a real SES transmit happened.
  readonly emailStatus: string;
  // SES message id on a successful transmit.
  readonly messageId?: string;
  // Set when SES-sandbox forwarding fired: the email went to the staff inbox for manual
  // forwarding to this (the real) recipient.
  readonly redirectedFrom?: string;
  // The REAL transport error, verbatim, when the send failed (row stays queued).
  readonly error?: string;
  readonly message: string;
}

function deliveryPath(caseId: string, suffix = ''): string {
  return `/api/v1/cases/${encodeURIComponent(caseId)}/delivery${suffix}`;
}

export function getDelivery(caseId: string): Promise<{ data: DeliveryPreview }> {
  return apiGet<{ data: DeliveryPreview }>(deliveryPath(caseId));
}

export function sendDelivery(
  caseId: string,
  // resend (Ryan 2026-06-12): re-transmit an already-sent delivery email (lost / spam-foldered)
  // without creating a second $500 invoice. Omitted/false on the first send.
  input: { emailBody: string; resend?: boolean },
): Promise<{ data: DeliverySendResult }> {
  return apiPost<{ data: DeliverySendResult }, typeof input>(deliveryPath(caseId, '/send'), input);
}

// Cover-memo staff controls (Dr. Kasky 2026-06-26, Spring). Suppress = send ONLY the nexus letter;
// edit = a staff-written memo body; clear = revert to the auto-composed memo. Each returns the
// recomposed memo state so the panel updates without a full refetch.
export function suppressCoverMemo(caseId: string, suppressed: boolean): Promise<{ data: CoverMemoStateResult }> {
  return apiPost<{ data: CoverMemoStateResult }, { suppressed: boolean }>(deliveryPath(caseId, '/cover-memo/suppress'), { suppressed });
}
export function editCoverMemo(caseId: string, text: string): Promise<{ data: CoverMemoStateResult }> {
  return apiPut<{ data: CoverMemoStateResult }, { text: string }>(deliveryPath(caseId, '/cover-memo'), { text });
}
export function clearCoverMemoOverride(caseId: string): Promise<void> {
  // apiDelete returns void; the caller refetches the delivery preview to pick up the reverted memo.
  return apiDelete(deliveryPath(caseId, '/cover-memo'));
}

/**
 * Open the cover memo as a PDF in a new tab (E4). MIRRORS the letter-verify path
 * (CaseDetailPage.openLetterPdf): the authenticated API GET returns a short-lived PRESIGNED S3 URL
 * (not the raw bytes), and the browser opens that URL straight from S3. This avoids streaming
 * binary back through the API Lambda — API Gateway (serverless-http, binary:false) corrupts a raw
 * application/pdf body, which is what produced "Failed to load PDF document". The token rides the
 * apiClient interceptor on the JSON GET; the presigned URL needs no token. Throws on failure so the
 * caller can surface the REAL error.
 */
export async function openMemoPdf(caseId: string): Promise<void> {
  const { data } = await apiGet<{ data: { url: string } }>(deliveryPath(caseId, '/memo.pdf'));
  window.open(data.url, '_blank', 'noopener,noreferrer');
}

// Staff reset of a locked delivery link (5 failed identity attempts → lockedAt set). Clears
// lockedAt + failedAttempts on the case's delivery token(s); the SAME emailed link works again,
// no re-issue. Admin/ops only (backend role-gates it). (Ryan 2026-06-17: no admin UI existed.)
export function resetDeliveryLock(caseId: string): Promise<{ data: { tokensReset: number } }> {
  return apiPost<{ data: { tokensReset: number } }, Record<string, never>>(deliveryPath(caseId, '/unlock-reset'), {});
}
