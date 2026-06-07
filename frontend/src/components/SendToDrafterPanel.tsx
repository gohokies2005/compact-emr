import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { getChartReadiness } from '../api/chart-readiness';
import { postDraft, type DraftRequestInput } from '../api/drafter';
import { ConflictError } from '../api/client';
import { Gate1ChecklistModal } from './Gate1ChecklistModal';
import { StrategyPreviewCard } from './StrategyPreviewCard';

interface SendToDrafterPanelProps {
  readonly caseId: string;
  // When provided, "Send to Drafter" opens the Gate-1 "before we draft" checklist first.
  readonly claimType?: string;
  readonly claimedCondition?: string;
  readonly draftAttempt?: number;
}

export function SendToDrafterPanel({ caseId, claimType, claimedCondition, draftAttempt }: SendToDrafterPanelProps) {
  const queryClient = useQueryClient();

  const readinessQuery = useQuery({
    queryKey: ['case', caseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(caseId),
    enabled: caseId.length > 0,
  });

  const draftMutation = useMutation({
    mutationFn: (input?: DraftRequestInput) => postDraft(caseId, input ?? {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['case', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
      ]);
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
  function overrideAndDraft() {
    const reason = window.prompt('Draft anyway? Type a brief reason (logged on the case). The drafter will run without the file(s) that could not be read.');
    if (reason === null || reason.trim().length === 0) return;
    const ov = { acknowledgeMissingDocs: true, overrideReason: reason.trim() };
    if (gate1Enabled) { setPendingOverride(ov); setGate1Open(true); }
    else draftMutation.mutate(ov);
  }

  const readiness = readinessQuery.data?.data;
  const ready = readiness?.ready === true;
  const blockingFiles = readiness?.blockingFiles ?? readiness?.blockers ?? [];
  const blockingFileCount = blockingFiles.length;
  // The original filename (basename of the S3 key) so the RN knows EXACTLY which file to re-upload or
  // re-OCR — a bare "1 file(s) could not be read" with no name is useless (Ryan 2026-06-06, Yorde).
  const fileName = (filePath: string): string => filePath.split('/').pop() || filePath;

  const draftError = draftMutation.error;
  const draftErrorMessage = draftError
    ? draftError instanceof ConflictError
      ? 'A drafter run is already in flight for this case.'
      : 'The drafter could not be started. Please retry.'
    : null;

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      {/* Pre-draft strategy preview — catch a crazy pathway before spending on a draft. */}
      <StrategyPreviewCard caseId={caseId} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Send to Drafter</h2>
          <p className="mt-1 text-sm text-slate-600">
            Start the drafting pipeline once the chart is ready.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          disabled={!ready}
          loading={draftMutation.isPending}
          onClick={startDraft}
        >
          Send to Drafter
        </Button>
      </div>

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
                <p className="mt-1 text-sm text-amber-800">
                  {blockingFileCount === 1 ? 'This file' : `These ${blockingFileCount} files`} could not be
                  automatically read. Re-upload {blockingFileCount === 1 ? 'it' : 'them'} or re-run OCR from
                  the chart, or draft anyway — the drafter will run without {blockingFileCount === 1 ? 'it' : 'them'}.
                </p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm font-medium text-amber-900">
                  {blockingFiles.map((f) => (
                    <li key={f.id ?? f.filePath} className="break-all">{fileName(f.filePath)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-1 text-sm text-amber-800">
                {readiness?.reason ?? 'Resolve chart-readiness blockers before starting the drafter.'}
              </p>
            )}
            <div className="mt-3">
              <Button type="button" variant="secondary" size="sm" className="border border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50" loading={draftMutation.isPending} onClick={overrideAndDraft}>
                Override and draft anyway
              </Button>
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
