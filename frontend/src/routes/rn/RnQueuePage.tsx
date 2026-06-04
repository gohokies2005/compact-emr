import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { ConflictError } from '../../api/client';
import {
  acknowledgeKeyDoc,
  listCases,
  listFilesPendingManualGlobal,
  listKeyDocsNeedingReview,
  postManualSummary,
  type FileReadStatus,
  type KeyDocReviewRow,
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

function KeyDocReviewQueue() {
  const queryClient = useQueryClient();
  const reviewQuery = useQuery({
    queryKey: ['rn', 'key-docs-needing-review'],
    queryFn: () => listKeyDocsNeedingReview(50),
  });

  const ackMutation = useMutation({
    mutationFn: (keyDocId: string) => acknowledgeKeyDoc(keyDocId, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rn', 'key-docs-needing-review'] });
    },
  });

  if (reviewQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading review queue
      </div>
    );
  }

  const rows = reviewQuery.data?.data ?? [];
  const total = reviewQuery.data?.total ?? 0;

  if (rows.length === 0) {
    return <EmptyState title="Nothing to review" message="The page-selector ran clean on every Doctor Pack — no docs flagged for human verification." />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">{total} doc(s) flagged for RN selection review across all cases.</p>
      {rows.map((row) => (
        <Card key={row.id}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">{row.docType}</span>
                <span className="font-mono text-xs text-slate-500">case {row.caseId}</span>
                <span className="text-xs text-slate-500">updated {formatRelativeTime(row.updatedAt)}</span>
              </div>
              <p className="mt-2 break-words text-sm text-slate-800">{row.filePath}</p>
              {row.selectorRationale ? (
                <p className="mt-2 text-xs italic text-slate-500">Selector rationale: {row.selectorRationale}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="primary"
              loading={ackMutation.isPending && ackMutation.variables === row.id}
              disabled={ackMutation.isPending}
              onClick={() => ackMutation.mutate(row.id)}
            >
              Mark reviewed
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// Post-sign-off release queue. After the physician approves, the case becomes `delivered` and the
// DeliveryPanel (invoice email + Stripe link + optional cover memo + final-letter upload) appears
// on the case page. This tab is the missing LIST so an RN can see every case awaiting release in
// one place rather than hunting case-by-case. (Ryan 2026-06-04: "a nurse cue ... for final
// invoice, upload and release.") Clicking a row opens the case where the release actions live.
function DeliveryReleaseQueue() {
  const queueQuery = useQuery({
    queryKey: ['rn', 'release-queue'],
    queryFn: () => listCases({ status: 'delivered', page: 1, pageSize: 50 }),
  });
  const rows = queueQuery.data?.data ?? [];

  if (queueQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Loading release queue
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState title="Nothing to release" message="No signed-off cases are waiting for invoice + release. Cases appear here once the physician approves the letter." />;
  }
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 p-4 text-sm text-slate-600">
        <p className="font-medium text-slate-800">Signed off — ready to invoice + release.</p>
        <p className="mt-1 text-xs text-slate-500">Open a case to send the invoice email + Stripe link, attach the cover memo, and release the final letter.</p>
      </div>
      <div className="overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Case</th>
              <th className="px-4 py-2">Veteran</th>
              <th className="px-4 py-2">Condition</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Signed off</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2 font-medium text-slate-900">{c.id}</td>
                <td className="px-4 py-2 text-slate-700">{c.veteran ? `${c.veteran.lastName}, ${c.veteran.firstName}` : c.veteranId}</td>
                <td className="px-4 py-2 text-slate-700">{c.claimedCondition}</td>
                <td className="px-4 py-2"><CaseStatusBadge status={c.status} /></td>
                <td className="px-4 py-2 text-slate-500">{formatRelativeTime(c.updatedAt)}</td>
                <td className="px-4 py-2 text-right">
                  <Link className="text-indigo-600 hover:underline" to={`/cases/${encodeURIComponent(c.id)}`}>Invoice + release</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type QueueTab = 'manual_summary' | 'doc_review' | 'release';

export function RnQueuePage() {
  const [tab, setTab] = useState<QueueTab>('manual_summary');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: ['rn', 'files-pending-manual'],
    queryFn: () => listFilesPendingManualGlobal(50),
    enabled: tab === 'manual_summary',
  });

  if (queueQuery.isLoading && tab === 'manual_summary') {
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
          <h1 className="text-2xl font-semibold text-slate-900">RN queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Streams of work waiting on RN attention. Pick a tab; each runs independently.
          </p>
        </div>

        <div className="flex gap-2 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setTab('manual_summary')}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === 'manual_summary' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            Manual summary{tab === 'manual_summary' && total > 0 ? ` (${total})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setTab('doc_review')}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === 'doc_review' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            Doc selection review
          </button>
          <button
            type="button"
            onClick={() => setTab('release')}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === 'release' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            Invoice + release
          </button>
        </div>

        {tab === 'doc_review' ? (
          <KeyDocReviewQueue />
        ) : null}

        {tab === 'release' ? (
          <DeliveryReleaseQueue />
        ) : null}

        {tab === 'manual_summary' ? (
          <>
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
              <p className="font-medium text-slate-800">Files that no OCR method could read.</p>
              <p className="mt-1 text-sm text-slate-500">
                Each row blocks downstream work for its case until an RN provides a manual summary of at least 40 characters.
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
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
