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
import { DeliveryPanel } from '../../components/DeliveryPanel';
import { OpsHeldPanel } from '../../components/OpsHeldPanel';
import { Gate2HaltPanel } from '../../components/Gate2HaltPanel';
import { DecisionsOverridesPanel } from '../../components/DecisionsOverridesPanel';
import { CaseAssignmentPanel } from '../../components/CaseAssignmentPanel';
import { CaseMessagesPanel } from '../../components/CaseMessagesPanel';
import { EmailLogPanel } from '../../components/EmailLogPanel';
import { listCaseEmails } from '../../api/emails';
import { getArtifactPdfUrl, postDraft, cancelDraftJob } from '../../api/drafter';
import { listClarifications } from '../../api/cases';
import { listDocuments, reocrDocument } from '../../api/veterans';
import { PdfViewerModal, type ViewableDoc } from '../../components/PdfViewerModal';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { Gate1ChecklistModal } from '../../components/Gate1ChecklistModal';
import { useAuth } from '../../auth/useAuth';
import { ConflictError, describeApiError } from '../../api/client';
import { letterFilename } from '../../lib/letterFilename';
import { allowedNextStatusesForRole, CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { formatRelativeTime } from '../../lib/date';
import { formatDateOnly, formatPhone, formatNameLastFirst } from '../../lib/format';
import {
  deleteCase, getCase, listDraftJobs, patchCase, transitionCaseStatus,
  type CaseDetail, type PatchCaseInput, type TransitionInput,
} from '../../api/cases';
import type { CaseStatus, Role } from '../../types/prisma';

// Phase 8.1 G2: extracted as a pure function so the polling decision is unit-testable
// without fighting React Query + fake timers in component tests.
export function decidePollIntervalMs(status: CaseStatus | undefined): number | false {
  if (status === 'records' || status === 'viability' || status === 'drafting') return 8000;
  return false;
}

// Activity (never-built placeholder) + Corrections (backing table is never written) removed to
// declutter (Ryan 2026-06-06). Clarifications kept — it's a live RN/physician Q&A feature.
type TabId = 'overview' | 'drafts' | 'clarifications' | 'documents' | 'emails' | 'messages';
const TABS: readonly TabItem<TabId>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'drafts', label: 'Draft jobs' },
  { id: 'clarifications', label: 'Clarifications' },
  { id: 'documents', label: 'Documents' },
  { id: 'emails', label: 'Email' },
  { id: 'messages', label: 'Messages' },
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
  const [redraftGate1Open, setRedraftGate1Open] = useState(false); // Gate-1 checklist before a redraft

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

  // Redraft (re-run the drafter). Available to admin/ops_staff post-draft so a physician_review
  // letter can be re-run (the OpsHeldPanel 'Re-run' only shows for held/revise). Guarded by a
  // confirm + the backend's in-flight 409. (Ryan 2026-06-04: "lost the ability to redraft".)
  const redraft = useMutation({
    mutationFn: (guidance?: string) => postDraft(caseId, guidance ? { strategyOverride: guidance } : {}),
    onSuccess: async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]); },
    // Surface the REAL reason (status + server message), never a canned guess — the redraft
    // endpoint's HttpErrors aren't logged server-side, so this alert is the only place the reason
    // appears. A 409 honestly covers both "already in flight" and "chart not ready yet" (we don't
    // claim a specific one). Everything else shows the server's own message. (Ryan: error-proof.)
    onError: (e: unknown) =>
      window.alert(
        e instanceof ConflictError
          ? 'Cannot redraft right now — a drafter run may already be in flight, or the chart is not ready yet. Reload the case and check its status.'
          : `Could not start a redraft — ${describeApiError(e)}. Please retry or flag to Dr. Ryan.`,
      ),
  });

  // Cancel an in-flight draft (stops the ~$15 spend). (Ryan 2026-06-05.)
  const cancelDraft = useMutation({
    mutationFn: (jobId: string) => cancelDraftJob(caseId, jobId),
    onSuccess: async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]); },
    onError: (e: unknown) => window.alert(`Could not cancel — ${describeApiError(e)}`),
  });

  // Send to doctor for review: rn_review -> physician_review. Completed drafts no longer auto-route
  // to the doctor — the RN reviews/edits, then explicitly sends. (Ryan 2026-06-04.)
  const sendToDoctor = useMutation({
    mutationFn: () => {
      const cur = caseQuery.data?.data;
      if (!cur) throw new Error('Case not loaded');
      return transitionCaseStatus(caseId, { from: 'rn_review', to: 'physician_review', version: cur.version });
    },
    onSuccess: async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]); },
    onError: (e: unknown) => window.alert(e instanceof ConflictError ? 'This case changed — reload and try sending again.' : `Could not send to the doctor — ${describeApiError(e)}.`),
  });

  if (caseQuery.isLoading) return <AppShell><div className="text-sm text-slate-500">Loading case…</div></AppShell>;
  if (!caseQuery.data) return <AppShell><EmptyState title="Case not found" message="The requested case could not be loaded." /></AppShell>;
  const c = caseQuery.data.data;
  // From rn_review, "Send to doctor for review" (in the RN review panel) is the path to
  // physician_review — drop the redundant generic "Move to physician review" header button.
  const nextStatuses = allowedNextStatusesForRole(role, c.status)
    .filter((to) => !(c.status === 'rn_review' && to === 'physician_review'))
    // "Move to drafting" is a bare status flip with no action — Redraft / Send to Drafter / the
    // Gate-2 resume are the real paths. Drop it (Ryan 2026-06-05: "seems pointless").
    .filter((to) => to !== 'drafting');
  // CDS retired from the workflow (Ryan 2026-06-03): it no longer gates sign-off. A stale
  // cdsVerdict='reject' must NOT hide the sign-off button (the CDS panel is gone, so there'd be no
  // explanation and no way to recover — an RN/physician dead-end). (architect MF-2)
  const canShowSignOff =
    c.status === 'physician_review' && (role === 'admin' || role === 'physician');
  const draftInFlight = (c.draftJobs?.[0] as InFlightDraftJob | undefined)?.state === 'queued'
    || (c.draftJobs?.[0] as InFlightDraftJob | undefined)?.state === 'running';
  const canRedraft = (role === 'admin' || role === 'ops_staff') && (c.draftJobs ?? []).length > 0 && !draftInFlight;

  // The newest draft-job that produced (or should have produced) a letter PDF. draftJobs is
  // version-desc, so the first terminal-or-keyed job is the latest letter. Terminal (done OR a
  // watcher-flipped 'failed' that still rendered) is included because artifactPdfS3Key can be null
  // after the stuck-watcher race — the backend derives the key from version + HEAD-checks it. This
  // is what makes "View letter" reliably available in the EMR, no manual pulls (2026-06-04).
  const viewableLetterJob = (c.draftJobs ?? []).find((job) => {
    const j = job as InFlightDraftJob;
    const hasKey = typeof j.artifactPdfS3Key === 'string' && (j.artifactPdfS3Key as string).length > 0;
    return hasKey || j.state === 'done' || j.state === 'failed';
  }) as InFlightDraftJob | undefined;
  async function openLetterPdf() {
    if (!viewableLetterJob) return;
    try {
      const { data } = await getArtifactPdfUrl(c.id, viewableLetterJob.id);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('Could not open the letter PDF. If it keeps failing, flag this case to Dr. Ryan.');
    }
  }

  const tabsWithBadge = TABS.map((t) =>
    t.id === 'clarifications' && openClarificationCount > 0
      ? { ...t, label: `Clarifications (${openClarificationCount})` }
      : t,
  );

  return <AppShell><div className="space-y-6">
    {c.status === 'delivered' || c.status === 'paid' ? (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-900">
        ✓ Physician signed off — letter finalized{c.status === 'paid' ? ' and paid' : ' and ready for delivery'}.
      </div>
    ) : null}
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">{formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-base text-slate-700"><span className="font-medium">{formatConditionLabel(c.claimedCondition)}</span><CaseStatusBadge status={c.status} /></div>
          {(() => {
            const v = c.veteran;
            const age = v?.dob ? Math.floor((Date.now() - Date.parse(v.dob)) / 31557600000) : null;
            const ht = v?.heightIn != null ? `${Math.floor(v.heightIn / 12)}'${v.heightIn % 12}"` : null;
            const htwt = [ht, v?.weightLb != null ? `${v.weightLb} lb` : null].filter(Boolean).join(' ');
            const svc = [v?.branch, v?.serviceStartYear ? `${v.serviceStartYear}–${v.serviceEndYear ?? ''}` : null].filter(Boolean).join(' ');
            const bits = [
              v?.dob ? `DOB ${formatDateOnly(v.dob)}${age != null ? ` (age ${age})` : ''}` : null,
              svc || null,
              htwt || null,
              v?.phone ? formatPhone(v.phone) : null,
              v?.address || null,
            ].filter(Boolean);
            return bits.length ? <p className="mt-2 text-sm text-slate-600">{bits.join('  ·  ')}</p> : null;
          })()}
          <p className="mt-1 text-xs text-slate-400">Case {c.id} · {c.claimType} · <Link className="text-indigo-600" to={`/veterans/${encodeURIComponent(c.veteranId)}`}>chart</Link> · updated {formatRelativeTime(c.updatedAt)} · row v{c.version}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {/* View letter only when the review panel (which has its own "Open PDF") isn't showing —
              no duplicate view button (Ryan 2026-06-05). */}
          {viewableLetterJob && c.status !== 'rn_review' && c.status !== 'physician_review' ? <Button variant="secondary" size="sm" onClick={openLetterPdf}>View letter</Button> : null}
          {canRedraft ? <Button variant="secondary" size="sm" loading={redraft.isPending} disabled={redraft.isPending} onClick={() => setRedraftGate1Open(true)}>Redraft</Button> : null}
          {canShowSignOff ? <Button variant="primary" size="sm" onClick={() => setSignOffOpen(true)}>Sign off</Button> : null}
          {nextStatuses.map((to) => <Button key={to} variant="secondary" size="sm" onClick={() => setPendingTo(to)}>{to === 'rejected' ? 'Reject claim' : `Move to ${CASE_STATUS_LABELS[to].toLowerCase()}`}</Button>)}
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

      // Physician's view — any case the RN has sent (status physician_review). The RN's explicit
      // send IS the gate now, so we no longer require ship/runComplete here (the RN may send a
      // letter the grader flagged 'revise' after improving it). (Ryan 2026-06-04.)
      const canSeePhysicianReadyPanel =
        c.status === 'physician_review' &&
        (role === 'admin' || role === 'physician');

      // RN's view of a completed draft awaiting send (status rn_review): same grade + top-3 +
      // view/edit as the physician panel, but the primary action is "Send to doctor for review".
      const canSeeRnReviewPanel =
        c.status === 'rn_review' &&
        (role === 'admin' || role === 'ops_staff');

      // Held panel is for a draft still in 'drafting' that failed / came back non-ready (re-run +
      // send-back). Completed drafts now live in rn_review (handled above), so scope this to
      // drafting only to avoid a double panel.
      const canSeeOpsHeldPanel =
        (role === 'admin' || role === 'ops_staff') &&
        c.status === 'drafting' &&
        (c.runComplete === false ||
          c.shipRecommendation === 'revise' ||
          (c.operatorState !== undefined &&
            c.operatorState !== null &&
            c.operatorState !== 'ready' &&
            c.operatorState !== 'ready_with_notes'));

      return (
        <>
          {inFlightDraft && latestDraftJob ? (
            <InFlightDrafterPanel job={latestDraftJob} onCancel={() => cancelDraft.mutate(latestDraftJob.id)} cancelling={cancelDraft.isPending} />
          ) : null}

          {canSendFirstDraft ? <SendToDrafterPanel caseId={caseId} claimType={c.claimType} claimedCondition={c.claimedCondition} draftAttempt={(c.currentVersion ?? 0) + 1} /> : null}

          {!inFlightDraft && canSeePhysicianReadyPanel && latestDraftJob ? (
            <PhysicianLetterReadyPanel
              c={c}
              job={latestDraftJob}
              canSendBack={role === 'admin' || role === 'physician'}
              onOpenPdf={openLetterPdf}
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

          {!inFlightDraft && canSeeRnReviewPanel && latestDraftJob ? (
            <PhysicianLetterReadyPanel
              c={c}
              job={latestDraftJob}
              canSendBack={false}
              onOpenPdf={openLetterPdf}
              onEditText={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}
              onSendToDoctor={() => { if (window.confirm('Send this letter to the doctor for review? It will move to the physician queue.')) sendToDoctor.mutate(); }}
              sending={sendToDoctor.isPending}
              onChanged={async () => {
                await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]);
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
              hasLetter={!!viewableLetterJob}
              onViewLetter={openLetterPdf}
            />
          ) : null}

          {/* Gate-2 dx/event verification halt — the case is parked for the RN's decision. Never a
              dead-end: override / switch / proceed / pause, all logged. */}
          {c.status === 'needs_rn_decision' || c.status === 'needs_records' ? (
            <Gate2HaltPanel
              c={c}
              {...((c.draftJobs ?? []).find((j) => (j as { state?: string }).state === 'halted') ? { job: (c.draftJobs ?? []).find((j) => (j as { state?: string }).state === 'halted') as never } : {})}
              onChanged={async () => { await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] }), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-decisions'] })]); }}
            />
          ) : null}

          {/* RN letter-edit entry. The physician/admin reach the editor via the ready panel above;
              an RN (ops_staff) otherwise has no entry to it. Ryan 2026-06-04: "RNs need the ability
              to edit letters too ... by hand or AI surgically before sending to doc." Shown when a
              letter exists, the run is not in flight, and the status is editable (drafting /
              physician_review / correction_review — matches the backend EDITABLE_STATUSES). Editing
              creates a NEW version; the version-safety in /draft + currentVersion pointer ensure the
              doctor always reviews the newest version. */}
          {!inFlightDraft && role === 'ops_staff' && viewableLetterJob &&
            (c.status === 'drafting' || c.status === 'physician_review' || c.status === 'correction_review') ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Edit {letterFilename(c.veteran?.lastName, c.veteran?.firstName, c.claimedCondition, c.currentVersion ?? c.version)}</h2>
              <p className="mt-1 text-sm text-slate-600">
                Revise the letter by hand or with an AI surgical edit — same tools the physician has.
                Save creates a new version, and the doctor reviews the newest version.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {/* View letter lives in the page header — not duplicated here. */}
                <Button variant="primary" size="sm" onClick={() => navigate(`/cases/${encodeURIComponent(c.id)}/letter`)}>Open letter editor</Button>
              </div>
            </div>
          ) : null}
        </>
      );
    })()}

    {/* Assignments — moved out of the buried Overview tab to right under the editor panels so it's
        apparent (Ryan 2026-06-04: "move assignments just under the letter editor ... needs to be
        apparent"). Admin/ops_staff only. */}
    {role === 'admin' || role === 'ops_staff' ? (
      <CaseAssignmentPanel caseId={c.id} version={c.version} assignedPhysician={c.assignedPhysician ?? null} assignedRn={c.assignedRn ?? null} />
    ) : null}

    {/* Post-approval RN delivery panel — invoice email + cover memo + Stripe link. Stubbed sends. */}
    {(c.status === 'delivered' || c.status === 'paid') && (role === 'admin' || role === 'ops_staff') ? (
      <DeliveryPanel caseId={caseId} onVerifyLetter={openLetterPdf} hasLetterPdf={!!viewableLetterJob} />
    ) : null}

    <div className="rounded-lg border border-slate-200 bg-white">
      <TabBar tabs={tabsWithBadge} active={tab} onChange={setTab} />
      <div className="p-4">
        {tab === 'overview' ? (
          <OverviewTab c={c} saving={patch.isPending} onSave={(field, value) => patch.mutate({ version: c.version, [field]: value })} />
        ) : null}
        {tab === 'drafts' ? <DraftJobsTab caseId={caseId} /> : null}
        {tab === 'clarifications' ? <ClarificationsPanel caseId={caseId} /> : null}
        {tab === 'documents' ? <DocumentsTab veteranId={c.veteranId} caseId={c.id} /> : null}
        {tab === 'emails' ? <EmailLogPanel queryKey={['case', caseId, 'emails']} fetcher={() => listCaseEmails(caseId)} scope="claim" /> : null}
        {tab === 'messages' ? <CaseMessagesPanel caseId={caseId} /> : null}
      </div>
    </div>

    {/* In-chart decisions/overrides audit — plain-language, pinned to the very bottom of the case
        screen (Ryan 2026-06-06). Self-hides when empty. */}
    <DecisionsOverridesPanel caseId={caseId} />

    {pendingTo ? <TransitionModal caseId={caseId} from={c.status} to={pendingTo} version={c.version} onClose={() => setPendingTo(null)} onDone={async () => { setPendingTo(null); await refetch(); }} /> : null}
    <SignOffPopup caseId={caseId} open={signOffOpen} onClose={() => setSignOffOpen(false)} onSignedOff={refetch} />
    {redraftGate1Open ? (
      <Gate1ChecklistModal
        caseId={caseId}
        claimType={c.claimType}
        claimedCondition={c.claimedCondition}
        draftAttempt={(c.currentVersion ?? 0) + 1}
        onClose={() => setRedraftGate1Open(false)}
        onConfirmed={(guidance) => { setRedraftGate1Open(false); redraft.mutate(guidance); }}
      />
    ) : null}
  </div></AppShell>;
}

type EditableField = 'framingChoice' | 'upstreamScCondition' | 'veteranStatement' | 'inServiceEvent';

function OverviewTab({ c, onSave, saving }: { readonly c: CaseDetail; readonly onSave: (field: EditableField, value: string) => void; readonly saving: boolean }) {
  // Authoritative total from the backend aggregate over ALL DraftJobs (c.draftingCostUsd) — the
  // old client-side sum over the truncated take:5 c.draftJobs list missed older cost-bearing runs
  // and showed "—" (Ryan 2026-06-04). null === no recorded cost on any job → honest "—".
  const draftingCost = c.draftingCostUsd ?? null;
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
  // Open a SPECIFIC version's letter PDF. The backend derives the key from the job version, so
  // any terminal run is viewable even if artifactPdfS3Key didn't persist. (2026-06-04 — Ryan:
  // "what's the point if I can't click the files to see the version".)
  async function viewVersion(jobId: string) {
    try {
      const { data } = await getArtifactPdfUrl(caseId, jobId);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('No letter PDF for that version — it may not have finished drafting.');
    }
  }
  if (q.isLoading) return <div className="text-sm text-slate-500">Loading draft jobs…</div>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title="No draft jobs" message="No drafting runs have been enqueued for this case." />;
  // Rows arrive version-desc (newest first). The raw DB version is inflated by the /draft pileup
  // (v81, v57…) and confused Ryan ("v 87? wrong"), so show a sane sequential attempt label:
  // oldest run = "Draft #1" … newest = "Draft #N". attempt = rows.length - index. The raw version
  // stays visible (muted + tooltip) for traceability — View letter still uses jobId, not this.
  const total = rows.length;
  return <div className="overflow-hidden rounded-lg border border-slate-200"><table className="min-w-full divide-y divide-slate-200 text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Draft</th><th className="px-4 py-2">State</th><th className="px-4 py-2">Enqueued</th><th className="px-4 py-2">Started</th><th className="px-4 py-2">Completed</th><th className="px-4 py-2">Letter</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((d, i) => { const viewable = d.state === 'done' || d.state === 'failed'; return <tr key={d.id} className={`hover:bg-slate-50 ${viewable ? 'cursor-pointer' : ''}`} onClick={viewable ? () => viewVersion(d.id) : undefined}><td className="px-4 py-2"><span className="font-medium text-slate-800">Draft #{total - i}</span> <span className="ml-1 text-xs text-slate-400" title={`Internal letter version ${d.version}`}>v{d.version}</span></td><td className="px-4 py-2">{d.state}</td><td className="px-4 py-2 text-slate-500">{formatRelativeTime(d.enqueuedAt)}</td><td className="px-4 py-2 text-slate-500">{d.startedAt ? formatRelativeTime(d.startedAt) : '—'}</td><td className="px-4 py-2 text-slate-500">{d.completedAt ? formatRelativeTime(d.completedAt) : '—'}</td><td className="px-4 py-2">{viewable ? <button type="button" className="font-medium text-indigo-600 hover:underline" onClick={(e) => { e.stopPropagation(); viewVersion(d.id); }}>View letter</button> : <span className="text-slate-400">—</span>}</td></tr>; })}</tbody></table></div>;
}

function DocumentsTab({ veteranId, caseId }: { readonly veteranId: string; readonly caseId: string }) {
  const q = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const [viewDoc, setViewDoc] = useState<ViewableDoc | null>(null);
  const reocr = useMutation({ mutationFn: reocrDocument, onSuccess: () => window.alert('Re-running OCR on this file (Textract → Claude fallback). Refresh in a minute to see it read.') });
  const all = q.data?.data ?? [];
  const docs = all.filter((d) => d.caseId === caseId); // this claim's files
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">Documents on this claim</h3>
        <Link className="text-xs text-indigo-600 hover:underline" to={`/veterans/${encodeURIComponent(veteranId)}#documents`}>Manage all veteran documents →</Link>
      </div>
      {q.isLoading ? (
        <div className="p-6 text-sm text-slate-500">Loading documents…</div>
      ) : docs.length === 0 ? (
        <EmptyState title="No documents on this claim" message="Files assigned to this claim (including the auto-generated Intake Summary) appear here. Click any file to view it in-page." />
      ) : (
        <div className="divide-y divide-slate-100">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <button className="flex flex-1 items-center justify-between gap-3 text-left hover:bg-slate-50" onClick={() => setViewDoc({ id: d.id, filename: d.filename, contentType: d.contentType })}>
                <span className="text-indigo-700">{d.filename}</span>
                <span className="text-slate-500">{d.docTag ?? 'Other'} · {formatRelativeTime(d.uploadedAt)}</span>
              </button>
              <button type="button" className="shrink-0 text-xs font-medium text-slate-500 hover:text-indigo-600 disabled:opacity-50" disabled={reocr.isPending} title="Re-run OCR (Textract → Claude fallback) — use if this file shows as unreadable" onClick={() => reocr.mutate(d.id)}>Re-run OCR</button>
            </div>
          ))}
        </div>
      )}
      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </div>
  );
}
