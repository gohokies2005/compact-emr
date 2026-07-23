import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from './ui/Button';
import { TabSection } from './ui/TabSection';
import { StatusChip } from './ui/StatusChip';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { ForbiddenError } from '../api/client';
import { getCaseThreads } from '../api/messaging';
import { listUsers, listDirectory } from '../api/users';
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
  // C4 (messaging, 2026-06-14): the case's friendly "Veteran — Condition" label, supplied by
  // CaseDetailPage (which already holds c.veteran + c.claimedCondition). Used for the locked-case chip
  // when composing and for the ThreadView "linked to …" line, so neither shows the raw caseId UUID.
  // Optional — falls back to the caseId when absent.
  readonly caseLabel?: string;
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
export function CaseMessagesPanel({ caseId, caseLabel, assignedRn, assignedPhysician }: CaseMessagesPanelProps) {
  // Single-entry caseId -> label map for THIS case, so the shared ThreadView renders "Veteran —
  // Condition" instead of the raw caseId on the "linked to …" line. The label is supplied by the
  // parent (which holds the veteran + condition); the panel itself only knows the caseId.
  const display = caseLabel ?? caseId;
  const caseLabels = useMemo(
    () => ({ [caseId]: { veteran: '', condition: '', label: display } }),
    [caseId, display],
  );
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
  // rather than the generic "Staff" fallback. Built from /users/directory, which keys EVERY row by the
  // COGNITO SUB — the same id message authors match on. (The old builder keyed staff by AppUser.id,
  // which never matched authorSub, so ops/admin-authored messages showed "Staff".) usersQuery +
  // physiciansQuery below remain — they resolve the assigned RN/physician EMAIL → default recipients.
  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers() });
  const physiciansQuery = useQuery({ queryKey: ['physicians', 'all'], queryFn: () => listPhysicians() });
  const directoryQuery = useQuery({ queryKey: ['users', 'directory'], queryFn: () => listDirectory() });

  const directory = useMemo<SubDirectory>(() => {
    const dir: Record<string, { name: string; role: BubbleRole }> = {};
    for (const e of directoryQuery.data?.data ?? []) {
      dir[e.sub] = { name: e.name, role: e.role };
    }
    return dir;
  }, [directoryQuery.data]);

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
      <TabSection bodyClassName="p-6">
        <EmptyState message="Messages are not available for this case." />
      </TabSection>
    );
  }

  return (
    <TabSection>
      <div className="p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-navyDeep">Case messages</h2>
            {unreadCount > 0 ? (
              <StatusChip tone="info">{`${unreadCount} unread`}</StatusChip>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-steel">
            Staff threads linked to this case. RN and physician collaboration; clinical details are allowed here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to={`/inbox?caseId=${encodeURIComponent(caseId)}&caseLabel=${encodeURIComponent(display)}`}
            className="text-sm font-medium text-navy hover:text-navyDeep"
          >
            Open in Inbox →
          </Link>
          <Button type="button" variant="primary" onClick={() => setComposing(true)}>
            New message
          </Button>
        </div>
      </div>

      {threadsQuery.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-steel">
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
                  ? 'border-aegis bg-navy/10'
                  : 'border-aegis bg-ivory hover:bg-mistSoft'
              }`}
            >
              <div className="flex items-center gap-2">
                {t.unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-navy" aria-label="Unread" /> : null}
                <span
                  className={`flex-1 truncate text-sm ${t.unread ? 'font-semibold text-navyDeep' : 'font-medium text-slateInk'}`}
                >
                  {t.subject ?? '(no subject)'}
                </span>
                <span className="shrink-0 text-xs text-steel">{formatRelativeTime(t.lastMessageAt)}</span>
              </div>
              <p className="truncate text-xs text-steel">
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
          caseLabels={caseLabels}
          className="mt-6 border-t border-aegis pt-6"
          onReplied={() => threadsQuery.refetch()}
        />
      ) : null}

      {composing ? (
        <ComposeMessageModal
          lockedCase={{ id: caseId, label: display }}
          initialRecipients={defaultRecipients}
          onClose={() => setComposing(false)}
          onSent={(threadId) => {
            setComposing(false);
            setSelectedThreadId(threadId);
            void threadsQuery.refetch();
          }}
        />
      ) : null}
      </div>
    </TabSection>
  );
}
