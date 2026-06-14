import { formatRelativeTime } from '../../lib/date';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import type { InboxThreadSummary } from '../../api/messaging';
import { senderLabel, type SubDirectory } from '../../components/messaging/directory';
import { resolveCaseLabel, type CaseLabelParts } from '../../components/messaging/caseLabel';

// Left master pane (360px) for the Inbox. Unread threads get an indigo left-accent + dot + bold
// subject; case-linked threads show a case chip; selected thread is highlighted.
// C4 (messaging, 2026-06-14): the case chip shows "Veteran — Condition", not the raw caseId UUID.
export function ThreadListItem({
  thread,
  selected,
  directory,
  caseLabels = {},
  onSelect,
}: {
  readonly thread: InboxThreadSummary;
  readonly selected: boolean;
  readonly directory: SubDirectory;
  readonly caseLabels?: Readonly<Record<string, CaseLabelParts>>;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left transition ${
        thread.unread ? 'border-l-indigo-500' : 'border-l-transparent'
      } ${selected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
    >
      <div className="flex items-center gap-2">
        {thread.unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" aria-label="Unread" /> : null}
        <span
          className={`flex-1 truncate text-sm ${thread.unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}
        >
          {thread.subject ?? '(no subject)'}
        </span>
        <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(thread.lastMessageAt)}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="truncate">{senderLabel(thread.lastAuthorSub, directory)}</span>
        {thread.messageCount > 1 ? <span className="shrink-0 text-slate-400">· {thread.messageCount}</span> : null}
      </div>
      <p className="truncate text-xs text-slate-500">{thread.lastMessageBody}</p>
      {thread.caseId ? (
        <span className="mt-0.5 inline-flex w-fit items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          {resolveCaseLabel(thread.caseId, caseLabels).label}
        </span>
      ) : null}
    </button>
  );
}

export function ThreadListPane({
  threads,
  isLoading,
  selectedThreadId,
  directory,
  caseLabels = {},
  onSelect,
}: {
  readonly threads: readonly InboxThreadSummary[];
  readonly isLoading: boolean;
  readonly selectedThreadId: string | null;
  readonly directory: SubDirectory;
  readonly caseLabels?: Readonly<Record<string, CaseLabelParts>>;
  readonly onSelect: (threadId: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
        <Spinner />
        Loading inbox
      </div>
    );
  }
  if (threads.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="No messages" message="Start a conversation with the New message button." />
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100">
      {threads.map((t) => (
        <ThreadListItem
          key={t.threadId}
          thread={t}
          selected={t.threadId === selectedThreadId}
          directory={directory}
          caseLabels={caseLabels}
          onSelect={() => onSelect(t.threadId)}
        />
      ))}
    </div>
  );
}
