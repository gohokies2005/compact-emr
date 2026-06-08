import { useContext, useEffect, useState } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { apiGet, apiPost } from './client';

// Staff messaging client (CHUNK 4). Mirrors the chunk-3 backend contract. `sub` (Cognito sub) is the
// cross-role key for recipients (staff users + physicians live in separate tables — the picker unions
// both). Threads are flat-within-thread; identity is `threadId`.

export type RecipientKind = 'to' | 'cc';
export type RecipientAlias = 'all_rns' | 'all_physicians' | 'admin';

export interface InboxThreadSummary {
  readonly threadId: string;
  readonly subject: string | null;
  readonly caseId: string | null;
  readonly lastMessageBody: string;
  readonly lastMessageAt: string; // ISO
  readonly lastAuthorSub: string;
  readonly messageCount: number;
  readonly unread: boolean;
}

export interface InboxResponse {
  readonly data: readonly InboxThreadSummary[];
  readonly unreadCount: number;
}

export interface ThreadAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: string; // BigInt serialized as string
}

export interface ThreadMessage {
  readonly id: string;
  readonly authorSub: string;
  readonly body: string;
  readonly subject: string | null;
  readonly createdAt: string; // ISO
  readonly attachments: readonly ThreadAttachment[];
}

export interface ThreadRecipient {
  readonly recipientSub: string;
  readonly kind: RecipientKind;
  readonly readAt: string | null; // ISO
}

export interface ThreadDetail {
  readonly threadId: string;
  readonly caseId: string | null;
  readonly subject: string | null;
  readonly messages: readonly ThreadMessage[];
  readonly recipients: readonly ThreadRecipient[];
}

export type SendRecipient =
  | { readonly sub: string; readonly kind: RecipientKind }
  | { readonly alias: RecipientAlias; readonly kind: RecipientKind };

export interface SendMessageInput {
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly SendRecipient[];
  readonly caseId?: string;
  readonly attachmentIds: readonly string[];
}

export interface SendMessageResult {
  readonly threadId: string;
  readonly messageId: string;
}

export interface ReplyInput {
  readonly body: string;
  readonly attachmentIds: readonly string[];
}

export interface ReplyResult {
  readonly threadId: string;
  readonly messageId: string;
  readonly recipientCount: number;
}

export interface AttachmentPresign {
  readonly uploadUrl: string;
  readonly s3Key: string;
  readonly contentType: string;
  readonly expiresInSeconds: number;
  readonly requiredHeaders: Record<string, string>;
}

export interface RegisteredAttachment {
  readonly attachmentId: string;
}

const BASE = '/api/v1';

export async function getInbox(limit?: number): Promise<InboxResponse> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return apiGet<InboxResponse>(`${BASE}/messages/inbox${qs}`);
}

export async function getUnreadCount(): Promise<{ data: { unreadCount: number } }> {
  return apiGet<{ data: { unreadCount: number } }>(`${BASE}/messages/unread-count`);
}

export async function getThread(threadId: string): Promise<{ data: ThreadDetail }> {
  return apiGet<{ data: ThreadDetail }>(`${BASE}/messages/threads/${encodeURIComponent(threadId)}`);
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  return apiPost<SendMessageResult, SendMessageInput>(`${BASE}/messages`, input);
}

export async function replyToThread(threadId: string, input: ReplyInput): Promise<ReplyResult> {
  return apiPost<ReplyResult, ReplyInput>(`${BASE}/messages/${encodeURIComponent(threadId)}/reply`, input);
}

export async function markThreadRead(
  threadId: string,
  input: { upToMessageId: string },
): Promise<{ data: { markedCount: number } }> {
  return apiPost<{ data: { markedCount: number } }, { upToMessageId: string }>(
    `${BASE}/messages/threads/${encodeURIComponent(threadId)}/read`,
    input,
  );
}

export async function presignAttachment(input: {
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ data: AttachmentPresign }> {
  return apiPost<{ data: AttachmentPresign }, typeof input>(`${BASE}/messages/attachments/presign`, input);
}

export async function registerAttachment(input: {
  filename: string;
  s3Key: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ data: RegisteredAttachment }> {
  return apiPost<{ data: RegisteredAttachment }, typeof input>(`${BASE}/messages/attachments/register`, input);
}

export async function getAttachmentDownloadUrl(attachmentId: string): Promise<{ data: { downloadUrl: string } }> {
  return apiGet<{ data: { downloadUrl: string } }>(
    `${BASE}/messages/attachments/${encodeURIComponent(attachmentId)}/download`,
  );
}

// Full presign -> PUT-to-S3 -> register flow for a single staged attachment. Mirrors the physician
// signature upload (uploadAndAttachPhysicianSignature): presign, PUT the raw bytes with the EXACT
// required headers (content-type + KMS SSE), then register the key against the eventual message.
export async function uploadAndRegisterAttachment(file: File): Promise<RegisteredAttachment> {
  const contentType = file.type || 'application/octet-stream';
  const presign = await presignAttachment({ filename: file.name, contentType, sizeBytes: file.size });
  await axios.put(presign.data.uploadUrl, file, { headers: presign.data.requiredHeaders });
  const registered = await registerAttachment({
    filename: file.name,
    s3Key: presign.data.s3Key,
    contentType,
    sizeBytes: file.size,
  });
  return registered.data;
}

// Inbox unread badge. Polls every 30s, visible-tab only (refetchIntervalInBackground=false) — mirrors
// CaseDetailPage's "don't burn API in a hidden tab" pattern. Also pauses when the document is hidden
// at mount and re-enables on visibility change.
//
// The nav badge lives in TopNav (rendered on EVERY page via AppShell), so this hook must degrade
// gracefully if no QueryClient is in context (e.g. a unit test that renders a page without a provider)
// rather than crash the whole nav. useInboxUnreadCount calls useQuery (which requires a client), so the
// caller must gate it with useHasQueryClient() — see TopNav. In production App.tsx wraps everything.
export function useInboxUnreadCount(): number {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    function onVisibility() {
      setVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const query = useQuery({
    queryKey: ['messages', 'unread-count'],
    queryFn: getUnreadCount,
    refetchInterval: visible ? 30000 : false,
    refetchIntervalInBackground: false,
    enabled: visible,
  });
  return query.data?.data.unreadCount ?? 0;
}

// True when a QueryClient is present in React context. Lets the nav render the unread badge only when
// it's safe to call useInboxUnreadCount (under a QueryClientProvider) — a missing provider in a unit
// test then renders the nav with no badge instead of crashing the page.
export function useHasQueryClient(): boolean {
  return useContext(QueryClientContext) !== undefined;
}
