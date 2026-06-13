import { useState } from 'react';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from './ui/EmptyState';
import { TabSection } from './ui/TabSection';
import { DataRow } from './ui/DataRow';
import { StatusChip } from './ui/StatusChip';
import { formatRelativeTime } from '../lib/date';
import { emailEffectiveAt, getEmailAttachment, getGmailThread, getGmailMessageBody, type EmailLogRow, type GmailThreadMessage } from '../api/emails';

// Feature B — read-only Email Communications log. Single chronological list of expandable rows (RN
// panel: not chat bubbles). Collapsed row = date · in/out · correspondent · subject · snippet · 📎count;
// expanded = full body + downloadable attachments + from/to + our mailbox + timestamps. Reused by the
// veteran chart tab and the per-claim tab (same component, different fetcher).
function correspondent(e: EmailLogRow): string {
  return e.direction === 'inbound' ? e.fromAddress : e.toAddress;
}

// Decode HTML entities (Gmail snippets arrive HTML-escaped: "that&#39;s", "&lt;info@…&gt;"). The
// textarea trick decodes named + numeric entities safely (no script execution). (Ryan 2026-06-12.)
function decodeEntities(s: string): string {
  if (!s) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

// Strip the quoted reply history so each bubble shows only its OWN new content — the prior emails
// are already their own bubbles above (Ryan 2026-06-12: "just have the response and follow
// sequentially"). Cuts at the earliest of: an "On <date> … wrote:" attribution, an Original-Message
// divider, a From:/Sent: header block, the first quoted ">" line, or a known mobile-client footer.
const QUOTE_MARKERS: readonly RegExp[] = [
  /\r?\n?On\s[\s\S]{0,300}?\bwrote:/i,
  /\r?\n-{2,}\s*Original Message\s*-{2,}/i,
  /\r?\nFrom:\s.*\r?\n(Sent|Date|To):\s/i,
  /\r?\n>/,
  /Yahoo Mail: Search, Organize, Conquer/i,
  /Sent from my (iPhone|iPad|Android|mobile|Galaxy)/i,
  /Get Outlook for (iOS|Android)/i,
];
function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}
export function cleanEmailText(text: string): string {
  const decoded = decodeEntities(text ?? '');
  const stripped = stripQuotedReply(decoded).trim();
  // If stripping ate everything (a pure quote/forward), fall back to the decoded original.
  return stripped.length > 0 ? stripped : decoded.trim();
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

// Live Gmail (read-only) — bubble-chat conversation below the EMR log on the claim tab (Ryan
// 2026-06-12: "i like bubble chats ... something thats obvious based on who is emailing"). Inbound
// (the veteran / correspondent) sits LEFT in a mist bubble; outbound (us) sits RIGHT in a navy-tint
// bubble. The collapsed bubble shows the Gmail snippet; clicking lazily fetches the FULL body
// (authenticated, never persisted). Degrades to a quiet note while the readonly scope is ungranted.
function GmailBubble({ caseId, m }: { readonly caseId: string; readonly m: GmailThreadMessage }) {
  const [open, setOpen] = useState(false);
  const bodyQuery = useQuery({
    queryKey: ['case', caseId, 'gmail-body', m.id],
    queryFn: () => getGmailMessageBody(caseId, m.id),
    enabled: open,
  });
  const inbound = m.direction === 'inbound';
  const when = formatRelativeTime(m.date) || m.date;
  return (
    <div className={clsx('flex', inbound ? 'justify-start' : 'justify-end')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'max-w-[82%] rounded-2xl px-4 py-2.5 text-left text-sm shadow-sm transition-colors',
          inbound ? 'rounded-tl-sm bg-mist hover:bg-mistSoft' : 'rounded-tr-sm bg-navy/10 hover:bg-navy/15',
        )}
      >
        <div className="mb-0.5 flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold text-navyDeep">{inbound ? m.otherParty : 'Flat Rate Nexus'}</span>
          <span className="shrink-0 text-[11px] text-steel">{when}</span>
        </div>
        {m.subject ? <div className="text-xs font-medium text-steel">{m.subject}</div> : null}
        {open ? (
          bodyQuery.isLoading ? (
            <div className="mt-1 text-xs text-steel">Loading full email…</div>
          ) : bodyQuery.data?.data.available ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-slateInk">{cleanEmailText(bodyQuery.data.data.body) || <span className="text-steel">(no body captured)</span>}</div>
          ) : (
            <div className="mt-1 text-slateInk"><span className="break-words">{cleanEmailText(m.snippet)}</span><div className="mt-1 text-[11px] text-steel">Couldn’t load the full email — showing the preview.</div></div>
          )
        ) : (
          <div className="mt-0.5 break-words text-slateInk">{cleanEmailText(m.snippet)}</div>
        )}
        <div className="mt-1 text-[11px] text-navy">{open ? 'Click to collapse' : 'Click to read the full email'}</div>
      </button>
    </div>
  );
}

// Sort newest-last so the bubbles read like a chat (oldest at top). Date is an RFC-2822 header
// string; unparseable dates fall back to original order via a 0 delta.
function chronological(messages: readonly GmailThreadMessage[]): GmailThreadMessage[] {
  return [...messages].sort((a, b) => {
    const ta = Date.parse(a.date); const tb = Date.parse(b.date);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });
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
    body = <div className="space-y-3 px-3 py-3">{chronological(q.data.data.messages).map((m) => <GmailBubble key={m.id} caseId={caseId} m={m} />)}</div>;
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
  const log = rows.length > 0
    ? (
      <TabSection>
        {rows.map((e) => <EmailRow key={e.id} e={e} />)}
      </TabSection>
    )
    // Claim tab (caseId present): the live Gmail bubbles below ARE the conversation, so don't
    // stack a "No email correspondence yet" box above an obviously-populated thread (Ryan
    // 2026-06-12). Veteran tab (no caseId, no live-Gmail section) keeps the empty state so the
    // tab isn't blank.
    : caseId
      ? null
      : (
        <EmptyState
          title="No email correspondence yet"
          message={scope === 'claim'
            ? 'Emails tied to this specific claim appear here. Veteran-wide correspondence is on the veteran chart’s Email tab.'
            : 'Inbound + outbound email with this veteran appears here. If you expected messages, inbound email ingestion may not be enabled yet (ask the administrator).'}
        />
      );
  return (
    <div>
      {log}
      {caseId ? <GmailThreadSection caseId={caseId} /> : null}
    </div>
  );
}
