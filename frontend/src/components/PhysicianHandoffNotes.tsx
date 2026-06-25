import { useQuery } from '@tanstack/react-query';
import { listCaseMessages, type CaseMessage } from '../api/case-messages';

// Physician-facing RN→doctor handoff notes (Ryan 2026-06-24, Spring bug). THE BUG IT FIXES: when an RN
// sends a case to the physician with a note (SendToDoctorModal → createCaseMessage), that note is written
// to the flat case_messages table — but the ONLY message UI (CaseMessagesPanel) renders the SEPARATE
// threads system (getCaseThreads), and PhysicianReviewPage rendered no message UI at all. So the RN's note
// ("I put in a message to go with Spring's letter") was persisted to a table NO screen read → invisible to
// the doctor. The data path is fine and the backend already authorizes the assigned physician to read it
// (GET /cases/:id/messages); this just RENDERS it on the physician's primary surface.
//
// READ-ONLY by design (for now): the RN side currently uses the threads UI, not this flat thread, so a
// physician reply here would not surface to the RN — showing a reply box would be misleading. The two
// messaging systems (flat case_messages ↔ threads) are unified in a separate, planned restructure; until
// then this guarantees the physician at least SEES the RN's handoff note. Renders nothing when there are
// no notes (no empty clutter on the review page). Fail-open: a fetch error simply hides the panel.

function roleLabel(role: CaseMessage['senderRole']): string {
  return role === 'physician' ? 'Physician' : 'Care team (RN)';
}

// Prefer the server-resolved author NAME (never a raw UUID); fall back to the role label when the
// backend could not resolve a name (older rows / missing account). Ryan 2026-06-24: RNs must see the
// person's name, not a Cognito sub.
function senderLabel(m: Pick<CaseMessage, 'senderName' | 'senderRole'>): string {
  const name = m.senderName?.trim();
  if (name) return `${name} · ${roleLabel(m.senderRole)}`;
  return roleLabel(m.senderRole);
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function PhysicianHandoffNotes({ caseId }: { readonly caseId: string }) {
  const q = useQuery({
    queryKey: ['case-messages', caseId],
    queryFn: () => listCaseMessages(caseId),
    staleTime: 30_000,
  });

  const messages = q.data?.data ?? [];
  // Hide entirely when there is nothing to show (loading, errored, or genuinely no notes) — never an empty box.
  if (messages.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Notes from the care team</h2>
      <p className="mt-0.5 text-xs text-slate-500">Sent with this case for your review.</p>
      <ul className="mt-3 space-y-3">
        {messages.map((m) => (
          <li key={m.id} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">{senderLabel(m)}</span>
              <span className="text-[11px] text-slate-400">{formatWhen(m.createdAt)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{m.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
