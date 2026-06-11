import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  generateDoctorPack,
  getDoctorPackPdfUrl,
  getLatestDoctorPack,
  listKeyDocs,
  type DoctorPack,
  type KeyDoc,
} from '../api/doctorPack';
import { describeApiError } from '../api/client';
import { useAuth } from '../auth/useAuth';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Spinner } from './ui/Spinner';

// Chunk D (2026-06-11): Doctor Pack surface — the physician's curated 10-15pp chart abridgement.
// Mounted on PhysicianReviewPage (between the letter panel and Ask Aegis) and on the staff
// CaseDetailPage (next to Ask Aegis). Two parts:
//   (a) the all-documents list (key-docs classification: what the selector kept per file)
//   (b) the pack itself: ready -> open presigned PDF; queued/generating -> poll; failed ->
//       the REAL errorMessage verbatim + Regenerate (NO-SILENT-ERRORS); none -> see below;
//       physician always view-only ("ask your RN" — D-2: generation stays RN/admin; the POST
//       role guard is authoritative — hiding the button just keeps the dead-end off-screen).
//
// Package 7 (2026-06-11): the pack AUTO-GENERATES when the RN sends the case to the doctor
// (the rn_review -> physician_review status transition fires the same generate service). The
// staff null-state therefore explains the automation instead of pushing a primary Generate CTA;
// a small secondary "Generate now" stays as the edge-case escape hatch (early pack for a chart
// still in review, recovery when the auto-fire was skipped/logged-warn). Regenerate remains on
// the failed state (and on ready, for a changed chart).

const DOC_TYPE_LABELS: Readonly<Record<string, string>> = {
  dd_214: 'DD-214',
  rating_decision: 'Rating decision',
  denial_letter: 'Denial letter',
  supplemental_decision: 'Supplemental decision',
  rated_disabilities_view: 'Rated disabilities',
  benefit_summary: 'Benefit summary',
  dbq: 'DBQ',
  c_and_p_exam: 'C&P exam',
  tera_memo: 'TERA memo',
  individual_exposure_summary: 'Exposure summary',
  nexus_letter_prior: 'Prior nexus letter',
  medical_opinion: 'Medical opinion',
  audiogram: 'Audiogram',
  sleep_study: 'Sleep study',
  pulmonary_function_test: 'Pulmonary function test',
  service_treatment_record_summary: 'Service treatment records',
  separation_exam: 'Separation exam',
  entrance_exam: 'Entrance exam',
  personnel_record: 'Personnel record',
  statement_in_support: 'Statement in support',
  lay_statement: 'Lay statement',
  buddy_statement: 'Buddy statement',
  blue_button: 'Blue Button dump',
  progress_notes: 'Progress notes',
  imaging: 'Imaging / radiology',
  intake_summary: 'Intake summary',
  unspecified: 'Unclassified',
};

function docTypeLabel(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType;
}

function selectedPageCount(doc: KeyDoc): number {
  return doc.pageRanges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0);
}

function baseName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  // Uploaded keys are `cases/<caseId>/<uuid>-<filename>`; show just the filename.
  return base.replace(/^[a-f0-9-]{36}-/, '');
}

function ImportanceChip({ doc }: { readonly doc: KeyDoc }) {
  const tier = doc.classification;
  const cls =
    tier === 'high_signal'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : tier === 'bulk'
        ? 'bg-slate-100 text-slate-500 border-slate-200'
        : 'bg-sky-50 text-sky-700 border-sky-200';
  const label = tier === 'high_signal' ? 'High signal' : tier === 'bulk' ? 'Bulk' : 'Standard';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label} · {doc.importance}
    </span>
  );
}

function KeyDocRow({ doc }: { readonly doc: KeyDoc }) {
  const selected = selectedPageCount(doc);
  const total = doc.docPageCount;
  const pagesText = total !== null && total > 0 ? `${selected} of ${total} pages` : `${selected} page${selected === 1 ? '' : 's'}`;
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium text-slate-800">{doc.filename ?? baseName(doc.filePath)}</div>
        <div className="text-xs text-slate-500">{docTypeLabel(doc.docType)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ImportanceChip doc={doc} />
        <span className={`text-xs ${selected === 0 ? 'text-slate-400' : 'text-slate-600'}`}>
          {selected === 0 ? 'not included' : pagesText}
        </span>
      </div>
    </div>
  );
}

const IN_FLIGHT_STATES: ReadonlySet<string> = new Set(['queued', 'generating']);

export function DoctorPackPanel({ caseId }: { readonly caseId: string }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canGenerate = role === 'admin' || role === 'ops_staff';

  const packQuery = useQuery({
    queryKey: ['case', caseId, 'doctor-pack', 'latest'],
    queryFn: () => getLatestDoctorPack(caseId),
    enabled: caseId.length > 0,
    // Poll while assembling; the stuck-pack watcher flips stuck->failed within ~15min, so the
    // spinner can never live forever. Stop on any terminal state (ready/failed/null).
    refetchInterval: (query) => {
      const state = query.state.data?.data?.state;
      return state !== undefined && IN_FLIGHT_STATES.has(state) ? 5000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const keyDocsQuery = useQuery({
    queryKey: ['case', caseId, 'key-docs'],
    queryFn: () => listKeyDocs(caseId),
    enabled: caseId.length > 0,
  });

  const generate = useMutation({
    mutationFn: () => generateDoctorPack(caseId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['case', caseId, 'doctor-pack', 'latest'] });
      await qc.invalidateQueries({ queryKey: ['case', caseId, 'key-docs'] });
    },
    onError: (e: unknown) => window.alert(`Could not generate the Doctor Pack — ${describeApiError(e)}`),
  });

  const openPdf = async (pack: DoctorPack) => {
    try {
      const { data } = await getDoctorPackPdfUrl(caseId, pack.id);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      window.alert(`Could not open the Doctor Pack PDF — ${describeApiError(e)}`);
    }
  };

  const pack = packQuery.data?.data ?? null;
  const keyDocs = keyDocsQuery.data?.data ?? [];

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Doctor Pack</h2>
      <p className="text-sm text-slate-500">
        Curated chart abridgement for the reviewing physician — SC decisions, recent pertinent
        notes and imaging, statements, in-service records.
      </p>

      <div className="mt-4">
        {packQuery.isLoading ? (
          <Spinner label="Loading Doctor Pack" />
        ) : pack === null ? (
          canGenerate ? (
            <div>
              <p className="text-sm text-slate-500">
                No Doctor Pack yet — it will generate automatically when the case is sent to the doctor.
              </p>
              <div className="mt-2">
                <Button type="button" variant="secondary" size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
                  Generate now
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No Doctor Pack yet — ask your RN to generate it.</p>
          )
        ) : IN_FLIGHT_STATES.has(pack.state) ? (
          <Spinner label={`Doctor Pack ${pack.state === 'queued' ? 'queued' : 'generating'}…`} />
        ) : pack.state === 'failed' ? (
          <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <p className="font-semibold">Doctor Pack generation failed</p>
            {/* NO-SILENT-ERRORS: the worker's real cause, verbatim. */}
            <p className="mt-1 whitespace-pre-wrap">{pack.errorMessage ?? 'No error message was recorded.'}</p>
            {canGenerate ? (
              <div className="mt-2">
                <Button type="button" variant="secondary" loading={generate.isPending} onClick={() => generate.mutate()}>
                  Regenerate
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-xs">Ask your RN to regenerate it.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="primary" onClick={() => void openPdf(pack)}>
              Open Doctor Pack ({pack.pageCount ?? '?'}pp)
            </Button>
            {canGenerate ? (
              <Button type="button" variant="secondary" loading={generate.isPending} onClick={() => generate.mutate()}>
                Regenerate
              </Button>
            ) : null}
          </div>
        )}
        {keyDocsQuery.isError ? (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            Could not load the document list — {describeApiError(keyDocsQuery.error)}
          </p>
        ) : null}
        {packQuery.isError ? (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            Could not load the Doctor Pack — {describeApiError(packQuery.error)}
          </p>
        ) : null}
      </div>

      <div className="mt-5 border-t border-slate-100 pt-3">
        <h3 className="text-sm font-semibold text-slate-700">Case documents ({keyDocs.length})</h3>
        {keyDocsQuery.isLoading ? (
          <p className="mt-1 text-sm text-slate-400">Loading…</p>
        ) : keyDocs.length === 0 ? (
          <p className="mt-1 text-sm text-slate-400">
            No classified documents yet — they appear after the first Doctor Pack generation.
          </p>
        ) : (
          <div className="mt-1 divide-y divide-slate-100">
            {keyDocs.map((d) => (
              <KeyDocRow key={d.id} doc={d} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
