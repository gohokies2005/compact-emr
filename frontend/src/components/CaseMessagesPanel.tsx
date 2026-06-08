import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { ForbiddenError } from '../api/client';
import { getCaseThreads } from '../api/messaging';
import { listUsers } from '../api/users';
import { listPhysicians } from '../api/physicians';
import { formatRelativeTime } from '../lib/date';
import { ThreadView } from './messaging/ThreadView';
import { ComposeMessageModal } from './messaging/ComposeMessageModal';
import type { SelectedRecipient } from './messaging/RecipientMultiSelect';
import type { BubbleRole, SubDirectory } from './messaging/directory';
import { senderLabel } from './messaging/directory';
import type { CasePhysicianLite, AssignedRnLite } from '../api/cases';

interface CaseMessagesPanelProps {
  readonly caseId: string;
  // The case's assigned RN + physician, surfaced by CaseDetailPage. Used to seed the default recipients
  // when composing a new case-linked thread (their Cognito sub is resolved by email against the staff +
  // physician directory). Optional — an unassigned case just composes with no defaults.
  readonly assignedRn?: AssignedRnLite | null;
  readonly assignedPhysician?: CasePhysicianLite | null;
}

// CHUNK 5: the chart Messages tab now renders the case's STAFF-MESSAGE threads (the new threaded,
// multi-recipient, reply-all system) instead of the old flat 2-party CaseMessage thread. The case is
// auto-linked: getCaseThreads returns only threads linked to this case, and composing a new thread locks
// the case link + defaults recipients to the assigned RN + physician. The reusable ThreadView (CHUNK 4)
// owns each thread's fetch / mark-read / reply-all; this panel just lists threads and drives compose.
export function CaseMessagesPanel({ caseId, assignedRn, assignedPhysician }: CaseMessagesPanelProps) {
  const [composing, setComposing] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const threadsQuery = useQuery({
    queryKey: ['case', caseId, 'staff-messages'],
    queryFn: () => getCaseThreads(caseId),
    refetchOnWindowFocus: true,
    retry: (failureCount, error: unknown) => {
      if (error instanceof ForbiddenError) return false;
      return failureCount < 2;
    },
  });

  // Staff + physician directory (sub -> { name, role }) so bubbles + the thread list show names/roles
  // rather than raw Cognito subs. Mirrors InboxPage.useSubDirectory; the assigned RN/physician + any
  // thread participants resolve through it.
  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers() });
  const physiciansQuery = useQuery({ queryKey: ['physicians', 'all'], queryFn: () => listPhysicians() });

  const directory = useMemo<SubDirectory>(() => {
    const dir: Record<string, { name: string; role: BubbleRole }> = {};
    for (const u of usersQuery.data?.data ?? []) {
      const role: BubbleRole = u.roles.includes('admin')
        ? 'admin'
        : u.roles.includes('ops_staff')
          ? 'ops_staff'
          : u.roles.includes('physician')
            ? 'physician'
            : 'unknown';
      dir[u.id] = { name: u.name ?? u.email, role };
    }
    for (const p of physiciansQuery.data?.data ?? []) {
      if (p.cognitoSub) dir[p.cognitoSub] = { name: p.fullName, role: 'physician' };
    }
    return dir;
  }, [usersQuery.data, physiciansQuery.data]);

  // Default recipients for a new case-linked thread = the assigned RN + physician. The case carries only
  // their email (assignedRn/assignedPhysician), so we resolve each to a Cognito `sub` via the directory
  // sources: staff users (sub == listUsers id) and physicians (cognitoSub). Unresolvable (no account /
  // no Cognito identity) entries are dropped — the composer's recipient picker can still add them by hand.
  const defaultRecipients = useMemo<readonly SelectedRecipient[]>(() => {
    const out: SelectedRecipient[] = [];
    const seen = new Set<string>();
    function push(sub: string, label: string) {
      if (seen.has(sub)) return;
      seen.add(sub);
      out.push({ key: sub, label, kind: 'to', send: { sub, kind: 'to' } });
    }
    if (assignedRn?.email) {
      const match = (usersQuery.data?.data ?? []).find(
        (u) => u.email.toLowerCase() === assignedRn.email.toLowerCase(),
      );
      if (match) push(match.id, match.name ?? match.email);
    }
    if (assignedPhysician?.email) {
      const match = (physiciansQuery.data?.data ?? []).find(
        (p) => p.cognitoSub && p.email.toLowerCase() === assignedPhysician.email.toLowerCase(),
      );
      if (match?.cognitoSub) push(match.cognitoSub, match.fullName);
    }
    return out;
  }, [assignedRn, assignedPhysician, usersQuery.data, physiciansQuery.data]);

  const threads = useMemo(() => threadsQuery.data?.data ?? [], [threadsQuery.data]);
  const unreadCount = useMemo(() => threads.filter((t) => t.unread).length, [threads]);

  // When exactly one thread exists, show it inline. With several, show a compact list and let the user
  // pick one (selection falls back to the list when the chosen thread disappears after a refetch).
  const activeThreadId = useMemo(() => {
    if (selectedThreadId && threads.some((t) => t.threadId === selectedThreadId)) return selectedThreadId;
    if (threads.length === 1) return threads[0]!.threadId;
    return null;
  }, [selectedThreadId, threads]);

  if (threadsQuery.isError && threadsQuery.error instanceof ForbiddenError) {
    return (
      <Card>
        <EmptyState message="Messages are not available for this case." />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">Case messages</h2>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800">{`${unreadCount} unread`}</span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Staff threads linked to this case. RN and physician collaboration; clinical details are allowed here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/inbox" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            Open in Inbox →
          </Link>
          <Button type="button" variant="primary" onClick={() => setComposing(true)}>
            New message
          </Button>
        </div>
      </div>

      {threadsQuery.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <Spinner />
          Loading messages
        </div>
      ) : null}

      {!threadsQuery.isLoading && threads.length === 0 ? (
        <div className="mt-6">
          <EmptyState message="No messages yet. Start a thread with the assigned RN and physician." />
        </div>
      ) : null}

      {/* Several threads: a compact selectable list above the open thread. One thread: straight to it. */}
      {threads.length > 1 ? (
        <div className="mt-6 space-y-2">
          {threads.map((t) => (
            <button
              key={t.threadId}
              type="button"
              onClick={() => setSelectedThreadId(t.threadId)}
              aria-current={t.threadId === activeThreadId ? 'true' : undefined}
              className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition ${
                t.threadId === activeThreadId
                  ? 'border-indigo-300 bg-indigo-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2">
                {t.unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" aria-label="Unread" /> : null}
                <span
                  className={`flex-1 truncate text-sm ${t.unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}
                >
                  {t.subject ?? '(no subject)'}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(t.lastMessageAt)}</span>
              </div>
              <p className="truncate text-xs text-slate-500">
                {senderLabel(t.lastAuthorSub, directory)}: {t.lastMessageBody}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      {activeThreadId ? (
        <ThreadView
          threadId={activeThreadId}
          directory={directory}
          className="mt-6 border-t border-slate-200 pt-6"
          onReplied={() => threadsQuery.refetch()}
        />
      ) : null}

      {composing ? (
        <ComposeMessageModal
          lockedCase={{ id: caseId, label: caseId }}
          initialRecipients={defaultRecipients}
          onClose={() => setComposing(false)}
          onSent={(threadId) => {
            setComposing(false);
            setSelectedThreadId(threadId);
            void threadsQuery.refetch();
          }}
        />
      ) : null}
    </Card>
  );
}
