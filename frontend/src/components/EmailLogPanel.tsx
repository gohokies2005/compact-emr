import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from './ui/EmptyState';
import { formatRelativeTime } from '../lib/date';
import { emailEffectiveAt, getEmailAttachment, type EmailLogRow } from '../api/emails';

// Feature B — read-only Email Communications log. Single chronological list of expandable rows (RN
// panel: not chat bubbles). Collapsed row = date · in/out · correspondent · subject · snippet · 📎count;
// expanded = full body + downloadable attachments + from/to + our mailbox + timestamps. Reused by the
// veteran chart tab and the per-claim tab (same component, different fetcher).
function correspondent(e: EmailLogRow): string {
  return e.direction === 'inbound' ? e.fromAddress : e.toAddress;
}

function DirectionChip({ direction }: { readonly direction: 'inbound' | 'outbound' }) {
  return direction === 'inbound'
    ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-700">In</span>
    : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">Out</span>;
}

function EmailRow({ e }: { readonly e: EmailLogRow }) {
  const [open, setOpen] = useState(false);
  const attachments = e.attachmentsJson ?? [];
  async function download(idx: number) {
    try { const { data } = await getEmailAttachment(e.id, idx); window.open(data.url, '_blank', 'noopener,noreferrer'); }
    catch { window.alert('Could not open that attachment. Please retry.'); }
  }
  return (
    <div className="text-sm">
      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen((o) => !o)}>
        <DirectionChip direction={e.direction} />
        <span className="w-44 shrink-0 truncate text-slate-700" title={correspondent(e)}>{correspondent(e)}</span>
        <span className="flex-1 truncate"><span className="font-medium text-slate-800">{e.subject || '(no subject)'}</span>{e.snippet ? <span className="text-slate-500"> — {e.snippet}</span> : null}</span>
        {attachments.length > 0 ? <span className="shrink-0 text-xs text-slate-400" title={`${attachments.length} attachment(s)`}>📎{attachments.length}</span> : null}
        <span className="w-24 shrink-0 text-right text-xs text-slate-400">{formatRelativeTime(emailEffectiveAt(e))}</span>
      </button>
      {open ? (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
          <div className="mb-2 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-2">
            <span><span className="font-medium text-slate-600">From:</span> {e.fromAddress}</span>
            <span><span className="font-medium text-slate-600">To:</span> {e.toAddress}</span>
            {e.mailbox ? <span><span className="font-medium text-slate-600">Our mailbox:</span> {e.mailbox}</span> : null}
            <span><span className="font-medium text-slate-600">{e.direction === 'inbound' ? 'Received' : 'Sent'}:</span> {formatRelativeTime(emailEffectiveAt(e))}</span>
          </div>
          <div className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 text-sm text-slate-800">{e.body || <span className="text-slate-400">(no body captured)</span>}</div>
          {attachments.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <button key={`${e.id}-${i}`} type="button" className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50" onClick={() => download(i)}>📎 {a.filename}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function EmailLogPanel({ queryKey, fetcher, scope }: {
  readonly queryKey: readonly unknown[];
  readonly fetcher: () => Promise<{ data: readonly EmailLogRow[] }>;
  readonly scope: 'veteran' | 'claim';
}) {
  const q = useQuery({ queryKey: [...queryKey], queryFn: fetcher });
  if (q.isLoading) return <div className="p-4 text-sm text-slate-500">Loading email…</div>;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No email correspondence yet"
        message={scope === 'claim'
          ? 'Emails tied to this specific claim appear here. Veteran-wide correspondence is on the veteran chart’s Email tab.'
          : 'Inbound + outbound email with this veteran appears here. If you expected messages, inbound email ingestion may not be enabled yet (ask the administrator).'}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="divide-y divide-slate-100">
        {rows.map((e) => <EmailRow key={e.id} e={e} />)}
      </div>
    </div>
  );
}
