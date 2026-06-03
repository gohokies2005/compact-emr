import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { TabBar, type TabItem } from '../../components/ui/TabBar';
import { SignOffPopup } from '../../components/SignOffPopup';
import { ClarificationsPanel } from '../../components/ClarificationsPanel';
import { InFlightDrafterPanel, type InFlightDraftJob } from '../../components/InFlightDrafterPanel';
import { SendToDrafterPanel } from '../../components/SendToDrafterPanel';
import { PhysicianLetterReadyPanel } from '../../components/PhysicianLetterReadyPanel';
import { OpsHeldPanel } from '../../components/OpsHeldPanel';
import { CaseAssignmentPanel } from '../../components/CaseAssignmentPanel';
import { CaseMessagesPanel } from '../../components/CaseMessagesPanel';
import { getArtifactPdfUrl } from '../../api/drafter';
import { listClarifications } from '../../api/cases';
import { useAuth } from '../../auth/useAuth';
import { ConflictError } from '../../api/client';
import { allowedNextStatusesForRole, CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { formatRelativeTime } from '../../lib/date';
import {
  deleteCase, getCase, listCorrections, listDraftJobs, patchCase, transitionCaseStatus,
  type CaseDetail, type PatchCaseInput, type TransitionInput,
} from '../../api/cases';
import type { CaseStatus, Role } from '../../types/prisma';

// Phase 8.1 G2: extracted as a pure function so the polling decision is unit-testable
// without fighting React Query + fake timers in component tests.
export function decidePollIntervalMs(status: CaseStatus | undefined): number | false {
  if (status === 'records' || status === 'viability' || status === 'drafting') return 8000;
  return false;
}

type TabId = 'overview' | 'drafts' | 'corrections' | 'clarifications' | 'documents' | 'messages' | 'activity';
const TABS: readonly TabItem<TabId>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'drafts', label: 'Draft jobs' },
  { id: 'corrections', label: 'Corrections' },
  { id: 'clarifications', label: 'Clarifications' },
  { id: 'documents', label: 'Documents' },
  { id: 'messages', label: 'Messages' },
  { id: 'activity', label: 'Activity' },
];

function serverErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
}

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = id ?? '';
  const navigate = useNavigate();
  const { user } = useAuth();
  const role: Role = user?.role ?? 'ops_staff';
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('overview');
  const [pendingTo, setPendingTo] = useState<CaseStatus | null>(null);
  const [signOffOpen, setSignOffOpen] = useState(false);

  // Phase 8.1 G2 (Ryan's RN-self-service audit): poll the main case query every 8s while
  // the case is in pre-draft states so Textract OCR callbacks (FileReadStatus flips to
  // manual_summary_required) and DraftJob state changes surface without manual refresh.
  // refetchIntervalInBackground=false so hidden tabs don't burn API.
  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => getCase(caseId),
    enabled: caseId.length > 0,
    refetchInterval: (query) => decidePollIntervalMs(query.state.data?.data?.status),
    refetchIntervalInBackground: false,
  });
  const openClarificationsQuery = useQuery({
    queryKey: ['case', caseId, 'clarifications', 'open'],
    queryFn: () => listClarifications(caseId, 'open'),
    enabled: caseId.length > 0,
  });
  const openClarificationCount = openClarificationsQuery.data?.data.length ?? 0;
  const refetch = () => qc.invalidateQueries({ queryKey: ['case', caseId] });

  const patch = useMutation({
    mutationFn: (input: PatchCaseInput) => patchCase(caseId, input),
    onSuccess: () => refetch(),
    onError: async (err) => { if (err instanceof ConflictError) { await refetch(); window.alert('This case was modified elsewhere. Reloaded the latest version — please retry your edit.'); } },
  });

  const del = useMutation({ mutationFn: () => deleteCase(caseId), onSuccess: () => refetch() });

  if (caseQuery.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading case…</div></AppShell>;
  if (!caseQuery.data) return <AppShell><EmptyState title="Case not found" message="The requested case could not be loaded." /></AppShell>;
  const c = caseQuery.data.data;
  const nextStatuses = allowedNextStatusesForRole(role, c.status);
  const canShowSignOff =
    c.status === 'physician_review' && c.cdsVerdict !== 'reject' && (role === 'admin' || role === 'physician');
  const tabsWithBadge = TABS.map((t) =>
    t.id === 'clarifications' && openClarificationCount > 0
      ? { ...t, label: `Clarifications (${openClarificationCount})` }
      : t,
  );

  return <AppShell><div className="space-y-6">
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row">
        <div>
          <div className="flex items-center gap-3"><h1 className="text-2xl font-semibold text-slate-900">{c.claimedCondition}</h1><CaseStatusBadge status={c.status} /></div>
          <p className="mt-1 text-sm text-slate-500">
            Case {c.id} · {c.claimType} · <Link className="text-indigo-600" to={`/veterans/${encodeURIComponent(c.veteranId)}`}>{c.veteran ? `${c.veteran.firstName} ${c.veteran.lastName}` : c.veteranId}</Link>
          </p>
          <p className="mt-1 text-xs text-slate-400">Updated {formatRelativeTime(c.updatedAt)} · row v{c.version}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {canShowSignOff ? <Button variant="primary" size="sm" onClick={() => setSignOffOpen(true)}>Sign off</Button> : null}
          {nextStatuses.map((to) => <Button key={to} variant="secondary" size="sm" onClick={() => setPendingTo(to)}>Move to {CASE_STATUS_LABELS[to].toLowerCase()}</Button>)}
          {role === 'admin' ? <Button variant="destructive" size="sm" onClick={() => { if (window.confirm('Reject and soft-delete this case? It will be marked rejected.')) del.mutate(); }} loading={del.isPending}>Reject + soft delete</Button> : null}
        </div>
      </div>
    </div>

    {/* CDS panel retired from the workflow (Ryan 2026-06-03). Backend route is flag-guarded off
        (CDS_ENABLED); the engine code is kept. Re-add this panel if CDS is re-enabled. */}

    {(() => {
      // Phase 8: physician/ops drafter panels. Derived from latest DraftJob + Case state.
      const latestDraftJob = c.draftJobs?.[0] as InFlightDraftJob | undefined;
      const inFlightDraft =
        latestDraftJob?.state === 'queued' || latestDraftJob?.state === 'running';

      // Gap 1: first-draft trigger. RN/admin can kick off the drafter when no run is in
      // flight and none has completed yet. Chart-readiness is enforced inside the panel.
      const hasCompletedDraft = (c.draftJobs ?? []).some((job) => job.state === 'done');
      const canSendFirstDraft =
        (role === 'admin' || role === 'ops_staff') && !inFlightDraft && !hasCompletedDraft;

      const canSeePhysicianReadyPanel =
        c.runComplete === true &&
        c.shipRecommendation === 'ship' &&
        c.status === 'physician_review' &&
        (role === 'admin' || role === 'physician');

      const canSeeOpsHeldPanel =
        (role === 'admin' || role === 'ops_staff') &&
        (c.runComplete === false ||
          c.shipRecommendation === 'revise' ||
          (c.operatorState !== undefined &&
            c.operatorState !== null &&
            c.operatorState !== 'ready' &&
            c.operatorState !== 'ready_with_notes'));

      const handleOpenPdf = async () => {
        if (!latestDraftJob) return;
        try {
          const { data } = await getArtifactPdfUrl(c.id, latestDraftJob.id);
          window.open(data.url, '_blank', 'noopener,noreferrer');
        } catch {
          window.alert('Could not open the PDF. Please try again — if it keeps failing, flag this case to Dr. Ryan.');
        }
      };

      return (
        <>
          {inFlightDraft && latestDraftJob ? (
            <InFlightDrafterPanel job={latestDraftJob} />
          ) : null}

          {canSendFirstDraft ? <SendToDrafterPanel caseId={caseId} /> : null}

          {!inFlightDraft && canSeePhysicianReadyPanel && latestDraftJob ? (
            <PhysicianLetterReadyPanel
              c={c}
              job={latestDraftJob}
              canSendBack={role === 'admin' || role === 'physician'}
              onOpenPdf={handleOpenPdf}
              onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
              onOpenSignOff={() => setSignOffOpen(true)}
              // GPT chunk 2: invalidate both queries on case-changing mutations so the
              // panel + the draft-jobs tab both refetch.
              onChanged={async () => {
                await Promise.all([
                  refetch(),
                  qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }),
                ]);
              }}
            />
          ) : null}

          {!inFlightDraft && canSeeOpsHeldPanel ? (
            // OpsHeldPanel.job is optional under exactOptionalPropertyTypes — spread it only
            // when present (TS rejects passing explicit undefined to an optional prop).
            <OpsHeldPanel
              c={c}
              {...(latestDraftJob ? { job: latestDraftJob } : {})}
              isAdmin={role === 'admin'}
            />
          ) : null}
        </>
      );
    })()}

    <div className="rounded-lg border border-slate-200 bg-white">
      <TabBar tabs={tabsWithBadge} active={tab} onChange={setTab} />
      <div className="p-4">
        {tab === 'overview' ? (
          <>
            <OverviewTab c={c} saving={patch.isPending} onSave={(field, value) => patch.mutate({ version: c.version, [field]: value })} />
            {role === 'admin' || role === 'ops_staff' ? (
              <div className="mt-4"><CaseAssignmentPanel caseId={c.id} version={c.version} assignedPhysician={c.assignedPhysician ?? null} assignedRn={c.assignedRn ?? null} /></div>
            ) : null}
          </>
        ) : null}
        {tab === 'drafts' ? <DraftJobsTab caseId={caseId} /> : null}
        {tab === 'corrections' ? <CorrectionsTab caseId={caseId} /> : null}
        {tab === 'clarifications' ? <ClarificationsPanel caseId={caseId} /> : null}
        {tab === 'documents' ? <DocumentsTab veteranId={c.veteranId} /> : null}
        {tab === 'messages' ? <CaseMessagesPanel caseId={caseId} /> : null}
        {tab === 'activity' ? <EmptyState title="Activity" message="The per-case activity log ships in a later phase." /> : null}
      </div>
    </div>

    {pendingTo ? <TransitionModal caseId={caseId} from={c.status} to={pendingTo} version={c.version} onClose={() => setPendingTo(null)} onDone={async () => { setPendingTo(null); await refetch(); }} /> : null}
    <SignOffPopup caseId={caseId} open={signOffOpen} onClose={() => setSignOffOpen(false)} onSignedOff={refetch} />
  </div></AppShell>;
}

type EditableField = 'framingChoice' | 'upstreamScCondition' | 'veteranStatement' | 'inServiceEvent';

// Per-claim drafting cost = sum of the case's DraftJob.costUsd (US-dollar LLM spend posted by
// the drafter worker). Returns null when no job carries a recorded cost so the UI can show "—".
function sumDraftingCostUsd(c: CaseDetail): number | null {
  const jobs = c.draftJobs ?? [];
  let hasAny = false;
  let total = 0;
  for (const j of jobs) {
    if (typeof j.costUsd === 'number' && Number.isFinite(j.costUsd)) {
      hasAny = true;
      total += j.costUsd;
    }
  }
  return hasAny ? total : null;
}

function OverviewTab({ c, onSave, saving }: { readonly c: CaseDetail; readonly onSave: (field: EditableField, value: string) => void; readonly saving: boolean }) {
  const draftingCost = sumDraftingCostUsd(c);
  return <div className="divide-y divide-slate-100">
    <InlineEditRow label="Framing" value={c.framingChoice ?? ''} saving={saving} onSave={(v) => onSave('framingChoice', v)} />
    <InlineEditRow label="Upstream SC condition" value={c.upstreamScCondition ?? ''} saving={saving} onSave={(v) => onSave('upstreamScCondition', v)} />
    <InlineEditRow label="Veteran statement" value={c.veteranStatement ?? ''} multiline saving={saving} onSave={(v) => onSave('veteranStatement', v)} />
    <InlineEditRow label="In-service event" value={c.inServiceEvent ?? ''} multiline saving={saving} onSave={(v) => onSave('inServiceEvent', v)} />
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Drafting cost (API)</span>
        <span className="text-sm font-medium text-slate-800">{draftingCost === null ? '—' : `$${draftingCost.toFixed(2)}`}</span>
      </div>
    </div>
  </div>;
}

function InlineEditRow({ label, value, multiline = false, saving, onSave }: { readonly label: string; readonly value: string; readonly multiline?: boolean; readonly saving: boolean; readonly onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  function start() { setDraft(value); setEditing(true); }
  function save() { onSave(draft); setEditing(false); }
  return <div className="py-3">
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {editing
        ? <div className="flex gap-2"><button type="button" className="text-xs text-slate-500" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="text-xs text-indigo-600" onClick={save} disabled={saving}>Save</button></div>
        : <button type="button" aria-label={`Edit ${label}`} className="text-xs text-indigo-600" onClick={start}>Edit</button>}
    </div>
    {editing
      ? (multiline
          ? <textarea className="input mt-2 min-h-24" value={draft} onChange={(e) => setDraft(e.target.value)} />
          : <input className="input mt-2" value={draft} onChange={(e) => setDraft(e.target.value)} />)
      : <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{value || <span className="text-slate-400">—</span>}</p>}
  </div>;
}

function TransitionModal({ caseId, from, to, version, onClose, onDone }: { readonly caseId: string; readonly from: CaseStatus; readonly to: CaseStatus; readonly version: number; readonly onClose: () => void; readonly onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (): Promise<unknown> => {
      const input: TransitionInput = { from, to, version, ...(reason.trim() && { transitionReason: reason.trim() }) };
      return transitionCaseStatus(caseId, input);
    },
    onSuccess: () => onDone(),
    onError: (e) => {
      if (e instanceof ConflictError) { setErr('This case was modified since you loaded it. Close this dialog and retry.'); return; }
      setErr(serverErrorMessage(e) ?? 'The status change could not be saved.');
    },
  });
  return <div className="fixed inset-0 z-50 bg-slate-900/40 p-6"><div className="mx-auto mt-24 max-w-md rounded-lg bg-white p-6 shadow-xl">
    <h2 className="text-lg font-semibold text-slate-900">Move to {CASE_STATUS_LABELS[to].toLowerCase()}</h2>
    <p className="mt-1 text-sm text-slate-500">From {CASE_STATUS_LABELS[from].toLowerCase()}.</p>
    <label className="mt-4 block text-sm"><span className="mb-1 block font-medium text-slate-700">Audit note (optional)</span><input className="input" placeholder="Audit note — no PHI, e.g., 'per supervisor approval'" value={reason} onChange={(e) => { setReason(e.target.value); setErr(null); }} /></label>
    {err ? <p className="mt-2 text-sm text-rose-600">{err}</p> : null}
    <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => mut.mutate()} loading={mut.isPending}>Confirm</Button></div>
  </div></div>;
}

function DraftJobsTab({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'draft-jobs'], queryFn: () => listDraftJobs(caseId) });
  if (q.isLoading) return <div className="text-sm text-slate-500">Loading draft jobs…</div>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title="No draft jobs" message="No drafting runs have been enqueued for this case." />;
  return <div className="overflow-hidden rounded-lg border border-slate-200"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Version</th><th className="px-4 py-2">State</th><th className="px-4 py-2">Enqueued</th><th className="px-4 py-2">Started</th><th className="px-4 py-2">Completed</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((d) => <tr key={d.id}><td className="px-4 py-2">{d.version}</td><td className="px-4 py-2">{d.state}</td><td className="px-4 py-2 text-slate-500">{formatRelativeTime(d.enqueuedAt)}</td><td className="px-4 py-2 text-slate-500">{d.startedAt ? formatRelativeTime(d.startedAt) : '—'}</td><td className="px-4 py-2 text-slate-500">{d.completedAt ? formatRelativeTime(d.completedAt) : '—'}</td></tr>)}</tbody></table></div>;
}

function CorrectionsTab({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'corrections'], queryFn: () => listCorrections(caseId) });
  if (q.isLoading) return <div className="text-sm text-slate-500">Loading corrections…</div>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title="No corrections" message="No correction history for this case." />;
  return <div className="overflow-hidden rounded-lg border border-slate-200"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">From</th><th className="px-4 py-2">To</th><th className="px-4 py-2">Reason</th><th className="px-4 py-2">Requested by</th><th className="px-4 py-2">Approved by</th><th className="px-4 py-2">Billing</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((r) => <tr key={r.id}><td className="px-4 py-2">{r.fromVersion}</td><td className="px-4 py-2">{r.toVersion ?? '—'}</td><td className="px-4 py-2">{r.correctionReason}</td><td className="px-4 py-2 text-slate-500">{r.requestedBy}</td><td className="px-4 py-2 text-slate-500">{r.approvedBy ?? '—'}</td><td className="px-4 py-2 text-slate-500">{r.billingTier}</td></tr>)}</tbody></table></div>;
}

function DocumentsTab({ veteranId }: { readonly veteranId: string }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
    <p className="text-sm text-slate-600">Documents are managed at the veteran chart level.</p>
    <div className="mt-3"><Link to={`/veterans/${encodeURIComponent(veteranId)}#documents`}><Button variant="secondary" size="sm">Open veteran documents</Button></Link></div>
  </div>;
}
