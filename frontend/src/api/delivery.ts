import { apiGet, apiPost } from './client';

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
  // false in this build (no transport code) — the email is composed/queued, not transmitted.
  readonly emailSent: boolean;
  // 'queued' = composed, not transmitted (the only state reachable in this build); 'sent' = real send.
  readonly emailStatus: string;
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
  input: { emailBody: string },
): Promise<{ data: DeliverySendResult }> {
  return apiPost<{ data: DeliverySendResult }, typeof input>(deliveryPath(caseId, '/send'), input);
}
