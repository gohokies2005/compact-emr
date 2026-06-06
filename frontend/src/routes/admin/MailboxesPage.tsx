import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { describeApiError } from '../../api/client';
import { addMailbox, deleteMailbox, listMailboxes, updateMailbox, type MonitoredMailbox } from '../../api/mailboxes';

// Feature B — admin page to manage which Google Workspace mailboxes the EMR tracks (Ryan 2026-06-06:
// "add an email profile to the EMR ... easily add emails as I add staff"). The gmail-ingest poller
// reads the ACTIVE mailboxes from here. Pause stops polling but keeps history; Remove drops it.
export function MailboxesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mailboxes'], queryFn: listMailboxes });
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['mailboxes'] });
  const add = useMutation({
    mutationFn: () => addMailbox({ address: address.trim(), ...(label.trim() ? { label: label.trim() } : {}) }),
    onSuccess: () => { setAddress(''); setLabel(''); void invalidate(); },
    onError: (e: unknown) => window.alert(`Could not add the mailbox — ${describeApiError(e)}`),
  });
  const toggle = useMutation({
    mutationFn: (m: MonitoredMailbox) => updateMailbox(m.id, { active: !m.active }),
    onSuccess: () => void invalidate(),
    onError: (e: unknown) => window.alert(`Could not update — ${describeApiError(e)}`),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteMailbox(id),
    onSuccess: () => void invalidate(),
    onError: (e: unknown) => window.alert(`Could not remove — ${describeApiError(e)}`),
  });
  const rows = q.data?.data ?? [];

  return <AppShell><div className="space-y-6">
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Email setup — tracked mailboxes</h1>
      <p className="text-sm text-slate-500">The Google Workspace mailboxes whose correspondence is logged into the EMR. Add a staff mailbox here as you hire.</p>
    </div>

    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <span className="font-semibold">Not live yet.</span> Inbound email tracking turns on after the one-time Google Workspace
      service-account setup + the ingester is enabled. Mailboxes you add here take effect once that's on; until then this list is saved but not yet polled.
    </div>

    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-800">Add a mailbox</h2>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="block text-sm sm:flex-1"><span className="mb-1 block font-medium text-slate-700">Email address</span>
          <input className="input" placeholder="jane@flatratenexus.com" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && address.trim()) add.mutate(); }} /></label>
        <label className="block text-sm sm:w-64"><span className="mb-1 block font-medium text-slate-700">Label (optional)</span>
          <input className="input" placeholder="Jane (RN)" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!address.trim()}>Add</Button>
      </div>
    </div>

    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      {q.isLoading ? (
        <div className="p-6 text-sm text-slate-500">Loading mailboxes…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="No mailboxes tracked yet" message="Add the first one above (e.g. info@flatratenexus.com)." />
      ) : (
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
            <th className="px-4 py-3">Mailbox</th><th className="px-4 py-3">Label</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Added by</th><th className="px-4 py-3" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3 font-medium text-slate-800">{m.address}</td>
                <td className="px-4 py-3 text-slate-600">{m.label ?? '—'}</td>
                <td className="px-4 py-3">{m.active
                  ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">Active</span>
                  : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">Paused</span>}</td>
                <td className="px-4 py-3 text-slate-500">{m.addedBy ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  <button type="button" className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-50" disabled={toggle.isPending} onClick={() => toggle.mutate(m)}>{m.active ? 'Pause' : 'Resume'}</button>
                  <button type="button" className="ml-4 text-xs font-medium text-rose-600 hover:underline disabled:opacity-50" disabled={del.isPending} onClick={() => { if (window.confirm(`Stop tracking ${m.address}? Existing logged emails are kept.`)) del.mutate(m.id); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </div></AppShell>;
}
