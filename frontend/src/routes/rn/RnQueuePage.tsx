import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { ManualSummaryForm } from '../../components/ManualSummaryForm';
import {
  acknowledgeKeyDoc,
  listCases,
  listFilesPendingManualGlobal,
  listKeyDocsNeedingReview,
  type FileReadStatus,
  type KeyDocReviewRow,
} from '../../api/cases';
import { viewDocument } from '../../api/veterans';
import { formatRelativeTime } from '../../lib/date';
import { documentFileName } from '../../lib/documentFileName';

// ManualSummaryForm extracted to components/ManualSummaryForm.tsx (2026-06-11) so the
// SendToDrafterPanel blocking-file alert can render it inline too. Same behavior here.

// The human filename for a queue row: prefer the server-enriched fileName (Package 1 (J)), fall
// back to abbreviating the raw filePath (legacy payloads). documentFileName is idempotent, so
// running it over an already-stripped server name is safe.
function pendingFileName(row: FileReadStatus): string {
  return documentFileName(row.fileName ?? row.filePath);
}

// Open the pending file in a new tab via the presigned inline view — the RN must be able to SEE
// the file before summarizing it. Same mechanism as SendToDrafterPanel.openBlockingFile.
async function openPendingFile(documentId: string) {
  try {
    const res = await viewDocument(documentId);
    window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer');
  } catch {
    window.alert('Could not open the file for viewing. Try the chart Documents tab.');
  }
}

// Item 3 (2026-06-11): display-only plain-language map for the page-selector rationale codes —
// the raw codes ("unspecified_large_doc_first_8") meant nothing to the RN. Selector rationales
// often carry suffixes (`no_rules_for_doctype (dbq); include_all + RN review`), so match on
// PREFIX. All 12 codes page-selector.ts can emit are covered; anything unrecognized (e.g. the
// per-page `p1: matched …` joins) renders as "Needs review".
const SELECTOR_RATIONALE_LABELS: readonly (readonly [string, string])[] = [
  ['unspecified_small_doc_all_pages', 'Document type unknown — small file, all pages included by default'],
  ['unspecified_large_doc_first_8', 'Document type unknown — large file, only the first 8 pages included; confirm the right pages made it in'],
  ['no_rules_for_doctype', 'No selection rules exist for this document type — selection needs a human eye'],
  ['high_signal_fallback', 'Included as a best guess from content signals — confirm'],
  ['physician_override', 'Included in full at physician request'],
  ['no_per_page_text_available', 'No readable page text yet — page selection deferred'],
  ['small_doc_always_all', 'Short document type — included in full'],
  ['small_doc_shortcut', 'Small document — included in full'],
  ['default_exclude', 'Bulk record dump — excluded by default'],
  ['progress_notes_no_condition_or_recent_match', 'Progress notes — no mention of the claimed condition and no recent visit; excluded'],
  ['progress_notes_condition_or_recent', 'Progress notes — pages mentioning the claimed condition or from the most recent visit included'],
  ['benefit_summary_first_3_pages', 'Benefit summary — first 3 pages included'],
];

function selectorRationaleLabel(rationale: string | null): string {
  if (rationale !== null) {
    for (const [code, label] of SELECTOR_RATIONALE_LABELS) {
      if (rationale.startsWith(code)) return label;
    }
  }
  return 'Needs review';
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
      {rows.map((row) => {
        // Item 3: human filename (server-enriched; documentFileName fallback strips the uuid
        // prefix off legacy raw-key payloads) + presigned Open + plain-language rationale.
        const docId = row.documentId ?? null;
        return (
          <Card key={row.id}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">{row.docType}</span>
                  <span className="font-mono text-xs text-slate-500">case {row.caseId}</span>
                  <span className="text-xs text-slate-500">updated {formatRelativeTime(row.updatedAt)}</span>
                </div>
                <p className="mt-2 break-words text-sm font-medium text-slate-800">{documentFileName(row.filename ?? row.filePath)}</p>
                {/* The raw selector code rides along in the tooltip for debugging. */}
                <p className="mt-2 text-xs italic text-slate-500" title={row.selectorRationale ?? undefined}>
                  {selectorRationaleLabel(row.selectorRationale)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {docId ? (
                  <Button type="button" variant="secondary" onClick={() => void openPendingFile(docId)}>
                    Open
                  </Button>
                ) : null}
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
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// Post-sign-off release queue. After the physician approves, the case becomes `delivered` and the
// DeliveryPanel (invoice email + Stripe link + optional cover memo + final-letter upload) appears
// on the case page. This tab is the missing LIST so an RN can see every case awaiting release in
// one place rather than hunting case-by-case. (Ryan 2026-06-04: "a nurse cue ... for final
// invoice, upload and release.") Clicking a row opens the case where the release actions live.
function DeliveryReleaseQueue() {
  const navigate = useNavigate();
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
            {rows.map((c) => {
              const caseHref = `/cases/${encodeURIComponent(c.id)}`;
              return (
                <tr
                  key={c.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open case ${c.id}`}
                  onClick={() => navigate(caseHref)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(caseHref);
                    }
                  }}
                  className="cursor-pointer hover:bg-mistSoft focus:bg-mistSoft focus:outline-none"
                >
                  <td className="px-4 py-2 font-medium text-slate-900">{c.id}</td>
                  <td className="px-4 py-2 text-slate-700">{c.veteran ? `${c.veteran.lastName}, ${c.veteran.firstName}` : c.veteranId}</td>
                  <td className="px-4 py-2 text-slate-700">{c.claimedCondition}</td>
                  <td className="px-4 py-2"><CaseStatusBadge status={c.status} /></td>
                  <td className="px-4 py-2 text-slate-500">{formatRelativeTime(c.updatedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <Link className="text-indigo-600 hover:underline" to={caseHref} onClick={(e) => e.stopPropagation()}>Invoice + release</Link>
                  </td>
                </tr>
              );
            })}
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
                  const docId = row.documentId ?? null;
                  const name = pendingFileName(row);
                  return (
                    <li key={row.id}>
                      {/* Row is a div[role=button] (selection), NOT a <button>, so the filename can be a
                          real nested button (presigned open) without invalid button-in-button HTML —
                          same pattern as DeliveryReleaseQueue's clickable rows. */}
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Select ${name}`}
                        onClick={() => setSelectedId(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(row.id);
                          }
                        }}
                        className={`w-full cursor-pointer rounded-lg border p-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                          isActive
                            ? 'border-indigo-300 bg-indigo-50 text-indigo-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {row.veteranName ? (
                          <div className="font-medium text-slate-900">
                            {row.veteranName}
                            {row.claimedCondition ? <span className="font-normal text-slate-500"> · {row.claimedCondition}</span> : null}
                          </div>
                        ) : null}
                        <div className={`font-mono text-xs text-slate-500 ${row.veteranName ? 'mt-1' : ''}`}>case {row.caseId}</div>
                        <div className="mt-1 break-words">
                          {docId ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void openPendingFile(docId);
                              }}
                              className="rounded text-left underline decoration-slate-300 decoration-2 underline-offset-2 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                              title="Open this file (presigned view)"
                            >
                              {name}
                            </button>
                          ) : (
                            name
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          Awaiting since {formatRelativeTime(row.lastCheckedAt)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card className="lg:col-span-2">
              {selected ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-800">
                      {selected.documentId ? (
                        <button
                          type="button"
                          onClick={() => {
                            const docId = selected.documentId;
                            if (docId) void openPendingFile(docId);
                          }}
                          className="rounded text-left underline decoration-slate-300 decoration-2 underline-offset-2 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                          title="Open this file (presigned view)"
                        >
                          {pendingFileName(selected)}
                        </button>
                      ) : (
                        pendingFileName(selected)
                      )}
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                      {selected.veteranName ? `${selected.veteranName} · ` : ''}
                      Case {selected.caseId}
                      {selected.claimedCondition ? ` · ${selected.claimedCondition}` : ''}
                      {' '}· awaiting manual summary since {formatRelativeTime(selected.lastCheckedAt)}
                    </p>
                  </div>
                  <ManualSummaryForm
                    caseId={selected.caseId}
                    fileReadStatusId={selected.id}
                    attempts={selected.attemptsJson}
                    onResolved={async () => { setSelectedId(null); }}
                  />
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
