import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { describeApiError } from '../api/client';

interface ReturnToPhysicianModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  // Performs the delivered -> physician_review return with the MANDATORY message. Resolves on success;
  // rejects (and the modal surfaces the reason) on failure. The case is NOT moved unless this resolves.
  readonly onSubmit: (message: string) => Promise<void>;
}

// "Return to physician" (Item 1, 2026-06-28): the RN caught an error on a FINALIZED, physician-signed
// letter that's already "Ready for delivery", and is sending it back to the doctor to re-review, edit, and
// re-sign. Unlike the normal send-to-doctor handoff (where the note is OPTIONAL), the message here is
// MANDATORY — the doctor must know WHY a finalized letter came back. The transition + the message are
// written atomically server-side, so a network/validation failure leaves the case untouched (no half-move).
export function ReturnToPhysicianModal({ open, onClose, onSubmit }: ReturnToPhysicianModalProps) {
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      await onSubmit(message.trim());
    },
    onSuccess: () => {
      setMessage('');
      setErrorMessage(null);
      onClose();
    },
    onError: (e: unknown) => {
      setErrorMessage(`Could not return the letter — ${describeApiError(e)}. The case was not moved; please retry.`);
    },
  });

  if (!open) return null;

  const canSubmit = message.trim().length > 0 && !mutation.isPending;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="return-to-physician-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="return-to-physician-title" className="text-lg font-semibold text-slate-900">
          Return to physician
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          This sends the finalized letter back to the assigned physician so they can re-review, edit, and
          re-sign. The signed letter is kept as-is — returning only re-opens the doctor&apos;s review.
          Explain what needs another look; the physician sees your note when they open the case.
        </p>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-slate-800">Why are you returning it? (required)</span>
          <textarea
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setErrorMessage(null);
            }}
            rows={5}
            maxLength={4000}
            autoFocus
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Example: The veteran's service end year is wrong in the second paragraph — it should read 2004, not 2014. Please correct and re-sign."
          />
          <span className="mt-1 block text-xs text-slate-500">{message.length}/4000</span>
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
            disabled={!canSubmit}
            onClick={() => mutation.mutate()}
          >
            Return to physician
          </Button>
        </div>
      </div>
    </div>
  );
}
