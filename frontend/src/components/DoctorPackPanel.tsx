import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { generateDoctorPack, getDoctorPackPdfUrl, getLatestDoctorPack, type DoctorPack } from '../api/doctorPack';
import { describeApiError } from '../api/client';
import { useAuth } from '../auth/useAuth';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

// "Abridged notes and records" — JUST the action buttons (Ryan 2026-06-12: "just have those
// buttons; remove the title/subtitle, the NOT INCLUDED notes, and the whole document list — that
// clutter belongs in the Documents tab"). Open + Regenerate. Regenerate is RN/admin-only; the
// physician is view-only. The pack auto-generates when the records finish parsing.
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set(['queued', 'generating']);

export function DoctorPackPanel({ caseId }: { readonly caseId: string }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canGenerate = role === 'admin' || role === 'ops_staff';

  const packQuery = useQuery({
    queryKey: ['case', caseId, 'doctor-pack', 'latest'],
    queryFn: () => getLatestDoctorPack(caseId),
    enabled: caseId.length > 0,
    // Poll only while assembling; stop on any terminal state (ready/failed/null).
    refetchInterval: (query) => {
      const state = query.state.data?.data?.state;
      return state !== undefined && IN_FLIGHT_STATES.has(state) ? 5000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const generate = useMutation({
    mutationFn: () => generateDoctorPack(caseId),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['case', caseId, 'doctor-pack', 'latest'] }); },
    onError: (e: unknown) => window.alert(`Could not generate the abridged notes — ${describeApiError(e)}`),
  });

  const openPdf = async (pack: DoctorPack) => {
    try {
      const { data } = await getDoctorPackPdfUrl(caseId, pack.id);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      window.alert(`Could not open the abridged notes PDF — ${describeApiError(e)}`);
    }
  };

  const pack = packQuery.data?.data ?? null;
  if (packQuery.isLoading) return null;

  if (pack === null) {
    return canGenerate ? (
      <Button type="button" variant="secondary" size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
        Generate abridged notes
      </Button>
    ) : (
      <p className="text-sm text-slate-500">No abridged notes yet — ask your RN to generate them.</p>
    );
  }
  if (IN_FLIGHT_STATES.has(pack.state)) {
    return <Spinner label={`Abridged notes ${pack.state === 'queued' ? 'queued' : 'generating'}…`} />;
  }
  if (pack.state === 'failed') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
        <span className="font-semibold">Abridged notes generation failed</span>
        {/* NO-SILENT-ERRORS: the worker's real cause, verbatim. */}
        <span className="whitespace-pre-wrap">{pack.errorMessage ?? 'No error message was recorded.'}</span>
        {canGenerate ? (
          <Button type="button" variant="secondary" size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>Regenerate abridged notes</Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="primary" size="sm" onClick={() => void openPdf(pack)}>
        Open abridged notes ({pack.pageCount ?? '?'}pp)
      </Button>
      {canGenerate ? (
        <Button type="button" variant="secondary" size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>Regenerate abridged notes</Button>
      ) : null}
      {packQuery.isError ? <span className="text-sm text-rose-700">Could not load — {describeApiError(packQuery.error)}</span> : null}
    </div>
  );
}
