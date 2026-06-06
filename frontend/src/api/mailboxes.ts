import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface MonitoredMailbox {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly active: boolean;
  readonly addedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function listMailboxes(): Promise<{ data: readonly MonitoredMailbox[] }> {
  return apiGet('/api/v1/mailboxes');
}
export async function addMailbox(input: { address: string; label?: string }): Promise<{ data: MonitoredMailbox }> {
  return apiPost('/api/v1/mailboxes', input);
}
export async function updateMailbox(id: string, input: { active?: boolean; label?: string }): Promise<{ data: MonitoredMailbox }> {
  return apiPatch(`/api/v1/mailboxes/${encodeURIComponent(id)}`, input);
}
export async function deleteMailbox(id: string): Promise<void> {
  return apiDelete(`/api/v1/mailboxes/${encodeURIComponent(id)}`);
}
