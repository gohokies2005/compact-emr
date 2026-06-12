import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from './ui/EmptyState';
import { TabSection } from './ui/TabSection';
import { DataRow } from './ui/DataRow';
import { StatusChip } from './ui/StatusChip';
import { formatRelativeTime } from '../lib/date';
import { emailEffectiveAt, getEmailAttachment, getGmailThread, type EmailLogRow, type GmailThreadMessage } from '../api/emails';

// Feature B — read-only Email Communications log. Single chronological list of expandable rows (RN
// panel: not chat bubbles). Collapsed row = date · in/out · correspondent · subject · snippet · 📎count;
// expanded = full body + downloadable attachments + from/to + our mailbox + timestamps. Reused by the
// veteran chart tab and the per-claim tab (same component, different fetcher).
function correspondent(e: EmailLogRow): string {
  return e.direction === 'inbound' ? e.fromAddress : e.toAddress;
}

function DirectionChip({ direction }: { readonly direction: 'inbound' | 'outbound' }) {
  return direction === 'inbound'
    ? <StatusChip tone="info">In</StatusChip>
    : <StatusChip tone="neutral">Out</StatusChip>;
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
      <DataRow
        onClick={() => setOpen((o) => !o)}
        lead={<><span className="font-medium text-slateInk">{e.subject || '(no subject)'}</span>{e.snippet ? <span className="text-steel"> — {e.snippet}</span> : null}</>}
        meta={`${correspondent(e)} · ${formatRelativeTime(emailEffectiveAt(e))}`}
        trailing={<>
          {attachments.length > 0 ? <span className="text-xs text-steel" title={`${attachments.length} attachment(s)`}>📎{attachments.length}</span> : null}
          <DirectionChip direction={e.direction} />
        </>}
      />
      {open ? (
        <div className="border-t border-aegis bg-foam px-5 py-3">
          <div className="mb-2 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-steel sm:grid-cols-2">
            <span><span className="font-medium text-slateInk">From:</span> {e.fromAddress}</span>
            <span><span className="font-medium text-slateInk">To:</span> {e.toAddress}</span>
            {e.mailbox ? <span><span className="font-medium text-slateInk">Our mailbox:</span> {e.mailbox}</span> : null}
            <span><span className="font-medium text-slateInk">{e.direction === 'inbound' ? 'Received' : 'Sent'}:</span> {formatRelativeTime(emailEffectiveAt(e))}</span>
          </div>
          <div className="whitespace-pre-wrap rounded border border-aegis bg-ivory p-3 text-sm text-slateInk">{e.body || <span className="text-steel">(no body captured)</span>}</div>
          {attachments.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <button key={`${e.id}-${i}`} type="button" className="rounded border border-aegis bg-ivory px-2 py-1 text-xs text-navy hover:bg-mistSoft" onClick={() => download(i)}>📎 {a.filename}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Live Gmail (read-only) — second section below the EMR log rows on the claim tab. Metadata +
// snippet only (no bodies), so deliberately NO attachment/assign/expand affordances. Degrades to a
// quiet note while the Workspace gmail.readonly scope is ungranted (the endpoint stays 200).
function GmailRow({ m }: { readonly m: GmailThreadMessage }) {
  const when = formatRelativeTime(m.date) || m.date;
  return (
    <DataRow
      lead={<><span aria-hidden="true">{m.direction === 'inbound' ? '←' : '→'}</span> <span className="font-medium text-slateInk">{m.subject || '(no subject)'}</span>{m.snippet ? <span className="text-steel"> — {m.snippet}</span> : null}</>}
      meta={`${m.otherParty} · ${when}`}
    />
  );
}

function GmailThreadSection({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'gmail-thread'], queryFn: () => getGmailThread(caseId) });
  let body;
  if (q.isLoading) body = <div className="px-5 py-3 text-sm text-steel">Loading live Gmail…</div>;
  else if (q.isError || !q.data) body = <div className="px-5 py-3 text-sm text-steel">Live Gmail is temporarily unavailable.</div>;
  else if (!q.data.data.available) {
    body = q.data.data.reason === 'workspace_scope_not_granted'
      ? <div className="px-5 py-3 text-sm text-steel">Live Gmail isn’t connected yet — a one-time Google Workspace authorization is needed.</div>
      : <div className="px-5 py-3 text-sm text-steel">Live Gmail is temporarily unavailable.</div>;
  } else if (q.data.data.messages.length === 0) {
    body = <div className="px-5 py-3 text-sm text-steel">No Gmail correspondence found for this veteran’s address.</div>;
  } else {
    body = <>{q.data.data.messages.map((m) => <GmailRow key={m.id} m={m} />)}</>;
  }
  return <TabSection title="Live Gmail (read-only)" className="mt-4">{body}</TabSection>;
}

export function EmailLogPanel({ queryKey, fetcher, scope, caseId }: {
  readonly queryKey: readonly unknown[];
  readonly fetcher: () => Promise<{ data: readonly EmailLogRow[] }>;
  readonly scope: 'veteran' | 'claim';
  // Explicit (architect post-QA 2026-06-12): the live-Gmail section fires only when the claim tab
  // passes its caseId — never derived from the queryKey's positional shape.
  readonly caseId?: string | undefined; // | undefined: exactOptionalPropertyTypes-friendly for conditional call sites
}) {
  const q = useQuery({ queryKey: [...queryKey], queryFn: fetcher });
  if (q.isLoading) return <div className="p-4 text-sm text-steel">Loading email…</div>;
  const rows = q.data?.data ?? [];
  const log = rows.length === 0
    ? (
      <EmptyState
        title="No email correspondence yet"
        message={scope === 'claim'
          ? 'Emails tied to this specific claim appear here. Veteran-wide correspondence is on the veteran chart’s Email tab.'
          : 'Inbound + outbound email with this veteran appears here. If you expected messages, inbound email ingestion may not be enabled yet (ask the administrator).'}
      />
    )
    : (
      <TabSection>
        {rows.map((e) => <EmailRow key={e.id} e={e} />)}
      </TabSection>
    );
  return (
    <div>
      {log}
      {caseId ? <GmailThreadSection caseId={caseId} /> : null}
    </div>
  );
}
