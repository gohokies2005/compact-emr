import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { ConflictError } from '../../api/client';
import {
  listFilesPendingManualGlobal,
  postManualSummary,
  type FileReadStatus,
} from '../../api/cases';
import { formatRelativeTime } from '../../lib/date';

const MIN_SUMMARY_CHARS = 40;
const MAX_SUMMARY_CHARS = 10_000;

function lastAttempt(row: FileReadStatus) {
  if (row.attemptsJson.length === 0) return null;
  return row.attemptsJson[row.attemptsJson.length - 1] ?? null;
}

interface ManualSummaryFormProps {
  readonly row: FileReadStatus;
  readonly onResolved: () => void | Promise<void>;
}

function ManualSummaryForm({ row, onResolved }: ManualSummaryFormProps) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedLength = summary.trim().length;
  const canSubmit = trimmedLength >= MIN_SUMMARY_CHARS && trimmedLength <= MAX_SUMMARY_CHARS;

  const submit = useMutation({
    mutationFn: () => postManualSummary(row.caseId, row.id, { summary: summary.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['rn', 'files-pending-manual'] }),
        queryClient.invalidateQueries({ queryKey: ['case', row.caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', row.caseId, 'chart-readiness'] }),
      ]);
      setSummary('');
      setErrorMessage(null);
      await onResolved();
    },
    onError: (error: unknown) => {
      if (error instanceof ConflictError) {
        setErrorMessage('This file is no longer awaiting manual summary (another user may have cleared it).');
        return;
      }
      const detail = error instanceof Error ? error.message : 'Manual summary could not be saved. Please retry.';
      setErrorMessage(detail);
    },
  });

  const attempt = lastAttempt(row);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        <div className="font-medium uppercase tracking-wide text-slate-500">Why machine reads failed</div>
        {row.attemptsJson.length === 0 ? (
          <p className="mt-1">No read attempts recorded yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {row.attemptsJson.map((a, i) => (
              <li key={i}>
                <span className="font-mono">{a.method}</span> · words={a.wordCount} · corrupted-ratio={a.corruptedTokenRatio.toFixed(3)}
                {a.note ? <span className="text-slate-500"> · {a.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {attempt && attempt.note ? <p className="mt-2 italic">Last failure: {attempt.note}</p> : null}
      </div>

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

export function RnQueuePage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: ['rn', 'files-pending-manual'],
    queryFn: () => listFilesPendingManualGlobal(50),
  });

  if (queueQuery.isLoading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading manual-summary queue
        </div>
      </AppShell>
    );
  }

  const rows = queueQuery.data?.data ?? [];
  const total = queueQuery.data?.total ?? 0;
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Manual-summary queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Files that no OCR method could read. Each row blocks downstream work for its case
            until an RN provides a manual summary of at least 40 characters.
          </p>
          <p className="mt-2 text-xs text-slate-400">{total} file(s) pending across all cases.</p>
        </div>

        {rows.length === 0 ? (
          <EmptyState title="Queue is clear" message="No files are currently awaiting manual interpretation. The OCR worker has successfully read every uploaded record." />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <h2 className="text-base font-semibold text-slate-800">Pending files</h2>
              <ul className="mt-3 space-y-2">
                {rows.map((row) => {
                  const isActive = row.id === selectedId;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(row.id)}
                        className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                          isActive
                            ? 'border-indigo-300 bg-indigo-50 text-indigo-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div className="font-mono text-xs text-slate-500">case {row.caseId}</div>
                        <div className="mt-1 break-words">{row.filePath}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          Awaiting since {formatRelativeTime(row.lastCheckedAt)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card className="lg:col-span-2">
              {selected ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-800">{selected.filePath}</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Case {selected.caseId} · awaiting manual summary since {formatRelativeTime(selected.lastCheckedAt)}
                    </p>
                  </div>
                  <ManualSummaryForm row={selected} onResolved={async () => { setSelectedId(null); }} />
                </div>
              ) : (
                <EmptyState title="Select a file" message="Pick a row from the left to read its read-attempt history and write a manual summary." />
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
