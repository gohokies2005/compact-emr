import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { WhatChangedPanel } from './WhatChangedPanel';
import { getLetterChangesSinceSigned } from '../api/cases';
import { listCaseMessages, type CaseMessage } from '../api/case-messages';

/**
 * "This letter came back for a revision" pop-up (Ryan 2026-07-03). When a physician OPENS a case that an
 * RN sent back with a surgical correction, this auto-appears — surfacing WHY it came back (the care-team
 * note) and WHAT CHANGED (the deterministic diff) up front, instead of the physician having to click Sign
 * off to see the diff or hunt for the reason under the handoff notes.
 *
 * It auto-opens ONLY when there are unsigned changes vs the last-signed version (a real correction) —
 * changes-since-signed returns available:false / changed:false on a first-time review, so this never fires
 * on a normal draft. Dismissable; the diff also remains inside the sign-off popup and the notes panel.
 */

function roleLabel(role: CaseMessage['senderRole']): string {
  return role === 'physician' ? 'Physician' : 'Care team (RN)';
}
function senderLabel(m: Pick<CaseMessage, 'senderName' | 'senderRole'>): string {
  const name = m.senderName?.trim();
  return name ? `${name} · ${roleLabel(m.senderRole)}` : roleLabel(m.senderRole);
}

export function ReviewChangesPopup({ caseId }: { readonly caseId: string }) {
  const changesQ = useQuery({
    queryKey: ['case', caseId, 'changes-since-signed'],
    queryFn: () => getLetterChangesSinceSigned(caseId),
    staleTime: 0,
    enabled: caseId.length > 0,
  });
  const messagesQ = useQuery({
    queryKey: ['case-messages', caseId],
    queryFn: () => listCaseMessages(caseId),
    staleTime: 30_000,
    enabled: caseId.length > 0,
  });

  const d = changesQ.data?.data;
  const hasChanges = d?.available === true && d.changed === true;

  // Auto-open once the change data confirms a real correction. Dismiss is per-mount, so re-opening the
  // case pops it again (the intended "it's right there when you open it" behavior), and once the physician
  // re-signs the case leaves physician_review → changed:false → it stops.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (hasChanges) setDismissed(false);
  }, [hasChanges]);

  if (!hasChanges || dismissed) return null;

  // The most recent care-team note = why the case came back for revision.
  const messages = messagesQ.data?.data ?? [];
  const latestNote = messages.length > 0
    ? [...messages].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
    : null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="review-changes-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="review-changes-title" className="text-lg font-semibold text-slate-900">
              This letter came back for a revision
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              The care team made a surgical edit and returned it for your signature. Here is why, and exactly what changed.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDismissed(true)}>Close</Button>
        </div>

        {latestNote ? (
          <div className="mt-4 rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Reason it came back</p>
            <p className="mt-1 text-[11px] text-amber-700">{senderLabel(latestNote)}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-amber-950">{latestNote.body}</p>
          </div>
        ) : null}

        <div className="mt-4">
          <WhatChangedPanel caseId={caseId} open />
        </div>

        <div className="mt-6 flex justify-end">
          <Button type="button" variant="primary" onClick={() => setDismissed(true)}>Review and sign</Button>
        </div>
      </div>
    </div>
  );
}
