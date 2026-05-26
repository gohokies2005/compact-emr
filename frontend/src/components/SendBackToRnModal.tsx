import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { sendBackToRn } from '../api/drafter';
import type { CaseStatus } from '../types/prisma';

interface SendBackToRnModalProps {
  readonly caseId: string;
  readonly veteranId: string;
  readonly from: CaseStatus;
  readonly version: number;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void | Promise<void>;
}

export function SendBackToRnModal({
  caseId,
  veteranId,
  from,
  version,
  open,
  onClose,
  onDone,
}: SendBackToRnModalProps) {
  const [note, setNote] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      sendBackToRn({
        caseId,
        veteranId,
        from,
        version,
        ...(note.trim() && { note: note.trim() }),
      }),
    onSuccess: async () => {
      setNote('');
      setErrorMessage(null);
      await onDone();
      onClose();
    },
    onError: () => {
      setErrorMessage('The case could not be sent back. Please retry.');
    },
  });

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="send-back-rn-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="send-back-rn-title" className="text-lg font-semibold text-slate-900">
          Send back for major rework
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Choose this only if you want a different overall strategy, not for small edits. If you
          want to tweak the letter directly, use Edit text instead.
        </p>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-slate-800">
            Tell the RN what to change about the overall approach (optional)
          </span>
          <textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setErrorMessage(null);
            }}
            rows={5}
            maxLength={5000}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Example: Rework the overall theory around aggravation rather than direct service connection."
          />
          <span className="mt-1 block text-xs text-slate-500">{note.length}/5000</span>
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
            Send back
          </Button>
        </div>
      </div>
    </div>
  );
}
