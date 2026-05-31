import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { ForbiddenError } from '../api/client';
import { createCaseMessage, listCaseMessages, markCaseMessagesRead, type CaseMessage } from '../api/case-messages';
import { formatRelativeTime } from '../lib/date';

interface CaseMessagesPanelProps {
  readonly caseId: string;
}

function roleLabel(role: CaseMessage['senderRole']): string {
  if (role === 'physician') return 'Physician';
  if (role === 'ops_staff') return 'RN';
  return 'Admin';
}

function roleClassName(role: CaseMessage['senderRole']): string {
  if (role === 'physician') return 'border-purple-200 bg-purple-50 text-purple-800';
  if (role === 'ops_staff') return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

export function CaseMessagesPanel({ caseId }: CaseMessagesPanelProps) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const messagesQuery = useQuery({
    queryKey: ['case', caseId, 'messages'],
    queryFn: () => listCaseMessages(caseId),
    refetchOnWindowFocus: true,
    retry: (failureCount, error: unknown) => {
      if (error instanceof ForbiddenError) return false;
      return failureCount < 2;
    },
  });

  const messages = useMemo(() => messagesQuery.data?.data ?? [], [messagesQuery.data]);
  const unreadCount = messagesQuery.data?.unreadCount ?? 0;
  const latestMessageId = messages[messages.length - 1]?.id;

  const markReadMutation = useMutation({
    mutationFn: (upToMessageId?: string) => markCaseMessagesRead(caseId, { ...(upToMessageId && { upToMessageId }) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['case', caseId, 'messages'] }); },
  });
  const markReadMutate = markReadMutation.mutate;
  const markReadPending = markReadMutation.isPending;

  const createMutation = useMutation({
    mutationFn: () => createCaseMessage(caseId, { body: body.trim() }),
    onSuccess: async () => { setBody(''); setErrorMessage(null); await qc.invalidateQueries({ queryKey: ['case', caseId, 'messages'] }); },
    onError: () => { setErrorMessage('Message could not be sent. Please retry.'); },
  });

  useEffect(() => {
    if (unreadCount > 0 && latestMessageId && !markReadPending) markReadMutate(latestMessageId);
  }, [latestMessageId, markReadMutate, markReadPending, unreadCount]);

  if (messagesQuery.isError && messagesQuery.error instanceof ForbiddenError) {
    return <Card><EmptyState message="Messages are not available for this case." /></Card>;
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">Case messages</h2>
            {unreadCount > 0 ? <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800">{`${unreadCount} unread`}</span> : null}
          </div>
          <p className="mt-1 text-sm text-slate-600">RN and physician thread for this case. Clinical details are allowed here.</p>
        </div>
      </div>

      {messagesQuery.isLoading ? <div className="mt-6 flex items-center gap-2 text-sm text-slate-500"><Spinner />Loading messages</div> : null}
      {!messagesQuery.isLoading && messages.length === 0 ? <div className="mt-6"><EmptyState message="No messages yet." /></div> : null}

      {messages.length > 0 ? (
        <div className="mt-6 space-y-3">
          {messages.map((message) => (
            <article key={message.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${roleClassName(message.senderRole)}`}>{roleLabel(message.senderRole)}</span>
                <span className="text-xs text-slate-500">{formatRelativeTime(message.createdAt)}</span>
                {message.readAt ? <span className="text-xs text-slate-400">Read {formatRelativeTime(message.readAt)}</span> : null}
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-800">{message.body}</p>
            </article>
          ))}
        </div>
      ) : null}

      <div className="mt-6 border-t border-slate-200 pt-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-800">New message</span>
          <textarea value={body} onChange={(e) => { setBody(e.target.value); setErrorMessage(null); }} rows={4} maxLength={4000} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" placeholder="Write a message for the assigned RN or physician." />
          <span className="mt-1 block text-xs text-slate-500">{body.length}/4000</span>
        </label>
        {errorMessage ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div> : null}
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="primary" loading={createMutation.isPending} disabled={body.trim().length === 0 || body.length > 4000 || createMutation.isPending} onClick={() => createMutation.mutate()}>Send message</Button>
        </div>
      </div>
    </Card>
  );
}
