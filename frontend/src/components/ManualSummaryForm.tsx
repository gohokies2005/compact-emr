import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { ConflictError, describeApiError } from '../api/client';
import { postManualSummary, type FileReadAttemptSummary } from '../api/cases';

// Mirrors the backend gate in parseManualSummary (>= 40 chars, <= 10k). The helper text +
// client-side disable below communicate the requirement BEFORE submit so a short summary gets a
// clear local message, not a 400 surprise; the server message is still surfaced via
// describeApiError if anything slips through.
export const MIN_SUMMARY_CHARS = 40;
export const MAX_SUMMARY_CHARS = 10_000;

export interface ManualSummaryFormProps {
  readonly caseId: string;
  readonly fileReadStatusId: string;
  // Full read-attempt history when available (RN queue renders the "why machine reads failed"
  // block). Omit it where the host UI already explains the failure (SendToDrafterPanel alert).
  readonly attempts?: readonly FileReadAttemptSummary[];
  readonly onResolved?: () => void | Promise<void>;
}

/**
 * Shared manual-summary form — extracted from RnQueuePage (2026-06-11) so the SendToDrafterPanel
 * blocking-file alert can host it inline ("I DONT WANT TO HAVE TO GO TO DOCUMENTS... HYPERLINK IT
 * RIGHT AT THE ALERT"). On success it invalidates the case's chart-readiness query (the panel
 * banner clears live) plus the RN cross-case queue.
 */
export function ManualSummaryForm({ caseId, fileReadStatusId, attempts, onResolved }: ManualSummaryFormProps) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedLength = summary.trim().length;
  const canSubmit = trimmedLength >= MIN_SUMMARY_CHARS && trimmedLength <= MAX_SUMMARY_CHARS;

  const submit = useMutation({
    mutationFn: () => postManualSummary(caseId, fileReadStatusId, { summary: summary.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['rn', 'files-pending-manual'] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId, 'chart-readiness'] }),
      ]);
      setSummary('');
      setErrorMessage(null);
      await onResolved?.();
    },
    onError: (error: unknown) => {
      if (error instanceof ConflictError) {
        setErrorMessage('This file is no longer awaiting manual summary (another user may have cleared it).');
        return;
      }
      // Route through describeApiError like everywhere else — the server's own message (e.g. the
      // >= 40-char gate's reason) instead of a raw "Request failed with status code 400".
      setErrorMessage(`Manual summary could not be saved — ${describeApiError(error)}`);
    },
  });

  const lastAttempt = attempts && attempts.length > 0 ? attempts[attempts.length - 1] ?? null : null;

  return (
    <div className="space-y-3">
      {attempts !== undefined ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="font-medium uppercase tracking-wide text-slate-500">Why machine reads failed</div>
          {attempts.length === 0 ? (
            <p className="mt-1">No read attempts recorded yet.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {attempts.map((a, i) => (
                <li key={i}>
                  <span className="font-mono">{a.method}</span> · words={a.wordCount} · corrupted-ratio={a.corruptedTokenRatio.toFixed(3)}
                  {a.note ? <span className="text-slate-500"> · {a.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {lastAttempt && lastAttempt.note ? <p className="mt-2 italic">Last failure: {lastAttempt.note}</p> : null}
        </div>
      ) : null}

      <label className="block">
        <span className="text-sm font-medium text-slate-800">Manual summary</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={6}
          maxLength={MAX_SUMMARY_CHARS}
          className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          placeholder="Read the file and summarize the relevant content. Minimum 40 characters. Be concrete: dates, diagnoses, dispositions."
        />
        <span className="mt-1 block text-xs text-slate-500">
          {trimmedLength}/{MAX_SUMMARY_CHARS} (minimum {MIN_SUMMARY_CHARS})
        </span>
      </label>

      {errorMessage ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="primary"
          loading={submit.isPending}
          disabled={!canSubmit || submit.isPending}
          onClick={() => submit.mutate()}
        >
          Save summary
        </Button>
      </div>
    </div>
  );
}
