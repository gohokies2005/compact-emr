import { apiGet, apiPost } from './client';

export interface EmailAttachment { readonly filename: string; readonly s3Key?: string; readonly contentType?: string; readonly sizeBytes?: number }

export interface EmailLogRow {
  readonly id: string;
  readonly caseId: string | null;
  readonly veteranId: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly subject: string;
  readonly body: string;
  readonly snippet: string | null;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly mailbox: string | null;
  readonly attachmentsJson?: readonly EmailAttachment[] | null;
  readonly receivedAt: string | null;
  readonly sentAt: string | null;
  readonly status: string;
  readonly createdAt: string;
}

export async function listVeteranEmails(veteranId: string): Promise<{ data: readonly EmailLogRow[] }> {
  return apiGet(`/api/v1/veterans/${encodeURIComponent(veteranId)}/emails`);
}
export async function listCaseEmails(caseId: string): Promise<{ data: readonly EmailLogRow[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/emails`);
}
// Live Gmail (read-only) for the claim Email tab — metadata + snippet only, never bodies. Ships
// DARK: the backend degrades to {available:false} until the Workspace gmail.readonly scope is
// granted, and the endpoint stays 200 either way.
export interface GmailThreadMessage {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly otherParty: string;
  readonly subject: string;
  readonly snippet: string;
  readonly date: string;
}
export type GmailThreadResult =
  | { readonly available: true; readonly messages: readonly GmailThreadMessage[] }
  | { readonly available: false; readonly reason: 'workspace_scope_not_granted' | 'gmail_unreachable' };

export async function getGmailThread(caseId: string): Promise<{ data: GmailThreadResult }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/gmail-thread`);
}

export async function listUnmatchedEmails(): Promise<{ data: readonly EmailLogRow[] }> {
  return apiGet(`/api/v1/emails/unmatched`);
}
export async function assignEmail(id: string, input: { veteranId?: string; caseId?: string }): Promise<{ data: EmailLogRow }> {
  return apiPost(`/api/v1/emails/${encodeURIComponent(id)}/assign`, input);
}
export async function getEmailAttachment(id: string, idx: number): Promise<{ data: { url: string; filename: string } }> {
  return apiGet(`/api/v1/emails/${encodeURIComponent(id)}/attachments/${idx}/download`);
}

// The true message time for sorting/display: received (inbound) → sent (outbound) → recorded.
export function emailEffectiveAt(e: EmailLogRow): string {
  return e.receivedAt ?? e.sentAt ?? e.createdAt;
}
