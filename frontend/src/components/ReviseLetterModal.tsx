import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { describeApiError } from '../api/client';

interface ReviseLetterModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  // The letter has already been paid / invoiced. Reopening for a revision does NOT change billing (no
  // re-charge, no refund) — surfaced so the RN knows a paid correction is not a new $500.
  readonly isPaid?: boolean;
  readonly isInvoiced?: boolean;
  // Reopens the delivered/paid letter into the RN-editable state with the MANDATORY note. Resolves on
  // success; rejects (and the modal surfaces the reason) on failure. The case is NOT moved unless this
  // resolves.
  readonly onSubmit: (message: string) => Promise<void>;
}

// "Revise letter" (Ryan 2026-07-03): the customer wants a couple details added to an already-delivered
// letter (e.g. reference a buddy statement). Instead of a full redraft (money-waster), the RN reopens the
// letter for a SURGICAL edit — this moves it to the RN-editable correction state. The note is MANDATORY so
// the reopen of a delivered/billed letter is never silent; the physician also sees it at re-sign. No
// billing change; the physician still re-signs + re-approves before anything re-delivers.
export function ReviseLetterModal({ open, onClose, isPaid = false, isInvoiced = false, onSubmit }: ReviseLetterModalProps) {
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const billingState = isPaid ? 'paid' : isInvoiced ? 'invoiced' : null;

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
      setErrorMessage(`Could not open the letter for revision — ${describeApiError(e)}. The case was not moved; please retry.`);
    },
  });

  if (!open) return null;

  const canSubmit = message.trim().length > 0 && !mutation.isPending;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="revise-letter-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="revise-letter-title" className="text-lg font-semibold text-slate-900">
          Revise letter
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Reopen this letter to make a surgical edit (for example, add a detail the customer asked for), then
          send it back to the physician to re-sign. This is not a redraft — the signed letter is kept as-is
          until you edit it. After you reopen it, use <span className="font-medium">Open letter editor</span>,
          make the change, then <span className="font-medium">Send corrected letter to doctor</span>.
        </p>

        {billingState ? (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            This letter has already been {billingState}. A minor correction does NOT re-charge the customer or
            change billing. Once the physician re-signs, use <span className="font-medium">Publish corrected
            letter</span> to update the customer&apos;s secure download.
          </div>
        ) : null}

        <label className="mt-5 block">
          <span className="text-sm font-medium text-slate-800">What needs to be added or changed? (required)</span>
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
            placeholder="Example: The customer asked us to reference the buddy statement from SGT Alvarez and to note that the loud snoring was corroborated by fellow servicemembers. Please add to Section IV/VI."
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
            Reopen for revision
          </Button>
        </div>
      </div>
    </div>
  );
}
