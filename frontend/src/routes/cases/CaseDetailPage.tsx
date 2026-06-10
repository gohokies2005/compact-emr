import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { TabSection } from '../../components/ui/TabSection';
import { DataRow } from '../../components/ui/DataRow';
import { StatusChip, type ChipTone } from '../../components/ui/StatusChip';
import { RowAction } from '../../components/ui/RowAction';
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
import { AdvisoryPanel } from '../../components/AdvisoryPanel';
import { CaseAssignmentPanel } from '../../components/CaseAssignmentPanel';
import { CaseMessagesPanel } from '../../components/CaseMessagesPanel';
import { EmailLogPanel } from '../../components/EmailLogPanel';
import { ChartNotesPanel } from '../veterans/ChartNotesPanel';
import { ConditionsPanel, MedicationsPanel, ProblemsPanel } from '../../components/ClinicalChartPanels';
import { listCaseEmails } from '../../api/emails';
import { getArtifactPdfUrl, postDraft, cancelDraftJob, getDraftConcurrency, type DraftConcurrencyResult } from '../../api/drafter';
import { getLetter } from '../../api/letter';
import { listClarifications } from '../../api/cases';
import { getVeteran, listDocuments, reocrDocument } from '../../api/veterans';
import { PdfViewerModal, type ViewableDoc } from '../../components/PdfViewerModal';
import { formatConditionLabel } from '../../lib/conditionLabel';
import { Gate1ChecklistModal } from '../../components/Gate1ChecklistModal';
import { useAuth } from '../../auth/useAuth';
import { ConflictError, describeApiError } from '../../api/client';
import { letterFilename } from '../../lib/letterFilename';
import { allowedNextStatusesForRole, CASE_STATUS_LABELS } from '../../lib/caseStatus';
import { SHARED_TABS, type SharedTabId } from '../../lib/caseTabs';
import { formatRelativeTime } from '../../lib/date';
import { formatDateOnly, formatPhone, formatNameLastFirst } from '../../lib/format';
import {
  deleteCase, getCase, listDraftJobs, patchCase, transitionCaseStatus, updateQuickNote,
  type CaseDetail, type PatchCaseInput, type TransitionInput,
} from '../../api/cases';
import type { CaseStatus, Role } from '../../types/prisma';

// Phase 8.1 G2: extracted as a pure function so the polling decision is unit-testable
// without fighting React Query + fake timers in component tests.
export function decidePollIntervalMs(status: CaseStatus | undefined): number | false {
  if (status === 'records' || status === 'viability' || status === 'drafting') return 8000;
  // Poll while PARKED at a Gate-2 halt so the open page stays truthful: it picks up the halt payload,
  // a resume that flips the case back to 'drafting' (from this or another tab/device), or any status
  // change — instead of going dead and stranding the RN on a stale halt panel. Visible-tab-only
  // (refetchIntervalInBackground=false), so a walked-away RN burns nothing. (Gate-2 architect QA 🔴#1.)
  if (status === 'needs_rn_decision' || status === 'needs_records') return 15000;
  return false;
}

// Activity (never-built placeholder) + Corrections (backing table is never written) removed to
// declutter (Ryan 2026-06-06). Clarifications kept — it's a live RN/physician Q&A feature.
// The case is a claim ON a veteran, so the case page also surfaces the veteran's clinical chart
// (SC Conditions / Active Problems / Medications / Staff Notes) — the SAME add/edit/delete panels
// the veteran chart uses, operating on the same veteran data via the same API. The vet-scoped portion
// (Documents + the clinical sections) is sourced from the shared SHARED_TABS list so the claim page and
// the veteran chart can't drift; the claim page prepends Overview + its claim-scoped tabs (Draft jobs,
// Clarifications, Email, Messages). (architect design 2026-06-08.)
type TabId = 'overview' | 'drafts' | 'clarifications' | 'emails' | 'messages' | SharedTabId;
const TABS: readonly TabItem<TabId>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'drafts', label: 'Draft jobs' },
  { id: 'clarifications', label: 'Clarifications' },
  { id: 'emails', label: 'Email' },
  { id: 'messages', label: 'Messages' },
  ...SHARED_TABS,
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

  // Queue-position concurrency for the in-flight panel. Seeded from the POST /draft 201 (written into
  // this cache by the redraft / Send-to-Drafter mutations) and refreshed via GET /draft-concurrency on
  // the SAME visible-tab poll the case page already runs — no new poll loop. Enabled only while a draft
  // is queued/running (status 'drafting'); idle otherwise so it costs nothing post-draft.
  const draftActive = caseQuery.data?.data?.status === 'drafting';
  const concurrencyQuery = useQuery({
    queryKey: ['case', caseId, 'draft-concurrency'],
    queryFn: () => getDraftConcurrency(caseId),
    enabled: caseId.length > 0 && draftActive,
    refetchInterval: draftActive ? 8000 : false,
    refetchIntervalInBackground: false,
  });
  const liveConcurrency = concurrencyQuery.data?.data.concurrency ?? null;

  const refetch = () => qc.invalidateQueries({ queryKey: ['case', caseId] });

  const patch = useMutation({
    mutationFn: (input: PatchCaseInput) => patchCase(caseId, input),
    onSuccess: () => refetch(),
    onError: async (err) => { if (err instanceof ConflictError) { await refetch(); window.alert('This case was modified elsewhere. Reloaded the latest version — please retry your edit.'); } },
  });

  // Sticky scratch-note on the case (Epic/Cerner-style) — the team's free-text tracker, e.g.
  // "Awaiting records — VA C-file requested 6/8". Replaces the phantom "Move to needs records" button
  // (Ryan 2026-06-08): a records gap is a note someone tracks, not a status flip.
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const noteMut = useMutation({
    mutationFn: (note: string) => updateQuickNote(caseId, note),
    onSuccess: () => { refetch(); setNoteEditing(false); },
    onError: (e: unknown) => window.alert(`Could not save the note — ${describeApiError(e)}.`),
  });

  const del = useMutation({
    mutationFn: () => deleteCase(caseId),
    onSuccess: () => refetch(),
    // Audit 2026-06-07: a failed soft-delete used to no-op silently — the admin believed the case was
    // rejected when nothing happened. Surface the real reason (reload on a version conflict).
    onError: async (err: unknown) => {
      if (err instanceof ConflictError) {
        await refetch();
        window.alert('This case was modified elsewhere — reloaded the latest version. Please retry.');
      } else {
        window.alert(`Could not reject the case — ${err instanceof Error ? err.message : 'please retry.'}`);
      }
    },
  });

  // Redraft (re-run the drafter). Available to admin/ops_staff post-draft so a physician_review
  // letter can be re-run (the OpsHeldPanel 'Re-run' only shows for held/revise). Guarded by a
  // confirm + the backend's in-flight 409. (Ryan 2026-06-04: "lost the ability to redraft".)
  const redraft = useMutation({
    mutationFn: (guidance?: string) => postDraft(caseId, guidance ? { strategyOverride: guidance } : {}),
    onSuccess: async (res) => {
      // Seed the queue-position panel from the 201's concurrency block so the RN sees their place in
      // line immediately, before the first GET /draft-concurrency poll lands.
      const concurrency = res.data.concurrency ?? null;
      qc.setQueryData<{ data: DraftConcurrencyResult }>(['case', caseId, 'draft-concurrency'], { data: { concurrency } });
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['case', caseId, 'draft-jobs'] })]);
    },
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
  // Only offer transitions a human should actually DRIVE from the header. Everything else here is either a
  // bare status flip (no real action) or a machine-only state, so it's redundant/misleading (Ryan 2026-06-08):
  //   - physician_review: the RN-review panel's "Send to doctor for review" is the SINGLE correct path, and
  //     it requires a completed draft — a bare header button is meaningless (esp. with no draft).
  //   - drafting: a bare flip; Redraft / Send to Drafter / the Gate-2 resume are the real paths.
  //   - needs_records / needs_rn_decision: machine-only — the drafter's Gate-2 /halt parks the case there.
  //     A human flags a records gap with an "Awaiting records" note, not a status move.
  const HUMAN_MOVE_DENYLIST: readonly CaseStatus[] = ['physician_review', 'drafting', 'needs_records', 'needs_rn_decision'];
  const nextStatuses = allowedNextStatusesForRole(role, c.status).filter((to) => !HUMAN_MOVE_DENYLIST.includes(to));
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
      // Read the PDF from the SAME source the DOCX uses — GET /cases/:id/letter (resolveCurrent at
      // currentVersion) — so the physician's PDF and DOCX are ALWAYS the same version. The old
      // getArtifactPdfUrl was job-pinned (viewableLetterJob.version) and could open an OLD version's
      // PDF while the editor showed currentVersion → a physician could sign a version they never saw.
      const { data } = await getLetter(c.id);
      if (!data.rendered.pdfUrl) { window.alert('The letter PDF is not ready yet. If it persists, flag this case to Dr. Ryan.'); return; }
      window.open(data.rendered.pdfUrl, '_blank', 'noopener,noreferrer');
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
    <div className="rounded-2xl border border-aegis bg-ivory px-6 py-5 shadow-aegis-panel">
      <div className="flex flex-col justify-between gap-4 lg:flex-row">
        <div>
          {/* The veteran name links to that veteran's main chart (/veterans/:id, id = the MRN /
              c.veteranId — same route as the "chart" link below). Underline-on-hover keeps it
              clearly clickable without shouting. (Ryan 2026-06-08.) */}
          <h1 className="text-2xl font-semibold tracking-tight text-navyDeep">
            <Link to={`/veterans/${encodeURIComponent(c.veteranId)}`} className="rounded decoration-2 underline-offset-4 hover:text-navy hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-navy" title="Open this veteran's chart">
              {formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}
            </Link>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-base text-slate-700"><EditableClaimCondition c={c} onSave={(v) => patch.mutate({ version: c.version, claimedCondition: v })} /><CaseStatusBadge status={c.status} /></div>
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
            return bits.length ? <p className="mt-2 text-sm text-steel">{bits.join('  ·  ')}</p> : null;
          })()}
          <p className="mt-1 text-xs text-harbor">Case {c.id} · {c.claimType} · <Link className="text-navy" to={`/veterans/${encodeURIComponent(c.veteranId)}`}>chart</Link> · updated {formatRelativeTime(c.updatedAt)} · row v{c.version}</p>
          {/* Sticky scratch-note — the team's free-text tracker (e.g. "Awaiting records — C-file requested
              6/8"). The positive replacement for the old phantom "Move to needs records" button. */}
          <div className="mt-3">
            {noteEditing ? (
              <div className="flex items-start gap-2">
                <textarea className="input min-h-[2.5rem] max-w-xl flex-1" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="e.g. Awaiting records — VA C-file requested 6/8" autoFocus />
                <RowAction onClick={() => noteMut.mutate(noteDraft.trim())} disabled={noteMut.isPending}>Save</RowAction>
                {c.quickNote ? <RowAction kind="danger" onClick={() => noteMut.mutate('')} disabled={noteMut.isPending}>Clear</RowAction> : null}
                <RowAction kind="danger" onClick={() => setNoteEditing(false)}>Cancel</RowAction>
              </div>
            ) : c.quickNote ? (
              <button type="button" onClick={() => { setNoteDraft(c.quickNote ?? ''); setNoteEditing(true); }} className="inline-flex max-w-xl items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-left text-sm text-amber-900 hover:bg-amber-100" title="Edit note">
                <span className="mt-px text-[10px] font-semibold uppercase tracking-wide text-amber-700">Note</span>
                <span>{c.quickNote}{c.quickNoteBy ? <span className="ml-1 text-xs text-amber-700/70">— {c.quickNoteBy}{c.quickNoteAt ? ` · ${formatRelativeTime(c.quickNoteAt)}` : ''}</span> : null}</span>
              </button>
            ) : (
              <button type="button" onClick={() => { setNoteDraft(''); setNoteEditing(true); }} className="text-xs font-medium text-steel hover:text-navy">+ Add a note (e.g. awaiting records)</button>
            )}
          </div>
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
      // Hide the "Send to Drafter" card while the case is PARKED at a Gate-2 halt — the halt panel
      // below owns the decision (override / re-run / pause), so showing both produced two redundant,
      // misaligned amber boxes (Ryan 2026-06-06). The halt panel is the single source of action here.
      const isParkedAtHalt = c.status === 'needs_rn_decision' || c.status === 'needs_records';
      const canSendFirstDraft =
        (role === 'admin' || role === 'ops_staff') && !inFlightDraft && !hasCompletedDraft && !isParkedAtHalt;

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
            <InFlightDrafterPanel job={latestDraftJob} onCancel={() => cancelDraft.mutate(latestDraftJob.id)} cancelling={cancelDraft.isPending} concurrency={liveConcurrency} />
          ) : null}

          {canSendFirstDraft ? <SendToDrafterPanel caseId={caseId} claimType={c.claimType} claimedCondition={c.claimedCondition} draftAttempt={(c.currentVersion ?? 0) + 1} physicianAssigned={!!c.assignedPhysician} rnAssigned={!!c.assignedRn} /> : null}

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
              sendToDoctorBlockedReason={c.assignedPhysician ? undefined : 'Assign a physician below before sending.'}
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

    <div className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      <TabBar tabs={tabsWithBadge} active={tab} onChange={setTab} className="flex-wrap" />
      <div className="p-4">
        {tab === 'overview' ? (
          <OverviewTab c={c} saving={patch.isPending} onSave={(field, value) => patch.mutate({ version: c.version, [field]: value })} />
        ) : null}
        {tab === 'drafts' ? <DraftJobsTab caseId={caseId} /> : null}
        {tab === 'clarifications' ? <ClarificationsPanel caseId={caseId} /> : null}
        {tab === 'documents' ? <DocumentsTab veteranId={c.veteranId} caseId={c.id} /> : null}
        {tab === 'emails' ? <EmailLogPanel queryKey={['case', caseId, 'emails']} fetcher={() => listCaseEmails(caseId)} scope="claim" /> : null}
        {tab === 'messages' ? (
          <CaseMessagesPanel caseId={caseId} assignedRn={c.assignedRn ?? null} assignedPhysician={c.assignedPhysician ?? null} />
        ) : null}
        {/* Clinical chart tabs — same veteran data + same panels as the veteran chart page. The case
            carries the veteran id (c.veteranId); the clinical sections fetch the veteran detail and
            mutate it directly, so edits here and on the veteran chart are the same records. */}
        {tab === 'conditions' ? <VeteranClinicalTab veteranId={c.veteranId} section="conditions" /> : null}
        {tab === 'problems' ? <VeteranClinicalTab veteranId={c.veteranId} section="problems" /> : null}
        {tab === 'medications' ? <VeteranClinicalTab veteranId={c.veteranId} section="medications" /> : null}
        {tab === 'notes' ? <ChartNotesPanel veteranId={c.veteranId} /> : null}
      </div>
    </div>

    {/* "Ask AI about this case" — read-only advisory Q&A (decision support only). */}
    <AdvisoryPanel caseId={caseId} />

    {/* In-chart decisions/overrides audit — plain-language, pinned to the very bottom of the case
        screen (Ryan 2026-06-06). Self-hides when empty. */}
    <DecisionsOverridesPanel caseId={caseId} caseVersion={c.version} />

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

// The claimed condition is click-to-edit HERE on the claim's own page (Ryan 2026-06-06) — the
// veteran-chart claim row OPENS the claim instead. Saving PATCHes claimedCondition; the backend syncs
// claimedConditions[] for single-condition claims so the next drafter run uses the corrected dx.
function EditableClaimCondition({ c, onSave }: { readonly c: CaseDetail; readonly onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.claimedCondition);
  function commit() { const t = draft.trim(); if (t && t !== c.claimedCondition) onSave(t); setEditing(false); }
  if (!editing) {
    return <button type="button" className="rounded px-1 font-medium decoration-dotted hover:bg-amber-50 hover:underline" title="Click to edit the claimed condition" onClick={() => { setDraft(c.claimedCondition); setEditing(true); }}>{formatConditionLabel(c.claimedCondition)}</button>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input className="input h-7 w-64 py-0 text-sm" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
      <button type="button" className="text-xs font-medium text-indigo-600" onClick={commit}>Save</button>
      <button type="button" className="text-xs text-slate-400" onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}

type EditableField = 'framingChoice' | 'upstreamScCondition' | 'veteranStatement' | 'inServiceEvent';

function OverviewTab({ c, onSave, saving }: { readonly c: CaseDetail; readonly onSave: (field: EditableField, value: string) => void; readonly saving: boolean }) {
  // Authoritative total from the backend aggregate over ALL DraftJobs (c.draftingCostUsd) — the
  // old client-side sum over the truncated take:5 c.draftJobs list missed older cost-bearing runs
  // and showed "—" (Ryan 2026-06-04). null === no recorded cost on any job → honest "—".
  const draftingCost = c.draftingCostUsd ?? null;
  return <div className="divide-y divide-aegis">
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
        ? <div className="flex gap-2"><RowAction className="text-steel hover:text-slateInk" onClick={() => setEditing(false)}>Cancel</RowAction><RowAction onClick={save} disabled={saving}>Save</RowAction></div>
        : <RowAction aria-label={`Edit ${label}`} onClick={start}>Edit</RowAction>}
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
  if (q.isLoading) return <div className="text-sm text-steel">Loading draft jobs…</div>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title="No draft jobs" message="No drafting runs have been enqueued for this case." />;
  // Rows arrive version-desc (newest first). The raw DB version is inflated by the /draft pileup
  // (v81, v57…) and confused Ryan ("v 87? wrong"), so show a sane sequential attempt label:
  // oldest run = "Draft #1" … newest = "Draft #N". attempt = rows.length - index. The raw version
  // stays visible (muted + tooltip) for traceability — View letter still uses jobId, not this.
  const total = rows.length;
  return (
    <TabSection>
      {rows.map((d, i) => {
        const viewable = d.state === 'done' || d.state === 'failed';
        const meta = [
          `enqueued ${formatRelativeTime(d.enqueuedAt)}`,
          d.startedAt ? `started ${formatRelativeTime(d.startedAt)}` : null,
          d.completedAt ? `completed ${formatRelativeTime(d.completedAt)}` : null,
        ].filter(Boolean).join(' · ');
        return (
          <DataRow
            key={d.id}
            {...(viewable ? { onClick: () => viewVersion(d.id) } : {})}
            lead={<><span className="font-medium text-slateInk">Draft #{total - i}</span> <span className="ml-1 text-xs text-steel" title={`Internal letter version ${d.version}`}>v{d.version}</span></>}
            meta={meta}
            trailing={
              <>
                <StatusChip tone={draftStateTone(d.state)}>{d.state}</StatusChip>
                {viewable ? <RowAction onClick={(e) => { e.stopPropagation(); viewVersion(d.id); }}>View letter</RowAction> : null}
              </>
            }
          />
        );
      })}
    </TabSection>
  );
}

// Draft-job state → Aegis chip tone. done = good, failed/cancelled = bad, running = active,
// queued = info, halted = warn, anything else = neutral.
function draftStateTone(state: string): ChipTone {
  switch (state) {
    case 'done': return 'good';
    case 'failed':
    case 'cancelled':
    case 'canceled': return 'bad';
    case 'running': return 'active';
    case 'queued': return 'info';
    case 'halted': return 'warn';
    default: return 'neutral';
  }
}

// Veteran clinical-chart sections, mounted on the case page. Fetches the same veteran detail the
// veteran chart uses (['veteran', veteranId]) and renders the same SC Conditions / Active Problems /
// Medications panels with full add/edit/delete. invalidate() refetches the shared query so an edit
// made here is reflected on the veteran chart and vice-versa.
function VeteranClinicalTab({ veteranId, section }: { readonly veteranId: string; readonly section: 'conditions' | 'problems' | 'medications' }) {
  const qc = useQueryClient();
  const veteran = useQuery({ queryKey: ['veteran', veteranId], queryFn: () => getVeteran(veteranId), enabled: veteranId.length > 0 });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['veteran', veteranId] }); };
  if (veteran.isLoading) return <div className="text-sm text-slate-500">Loading chart…</div>;
  if (!veteran.data) return <EmptyState title="Chart unavailable" message="The veteran's chart could not be loaded." />;
  const v = veteran.data.data;
  if (section === 'conditions') return <ConditionsPanel veteranId={veteranId} rows={v.scConditions} onChange={invalidate} />;
  if (section === 'problems') return <ProblemsPanel veteranId={veteranId} rows={v.activeProblems} onChange={invalidate} />;
  return <MedicationsPanel veteranId={veteranId} rows={v.activeMedications} onChange={invalidate} />;
}

function DocumentsTab({ veteranId, caseId }: { readonly veteranId: string; readonly caseId: string }) {
  const q = useQuery({ queryKey: ['documents', veteranId], queryFn: () => listDocuments(veteranId), enabled: veteranId.length > 0 });
  const [viewDoc, setViewDoc] = useState<ViewableDoc | null>(null);
  const reocr = useMutation({ mutationFn: reocrDocument, onSuccess: () => window.alert('Re-running OCR on this file (Textract → Claude fallback). Refresh in a minute to see it read.') });
  const all = q.data?.data ?? [];
  const docs = all.filter((d) => d.caseId === caseId); // this claim's files
  return (
    <>
      <TabSection
        title="Documents on this claim"
        action={<Link className="text-xs font-medium text-navy transition-colors hover:text-navyDeep" to={`/veterans/${encodeURIComponent(veteranId)}#documents`}>Manage all veteran documents →</Link>}
        {...(q.isLoading || docs.length === 0 ? { bodyClassName: 'p-4' } : {})}
      >
        {q.isLoading ? (
          <div className="text-sm text-steel">Loading documents…</div>
        ) : docs.length === 0 ? (
          <EmptyState title="No documents on this claim" message="Files assigned to this claim (including the auto-generated Intake Summary) appear here. Click any file to view it in-page." />
        ) : (
          docs.map((d) => (
            <DataRow
              key={d.id}
              onClick={() => setViewDoc({ id: d.id, filename: d.filename, contentType: d.contentType })}
              lead={d.filename}
              meta={`${d.docTag ?? 'Other'} · ${formatRelativeTime(d.uploadedAt)}`}
              trailing={
                <RowAction disabled={reocr.isPending} title="Re-run OCR (Textract → Claude fallback) — use if this file shows as unreadable" onClick={(e) => { e.stopPropagation(); reocr.mutate(d.id); }}>Re-run OCR</RowAction>
              }
            />
          ))
        )}
      </TabSection>
      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </>
  );
}
