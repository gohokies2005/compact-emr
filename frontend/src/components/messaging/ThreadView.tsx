import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import { ForbiddenError, describeApiError } from '../../api/client';
import { getThread, markThreadRead, replyToThread } from '../../api/messaging';
import { MessageBubble } from './MessageBubble';
import type { SubDirectory } from './directory';
import { resolveCaseLabel, type CaseLabelParts } from './caseLabel';
import { MessageAttachmentPicker, type StagedAttachment } from './MessageAttachmentPicker';

// SHARED, standalone ThreadView — reused by the Inbox (CHUNK 4) AND the chart Messages tab (CHUNK 5).
// It owns: fetching the thread, computing per-message "Read by N/M" from recipients, auto-mark-read on
// open (guarded effect mirrors CaseMessagesPanel), the message bubble list, and the inline reply-all
// composer. It takes ONLY a threadId + a sub->{name,role} directory for rendering names/colors. No
// route/page coupling, so CHUNK 5 can drop it straight into the chart tab.
//
// Props:
//   threadId   — which thread to render (required).
//   directory  — sub -> { name, role } for sender labels + role bubble colors (caller builds it by
//                unioning listUsers + listPhysicians). Optional; unknown subs render the raw sub.
//   onReplied  — optional callback after a successful reply (e.g. refresh the inbox list).
//   className  — optional wrapper class passthrough.
export function ThreadView({
  threadId,
  directory = {},
  caseLabels = {},
  onReplied,
  className,
}: {
  readonly threadId: string;
  readonly directory?: SubDirectory;
  // C4 (messaging, 2026-06-14): caseId -> "Veteran — Condition" so the linked-case line reads a name,
  // not a raw UUID. Optional; an id not in the map falls back to the raw caseId (prior behavior).
  readonly caseLabels?: Readonly<Record<string, CaseLabelParts>>;
  readonly onReplied?: () => void;
  readonly className?: string;
}) {
  const qc = useQueryClient();
  const [replyBody, setReplyBody] = useState('');
  const [attachments, setAttachments] = useState<readonly StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const threadQuery = useQuery({
    queryKey: ['messages', 'thread', threadId],
    queryFn: () => getThread(threadId),
    retry: (failureCount, error: unknown) => {
      if (error instanceof ForbiddenError) return false;
      return failureCount < 2;
    },
  });

  const thread = threadQuery.data?.data;
  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  const recipients = thread?.recipients ?? [];
  const latestMessageId = messages[messages.length - 1]?.id;

  // "Read by N/M" for the thread: M = recipient count, N = recipients with a readAt. Computed once and
  // shown on the latest message (per-recipient read is a thread-level marker on a flat thread).
  const readByLabel = useMemo(() => {
    if (recipients.length === 0) return undefined;
    const readCount = recipients.filter((r) => r.readAt !== null).length;
    return `Read by ${readCount}/${recipients.length}`;
  }, [recipients]);

  const markReadMutation = useMutation({
    mutationFn: (upToMessageId: string) => markThreadRead(threadId, { upToMessageId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['messages', 'unread-count'] });
      await qc.invalidateQueries({ queryKey: ['messages', 'inbox'] });
    },
  });
  const markReadMutate = markReadMutation.mutate;
  const markReadPending = markReadMutation.isPending;

  // Mark the latest message read at most once per id — the post-success refetch still reports it
  // unread until the server catches up, so without the guard this loops. (Mirrors CaseMessagesPanel.)
  const markedUpToRef = useRef<string | null>(null);
  useEffect(() => {
    if (latestMessageId && markedUpToRef.current !== latestMessageId && !markReadPending) {
      markedUpToRef.current = latestMessageId;
      markReadMutate(latestMessageId);
    }
  }, [latestMessageId, markReadMutate, markReadPending]);

  const replyMutation = useMutation({
    mutationFn: () =>
      replyToThread(threadId, {
        body: replyBody.trim(),
        attachmentIds: attachments.map((a) => a.attachmentId),
      }),
    onSuccess: async () => {
      setReplyBody('');
      setAttachments([]);
      setErrorMessage(null);
      await qc.invalidateQueries({ queryKey: ['messages', 'thread', threadId] });
      await qc.invalidateQueries({ queryKey: ['messages', 'inbox'] });
      onReplied?.();
    },
    onError: (e: unknown) => setErrorMessage(`Reply could not be sent — ${describeApiError(e)}`),
  });

  if (threadQuery.isError && threadQuery.error instanceof ForbiddenError) {
    return <EmptyState message="You don't have access to this conversation." />;
  }

  if (threadQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Loading conversation
      </div>
    );
  }

  if (!thread) {
    return <EmptyState message="Conversation not found." />;
  }

  const replyDisabled = replyBody.trim().length === 0 || replyBody.length > 4000 || uploading || replyMutation.isPending;

  return (
    <div className={className}>
      <div className="border-b border-slate-200 pb-3">
        <h2 className="text-base font-semibold text-slate-900">{thread.subject ?? '(no subject)'}</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
          {thread.caseId ? ` · linked to ${resolveCaseLabel(thread.caseId, caseLabels).label}` : ''}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {messages.map((message, i) => (
          <MessageBubble
            key={message.id}
            message={message}
            directory={directory}
            readByLabel={i === messages.length - 1 ? readByLabel : undefined}
          />
        ))}
      </div>

      <div className="mt-6 border-t border-slate-200 pt-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-800">Reply to all</span>
          <textarea
            value={replyBody}
            onChange={(e) => {
              setReplyBody(e.target.value);
              setErrorMessage(null);
            }}
            rows={4}
            maxLength={4000}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Reply to everyone on this thread."
          />
          <span className="mt-1 block text-xs text-slate-500">{replyBody.length}/4000</span>
        </label>
        <div className="mt-2">
          <MessageAttachmentPicker
            staged={attachments}
            onChange={setAttachments}
            onUploadingChange={setUploading}
            disabled={replyMutation.isPending}
          />
        </div>
        {errorMessage ? (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="primary"
            loading={replyMutation.isPending}
            disabled={replyDisabled}
            onClick={() => replyMutation.mutate()}
          >
            Send reply
          </Button>
        </div>
      </div>
    </div>
  );
}
