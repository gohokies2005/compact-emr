import { apiClient, apiGet, apiPost } from './client';

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

/**
 * Open the cover memo as a PDF in a new tab (E4). The memo PDF route is an authenticated API GET,
 * and a plain window.open can't carry the Bearer token — so fetch the bytes through apiClient
 * (token rides the interceptor, same pattern as reports.ts fetchCostCsv) and open a Blob URL.
 * Throws on failure so the caller can surface the REAL error.
 */
export async function openMemoPdf(caseId: string): Promise<void> {
  const response = await apiClient.get(deliveryPath(caseId, '/memo.pdf'), { responseType: 'blob' });
  const blob = response.data instanceof Blob
    ? response.data
    : new Blob([response.data as BlobPart], { type: 'application/pdf' });
  const typed = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  const url = URL.createObjectURL(typed);
  window.open(url, '_blank', 'noopener,noreferrer');
  // Give the new tab time to load the blob before revoking (revoke-immediately breaks Firefox).
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
