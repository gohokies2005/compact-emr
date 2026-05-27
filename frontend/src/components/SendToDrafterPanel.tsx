import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { getChartReadiness } from '../api/chart-readiness';
import { postDraft } from '../api/drafter';
import { ConflictError } from '../api/client';

interface SendToDrafterPanelProps {
  readonly caseId: string;
}

export function SendToDrafterPanel({ caseId }: SendToDrafterPanelProps) {
  const queryClient = useQueryClient();

  const readinessQuery = useQuery({
    queryKey: ['case', caseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(caseId),
    enabled: caseId.length > 0,
  });

  const draftMutation = useMutation({
    mutationFn: () => postDraft(caseId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['case', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
      ]);
    },
  });

  const readiness = readinessQuery.data?.data;
  const ready = readiness?.ready === true;
  const blockingFileCount = (readiness?.blockingFiles ?? readiness?.blockers ?? []).length;

  const draftError = draftMutation.error;
  const draftErrorMessage = draftError
    ? draftError instanceof ConflictError
      ? 'A drafter run is already in flight for this case.'
      : 'The drafter could not be started. Please retry.'
    : null;

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
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
          onClick={() => draftMutation.mutate()}
        >
          Send to Drafter
        </Button>
      </div>

      <div className="mt-5">
        {readinessQuery.isLoading ? (
          <Spinner label="Checking chart readiness" />
        ) : readinessQuery.isError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Could not check chart readiness. Please retry.
          </div>
        ) : ready ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            Chart is ready for drafting.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h3 className="text-sm font-semibold text-amber-900">Chart is not ready for drafting</h3>
            <p className="mt-1 text-sm text-amber-800">
              {blockingFileCount > 0
                ? `${blockingFileCount} file(s) need RN manual summary before drafting.`
                : (readiness?.reason ?? 'Resolve chart-readiness blockers before starting the drafter.')}
            </p>
          </div>
        )}

        {draftErrorMessage ? (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {draftErrorMessage}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
