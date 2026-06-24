import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { createCaseMessage } from '../api/case-messages';
import { describeApiError } from '../api/client';

interface SendToDoctorModalProps {
  readonly caseId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  // Performs the actual transition into physician_review (rn_review -> physician_review, or the
  // halted-letter forward). The modal handles the OPTIONAL handoff message first, then calls this.
  readonly onConfirm: () => Promise<void>;
}

// "Send to doctor for review" prompt (Ryan 2026-06-24 + the 2026-06-21 handoff-message spec): a
// message box ALWAYS comes up on send, but it is OPTIONAL — type a note and it posts to the case's
// RN↔physician thread (so the doctor sees it), or send with the box empty and it behaves exactly as
// the old bare confirm did. The message is posted BEFORE the transition so a failed post never
// strands a "sent" case without its note (the error is surfaced and the case is NOT moved).
export function SendToDoctorModal({ caseId, open, onClose, onConfirm }: SendToDoctorModalProps) {
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = message.trim();
      if (body) await createCaseMessage(caseId, { body });
      await onConfirm();
    },
    onSuccess: () => {
      setMessage('');
      setErrorMessage(null);
      onClose();
    },
    onError: (e: unknown) => {
      setErrorMessage(`Could not send to the doctor — ${describeApiError(e)}. The case was not moved; please retry.`);
    },
  });

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="send-to-doctor-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="send-to-doctor-title" className="text-lg font-semibold text-slate-900">
          Send to doctor for review
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          The doctor reviews and signs before anything is delivered. Add a note for the reviewing
          physician if you have one — it&apos;s optional, and you can send without it.
        </p>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-slate-800">Message to the doctor (optional)</span>
          <textarea
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setErrorMessage(null);
            }}
            rows={5}
            maxLength={5000}
            autoFocus
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Example: Reviewed and edited — the §VII opinion is tightened. Flagging the 1996 weight note as the key in-service hook."
          />
          <span className="mt-1 block text-xs text-slate-500">{message.length}/5000</span>
        </label>

        {errorMessage ? (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={mutation.isPending}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {message.trim() ? 'Send with message' : 'Send to doctor'}
          </Button>
        </div>
      </div>
    </div>
  );
}
