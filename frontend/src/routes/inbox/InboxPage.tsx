import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { BridgeRotation } from '../../components/BridgeRotation';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { getInbox } from '../../api/messaging';
import { listUsers } from '../../api/users';
import { listPhysicians } from '../../api/physicians';
import { ThreadView } from '../../components/messaging/ThreadView';
import { ComposeMessageModal } from '../../components/messaging/ComposeMessageModal';
import { ThreadListPane } from './ThreadListPane';
import type { SubDirectory, BubbleRole } from '../../components/messaging/directory';

// Build the sub -> { name, role } directory by unioning staff users + physicians. Used to label
// senders and color bubbles in both the list pane and the ThreadView. `sub` is the cross-role key.
function useSubDirectory(): SubDirectory {
  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers() });
  const physiciansQuery = useQuery({ queryKey: ['physicians', 'all'], queryFn: () => listPhysicians() });
  return useMemo(() => {
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
}

export function InboxPage() {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const directory = useSubDirectory();

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
              onSelect={setSelectedThreadId}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {selectedThreadId ? (
              <ThreadView threadId={selectedThreadId} directory={directory} />
            ) : (
              <EmptyState title="No conversation selected" message="Pick a thread on the left, or start a new message." />
            )}
          </div>
        </div>
      </div>

      {composing ? (
        <ComposeMessageModal
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
