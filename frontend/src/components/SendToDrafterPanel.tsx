import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { getChartReadiness, type ChartReadinessBlockingFile } from '../api/chart-readiness';
import { viewDocument } from '../api/veterans';
import { postDraft, type DraftRequestInput, type DraftConcurrencyResult } from '../api/drafter';
import { ConflictError, describeApiError } from '../api/client';
import { Gate1ChecklistModal } from './Gate1ChecklistModal';
import { StrategyPreviewCard } from './StrategyPreviewCard';
import { CaseViabilityCard } from './CaseViabilityCard';
import { ManualSummaryForm } from './ManualSummaryForm';
import { documentFileName } from '../lib/documentFileName';

interface SendToDrafterPanelProps {
  readonly caseId: string;
  // When provided, "Send to Drafter" opens the Gate-1 "before we draft" checklist first.
  readonly claimType?: string;
  readonly claimedCondition?: string;
  readonly draftAttempt?: number;
  // A draft requires BOTH a physician and an RN liaison assigned (Ryan 2026-06-09). When either is
  // explicitly false the button disables + a note points to the Assignments panel. Undefined = not
  // gated (back-compat with unit tests that don't pass assignment state).
  readonly physicianAssigned?: boolean;
  readonly rnAssigned?: boolean;
}

export function SendToDrafterPanel({ caseId, claimType, claimedCondition, draftAttempt, physicianAssigned, rnAssigned }: SendToDrafterPanelProps) {
  const queryClient = useQueryClient();

  const readinessQuery = useQuery({
    queryKey: ['case', caseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(caseId),
    enabled: caseId.length > 0,
  });

  const draftMutation = useMutation({
    mutationFn: (input?: DraftRequestInput) => postDraft(caseId, input ?? {}),
    onSuccess: async (res) => {
      // Seed the queue-position panel from the 201's concurrency block so the RN sees their place in
      // line the instant the draft is queued, before the first GET /draft-concurrency poll lands.
      const concurrency = res.data.concurrency ?? null;
      queryClient.setQueryData<{ data: DraftConcurrencyResult }>(['case', caseId, 'draft-concurrency'], { data: { concurrency } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['case', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
      ]);
      // Draft started — the override note (if any) was consumed; clear it for next time.
      setOverrideOpen(false);
      setOverrideReason('');
    },
  });

  const [gate1Open, setGate1Open] = useState(false);
  // The override args (if any) to draft with AFTER Gate-1 — so the Gate-1 checklist fires on BOTH
  // the normal start AND the chart-not-ready override path (it used to skip Gate-1 on override).
  const [pendingOverride, setPendingOverride] = useState<{ acknowledgeMissingDocs: boolean; overrideReason: string } | null>(null);
  // Gate-1 "before we draft" checklist gates the start ONLY when claim context is provided
  // (real case page). Without it (e.g. unit tests), the button drafts directly (back-compat).
  const gate1Enabled = typeof claimedCondition === 'string';
  function startDraft() {
    setPendingOverride(null);
    if (gate1Enabled) setGate1Open(true);
    else draftMutation.mutate(undefined);
  }

  // Never a dead-end: when the chart isn't ready (e.g. a file couldn't be auto-read), the RN can
  // override and draft anyway with a logged reason (Ryan HARD RULE: EVERYTHING must be overridable).
  // Still runs Gate-1 first (the dx/event checklist must not be skipped just because a file was unreadable).
  //
  // The reason lives in component STATE (a controlled textarea), not window.prompt — a prompt's
  // typed text died with the dialog when the POST failed, so the RN retyped it from scratch
  // (forensics gap (b), 2026-06-11). State survives a failed mutation: the textarea is still
  // filled after the error, and one click retries.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const trimmedOverrideReason = overrideReason.trim();
  function confirmOverrideAndDraft() {
    if (trimmedOverrideReason.length === 0) return;
    const ov = { acknowledgeMissingDocs: true, overrideReason: trimmedOverrideReason };
    if (gate1Enabled) { setPendingOverride(ov); setGate1Open(true); }
    else draftMutation.mutate(ov);
  }

  const readiness = readinessQuery.data?.data;
  const ready = readiness?.ready === true;
  const blockingFiles = readiness?.blockingFiles ?? readiness?.blockers ?? [];
  const blockingFileCount = blockingFiles.length;
  // The original filename (basename of the S3 key) so the RN knows EXACTLY which file to re-upload or
  // re-OCR — a bare "1 file(s) could not be read" with no name is useless (Ryan 2026-06-06, Yorde).
  // The basename+uuid-strip lives in lib/documentFileName (shared with the RN queue — Package 1 (J)).
  const fileName = documentFileName;

  // Let the RN SEE the file that failed OCR — presign an inline view URL (same mechanism as the
  // chart's PdfViewer) and open it in a new tab, so they can read it and override with a real
  // description (Ryan 2026-06-06, Yorde: a bare "couldn't read" with no way to look is useless).
  async function openBlockingFile(id: string) {
    try {
      const res = await viewDocument(id);
      window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('Could not open the file for viewing. Try the chart Documents tab.');
    }
  }

  // Surface the server's REAL reason (Ryan HARD RULE: no dead-end generics). The 2026-06-11
  // CLM-BBFCB3F8CE incident: a 400 "Assign a physician and an RN liaison before drafting." collapsed
  // to "Please retry" — retrying was guaranteed to fail. describeApiError carries the server's own
  // message; the canned generic survives ONLY when no real reason exists.
  const draftError = draftMutation.error;
  const describedDraftError = draftError ? describeApiError(draftError) : null;
  const draftErrorMessage = draftError
    ? draftError instanceof ConflictError
      ? 'A drafter run is already in flight for this case.'
      : describedDraftError && describedDraftError !== 'unknown error'
        ? `The drafter could not be started — ${describedDraftError}`
        : 'The drafter could not be started. Please retry.'
    : null;

  // Require both reviewers assigned before drafting (Ryan 2026-06-09). Undefined props (unit tests) = not gated.
  const needsAssignment = physicianAssigned === false || rnAssigned === false;
  const missingAssignment = [physicianAssigned === false ? 'a physician' : null, rnAssigned === false ? 'an RN liaison' : null].filter(Boolean).join(' and ');
  const assignmentHint = `Assign ${missingAssignment} before drafting — use the Assignments panel below.`;

  // manual_summary_required where the file READ fine but carried almost no text (a photo, a one-line
  // fax cover). "Re-upload it or re-run OCR" is dead-end advice for this class — re-reading the same
  // near-empty image yields the same result. The right move is a brief manual summary — and the form
  // renders right here in the alert (per-file, below). The read note (classifyReadAttempt) carries
  // the class: "too-few-words (NN < threshold)". (CLM-BBFCB3F8CE fix 6; threshold 40→20 2026-06-11.)
  const isTooFewWords = (f: ChartReadinessBlockingFile): boolean => /too-few-words/i.test(f.lastAttempt?.note ?? '');
  const allTooFewWords = blockingFileCount > 0 && blockingFiles.every(isTooFewWords);

  return (
    <Card className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      {/* Pre-draft strategy preview — catch a crazy pathway before spending on a draft. While the chart is
          still scanning, the card neutralizes its checks (no premature "no dx" ✗) — chart-readiness drives it. */}
      <StrategyPreviewCard caseId={caseId} chartReady={ready} />
      {/* P4 anchor-viability pre-screen (info-light) — DARK behind EMR_CASE_VIABILITY_ENABLED
          (the GET returns null while off → renders nothing). Advisory; never gates the button. */}
      <CaseViabilityCard caseId={caseId} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-navyDeep">Send to Drafter</h2>
          <p className="mt-1 text-sm text-steel">
            Start the drafting pipeline once the chart is ready.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          disabled={!ready || needsAssignment}
          loading={draftMutation.isPending}
          onClick={startDraft}
        >
          Send to Drafter
        </Button>
      </div>
      {needsAssignment ? (
        <p className="mt-3 text-sm font-medium text-amber-700">{assignmentHint}</p>
      ) : null}

      <div className="mt-5">
        {readinessQuery.isLoading ? (
          <Spinner label="Checking chart readiness" />
        ) : readinessQuery.isError ? (
          <div className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-sm text-amber-800">
            Could not check chart readiness. Please retry.
          </div>
        ) : ready ? (
          <div className="rounded-lg border border-emerald-300 border-l-4 border-l-emerald-500 bg-emerald-50 p-4 text-sm text-emerald-800">
            Chart is ready for drafting.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 flex-none text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
              <h3 className="text-sm font-semibold text-amber-900">Chart is not ready for drafting</h3>
            </div>
            {blockingFileCount > 0 ? (
              <>
                {allTooFewWords ? (
                  <p className="mt-1 text-sm text-amber-800">
                    {blockingFileCount === 1
                      ? `This image has too little text to auto-read (${String(blockingFiles[0]?.lastAttempt?.wordCount ?? 0)} words). Open the document and add a brief manual summary below, or draft anyway.`
                      : `These ${blockingFileCount} images have too little text to auto-read. Open each document and add a brief manual summary below, or draft anyway.`}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-amber-800">
                    {blockingFileCount === 1 ? 'This file' : `These ${blockingFileCount} files`} could not be
                    automatically read. Re-upload {blockingFileCount === 1 ? 'it' : 'them'} or re-run OCR from
                    the chart, add a brief manual summary below, or draft anyway — the drafter will run
                    without {blockingFileCount === 1 ? 'it' : 'them'}.
                  </p>
                )}
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm font-medium text-amber-900">
                  {blockingFiles.map((f) => {
                    // documentId is the joined chart Document row (the link target for the presigned
                    // view); legacy payloads carried it as `id`. Either makes the name clickable.
                    const docId = f.documentId ?? f.id;
                    return (
                      <li key={docId ?? f.filePath} className="break-all">
                        {docId ? (
                          <button
                            type="button"
                            onClick={() => void openBlockingFile(docId)}
                            className="rounded underline decoration-amber-400 decoration-2 underline-offset-2 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                            title="Open this file to see what couldn't be read"
                          >
                            {fileName(f.filePath)}
                          </button>
                        ) : (
                          fileName(f.filePath)
                        )}
                        {/* The manual-summary form RIGHT AT THE ALERT (Ryan 2026-06-11: "I DONT WANT TO
                            HAVE TO GO TO DOCUMENTS... HYPERLINK IT RIGHT AT THE ALERT"). On success the
                            shared form invalidates this case's chart-readiness query → banner clears live. */}
                        {f.terminalStatus === 'manual_summary_required' && f.fileReadStatusId ? (
                          <div className="mt-2 mb-3 rounded-lg border border-amber-200 bg-white p-3 font-normal">
                            <ManualSummaryForm caseId={caseId} fileReadStatusId={f.fileReadStatusId} />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="mt-1 text-sm text-amber-800">
                {readiness?.reason ?? 'Resolve chart-readiness blockers before starting the drafter.'}
              </p>
            )}
            <div className="mt-3">
              {/* Gated on assignment exactly like the main Send button — an enabled override here
                  invited a click guaranteed to 400 (assignment_required). (CLM-BBFCB3F8CE fix 2.) */}
              {!overrideOpen ? (
                <Button type="button" variant="secondary" size="sm" className="border border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50" disabled={needsAssignment} loading={draftMutation.isPending} onClick={() => setOverrideOpen(true)}>
                  Override and draft anyway
                </Button>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-white p-3">
                  <label className="block">
                    <span className="text-sm font-medium text-amber-900">
                      Briefly describe what the unread file(s) show (e.g. &lsquo;ResMed usage report — 7.1 hrs/night, AHI 4.2&rsquo;) so it&rsquo;s logged on the case. The drafter will run without the file itself.
                    </span>
                    <textarea
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      rows={3}
                      className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      placeholder="What does the file show?"
                    />
                  </label>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setOverrideOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="button" variant="primary" size="sm" disabled={needsAssignment || trimmedOverrideReason.length === 0} loading={draftMutation.isPending} onClick={confirmOverrideAndDraft}>
                      Override and start draft
                    </Button>
                  </div>
                </div>
              )}
              {needsAssignment ? (
                <p className="mt-2 text-sm font-medium text-amber-700">{assignmentHint}</p>
              ) : null}
            </div>
          </div>
        )}

        {draftErrorMessage ? (
          <div className="mt-4 rounded-lg border border-rose-300 border-l-4 border-l-rose-500 bg-rose-50 p-4 text-sm text-rose-700">
            {draftErrorMessage}
          </div>
        ) : null}
      </div>

      {gate1Open && gate1Enabled ? (
        <Gate1ChecklistModal
          caseId={caseId}
          claimType={claimType ?? 'initial'}
          claimedCondition={claimedCondition ?? ''}
          draftAttempt={draftAttempt ?? 1}
          onClose={() => { setGate1Open(false); setPendingOverride(null); }}
          onConfirmed={(guidance) => { setGate1Open(false); draftMutation.mutate({ ...(pendingOverride ?? {}), ...(guidance ? { strategyOverride: guidance } : {}) }); setPendingOverride(null); }}
        />
      ) : null}
    </Card>
  );
}
