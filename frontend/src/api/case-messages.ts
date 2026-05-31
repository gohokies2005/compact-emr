import { apiGet, apiPost } from './client';

export type CaseMessageSenderRole = 'physician' | 'ops_staff' | 'admin';

export interface CaseMessage {
  readonly id: string;
  readonly caseId: string;
  readonly senderSub: string;
  readonly senderRole: CaseMessageSenderRole;
  readonly body: string;
  readonly readAt: string | null;
  readonly readBySub: string | null;
  readonly createdAt: string;
}

export interface CaseMessagesResponse {
  readonly data: readonly CaseMessage[];
  readonly unreadCount: number;
}

export interface MarkCaseMessagesReadResult {
  readonly markedCount: number;
}

export async function listCaseMessages(caseId: string): Promise<CaseMessagesResponse> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/messages`);
}

export async function createCaseMessage(caseId: string, input: { body: string }): Promise<{ data: CaseMessage }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/messages`, input);
}

export async function markCaseMessagesRead(
  caseId: string,
  input: { upToMessageId?: string } = {},
): Promise<{ data: MarkCaseMessagesReadResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/messages/mark-read`, input);
}
