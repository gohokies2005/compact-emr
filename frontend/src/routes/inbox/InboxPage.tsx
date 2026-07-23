import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { BridgeRotation } from '../../components/BridgeRotation';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { getInbox } from '../../api/messaging';
import { listDirectory } from '../../api/users';
import { ThreadView } from '../../components/messaging/ThreadView';
import { ComposeMessageModal } from '../../components/messaging/ComposeMessageModal';
import { ThreadListPane } from './ThreadListPane';
import type { SubDirectory, BubbleRole } from '../../components/messaging/directory';
import { useCaseLabelDirectory } from '../../components/messaging/caseLabel';

// Build the sub -> { name, role } directory from the messaging directory endpoint. That endpoint keys
// EVERY row by the COGNITO SUB (the same id message authors/recipients match on), so staff, admin, and
// physician senders all resolve to their real name. The old builder keyed staff by AppUser.id, which
// never matched authorSub → every ops/admin-authored message fell back to the generic "Staff" label.
function useSubDirectory(): SubDirectory {
  const directoryQuery = useQuery({ queryKey: ['users', 'directory'], queryFn: () => listDirectory() });
  return useMemo(() => {
    const dir: Record<string, { name: string; role: BubbleRole }> = {};
    for (const e of directoryQuery.data?.data ?? []) {
      dir[e.sub] = { name: e.name, role: e.role };
    }
    return dir;
  }, [directoryQuery.data]);
}

export function InboxPage() {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const directory = useSubDirectory();
  // C4 (messaging, 2026-06-14): resolve linked-case UUIDs to "Veteran — Condition" for the list chip
  // + the open thread's header.
  const caseLabels = useCaseLabelDirectory();

  // Open-from-chart default (Ryan 2026-07-22): the chart's "Open in Inbox →" link carries the case it
  // was opened from (?caseId=&caseLabel=). When present, a new message pre-links that case so the user
  // doesn't have to re-search the veteran by name. It's a DEFAULT, not a lock — the compose still shows
  // the case picker (via initialCase, not lockedCase), so they can clear or change it.
  const [searchParams] = useSearchParams();
  const linkedCaseId = searchParams.get('caseId');
  const linkedCaseLabel = searchParams.get('caseLabel');
  const initialCase = linkedCaseId ? { id: linkedCaseId, label: linkedCaseLabel ?? linkedCaseId } : undefined;

  const inboxQuery = useQuery({
    queryKey: ['messages', 'inbox'],
    queryFn: () => getInbox(),
    refetchOnWindowFocus: true,
  });

  const allThreads = inboxQuery.data?.data ?? [];
  const threads = useMemo(
    () => (unreadOnly ? allThreads.filter((t) => t.unread) : allThreads),
    [allThreads, unreadOnly],
  );

  return (
    <AppShell>
      {/* Ambient bridge band — Inbox is one of the three MAIN physician tabs (Ryan 2026-06-10 P2.3).
          The page is shared with staff; the band shows for everyone (it already does on the staff
          dashboard). Wrapper mirrors PhysicianQueuePage. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-aegis shadow-aegis-card">
        <BridgeRotation caption={false} className="h-40 sm:h-48">
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-navyDeep/85 via-navyDeep/50 to-transparent" />
          <div className="relative flex h-full flex-col justify-center px-7">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
            <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">Inbox</h1>
            <p className="mt-1 text-sm text-white/75">Staff-to-staff messages</p>
          </div>
        </BridgeRotation>
      </section>

      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-slate-500">Optionally link a case to a message.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              Unread only
            </label>
            <Button variant="primary" onClick={() => setComposing(true)}>
              New message
            </Button>
          </div>
        </div>

        <div className="flex min-h-[28rem] overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="w-[360px] shrink-0 overflow-y-auto border-r border-slate-200">
            <ThreadListPane
              threads={threads}
              isLoading={inboxQuery.isLoading}
              selectedThreadId={selectedThreadId}
              directory={directory}
              caseLabels={caseLabels}
              onSelect={setSelectedThreadId}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {selectedThreadId ? (
              <ThreadView threadId={selectedThreadId} directory={directory} caseLabels={caseLabels} />
            ) : (
              <EmptyState title="No conversation selected" message="Pick a thread on the left, or start a new message." />
            )}
          </div>
        </div>
      </div>

      {composing ? (
        <ComposeMessageModal
          {...(initialCase ? { initialCase } : {})}
          onClose={() => setComposing(false)}
          onSent={(threadId) => {
            setComposing(false);
            setSelectedThreadId(threadId);
          }}
        />
      ) : null}
    </AppShell>
  );
}
